/**
 * `@absolutejs/runtime` — multi-tenant Bun runtime substrate.
 *
 * Wraps Bun's `spawn` so that "run this tenant's `bun run start` inside
 * a hibernating, metric-emitting child process" is one function call.
 * Built for PaaS providers that want to host many small Bun apps under
 * one host process.
 *
 * Architectural role: SB-6's `@absolutejs/runtime` library. Consumers
 * include the hosted `absolutejs.ai` PaaS (eventual) and anyone else
 * who needs the same shape. Stays decoupled from `@absolutejs/sync`
 * and `@absolutejs/isolated-jsc` — those libraries solve different
 * layers of the same stack.
 *
 * Hibernation strategy (per STRATEGY-CLOUD.md §9.5): idle-kill at the
 * process layer. Bun has no shipped process-level snapshot/resume
 * primitive as of 2026-05-29. When that primitive lands we'll add an
 * opt-in `hibernate: 'process-snapshot'` mode and keep idle-kill as
 * the default.
 *
 * @example
 * ```ts
 * import { createRuntime } from '@absolutejs/runtime';
 *
 * const runtime = createRuntime({
 *   source: { kind: 'directory', root: '/srv/tenants' },
 *   idleAfterMs: 5 * 60 * 1000, // 5 min
 *   maxConcurrent: 100,
 *   onMetrics: (event) => prometheus.observe(event),
 *   onLog: (event) => loki.write(event),
 *   observeIntervalMs: 30_000,
 * });
 *
 * // First call: spawns `bun run start` in /srv/tenants/tenant-42,
 * // injects PORT, waits for readiness, returns the bound port.
 * const tenant = await runtime.ensure('tenant-42');
 * fetch(`http://localhost:${tenant.port}/`);
 *
 * // Subsequent calls reuse the running process.
 * runtime.touch('tenant-42'); // bump idle clock
 *
 * runtime.stats(); // { running, total, draining }
 * await runtime.dispose();
 * ```
 */

import type { Subprocess } from "bun";
import { mkdir, readdir, rm } from "node:fs/promises";
import {
  ABS_ATTRS,
  tracerOrNoop,
  type TracerProvider as TelemetryTracerProvider,
  type Span as TelemetrySpan,
} from "@absolutejs/telemetry";

export type TenantSource = { kind: "directory"; root: string };

/** Identity of a single tenant process at a point in time. */
export type Tenant = {
  /** The key the consumer used to address this tenant. */
  key: string;
  /** The port the child process bound to, discovered after readiness. */
  port: number;
  /** OS process id. */
  pid: number;
  /** Wall-clock when the child was spawned. */
  startedAt: number;
  /** Last time the consumer marked this tenant active. */
  lastTouchedAt: number;
};

export type RuntimeMetricEvent =
  | {
      type: "spawn";
      key: string;
      pid: number;
      port: number;
      durationMs: number;
    }
  | {
      /** Periodic observation emitted by the sweeper (Linux-only; see `observeIntervalMs`). */
      type: "observation";
      key: string;
      pid: number;
      /** Cumulative CPU ms used by the child since spawn, derived from `/proc/<pid>/stat`. */
      cpuMs: number;
      /** Resident set size in bytes, derived from `/proc/<pid>/status` VmRSS. */
      rssBytes: number;
      at: number;
    };

export type RuntimeLogEvent = {
  key: string;
  pid: number;
  stream: "stdout" | "stderr";
  /** A single line of output (newline-terminated lines are split client-side). */
  line: string;
  at: number;
};

/**
 * Why a tenant process ended. Used by `RuntimeTransitionEvent` of type
 * `'exit'` to give the consumer enough info to charge or restart correctly:
 *  - `crashed` — the process exited on its own with a non-zero code
 *  - `exited-clean` — the process exited 0 (probably a graceful self-stop)
 *  - `idle-killed` — the sweeper killed it after `idleAfterMs` with no `touch()`
 *  - `lru-evicted` — `ensure()` for a new tenant evicted this one
 *  - `killed` — explicit `runtime.kill(key)` call
 *  - `readiness-timeout` — readiness check failed; we killed during spawn
 *  - `disposed` — `runtime.dispose()` killed it
 *  - `restarted` — `runtime.restart(key)` killed it on purpose
 *  - `checkpointed` — the idle sweep handed the process to the
 *    configured {@link CheckpointDriver}, which snapshotted and
 *    reaped it. A later `ensure()` may restore it instead of paying
 *    a cold spawn. Added in 0.4.0 (EXPERIMENTAL).
 */
export type ExitReason =
  | "crashed"
  | "exited-clean"
  | "idle-killed"
  | "lru-evicted"
  | "killed"
  | "readiness-timeout"
  | "disposed"
  | "restarted"
  | "checkpointed";

/**
 * EXPERIMENTAL (0.4.0) — process-level checkpoint/restore seam.
 *
 * Bun has no `process.checkpoint()` primitive, so an idle-killed tenant
 * pays a full cold spawn on resume. This interface lets a control plane
 * pilot criu (or any snapshot mechanism) without forking the runtime:
 * configure `createRuntime({ checkpoint: { driver } })` and the idle
 * sweep offers each idle process to the driver before killing it.
 *
 * Driver contract:
 *  - `checkpoint` returning `true` means "the image was written AND the
 *    process is gone" (criu dump's default behavior). Returning `false`
 *    or throwing declines — the runtime falls back to a normal
 *    idle-kill. Only the IDLE path checkpoints; explicit `kill()`,
 *    `dispose()`, and LRU eviction never do.
 *  - `restore` resumes the process for `key` and returns its new pid,
 *    or `null` when there is no usable image — the runtime then calls
 *    `drop(key)` and falls back to a normal spawn.
 *  - After a successful restore the runtime calls `drop(key)`
 *    best-effort: resuming the same image twice would fork the
 *    tenant's state.
 *
 * Restored tenants are tracked as EXTERNAL pids — there is no
 * `Subprocess` handle, so liveness is polled on the sweep interval and
 * kills go through `process.kill(pid)`. `/proc`-based observation
 * events keep working unchanged.
 *
 * criu needs root + kernel support (CONFIG_CHECKPOINT_RESTORE); the
 * `@absolutejs/isolated-jsc` "small tier" (`createHibernatingIsolatePool`)
 * remains the recommended hibernation path today.
 */
export type CheckpointDriver = {
  /**
   * Snapshot the process for `key`. Return `true` when the image was
   * written and the process no longer exists; `false` (or throw) to
   * decline and let the runtime idle-kill normally.
   */
  checkpoint: (ctx: { key: string; pid: number }) => Promise<boolean>;
  /**
   * Resume the process for `key` from its image. Return the restored
   * pid, or `null` when no image exists / restore failed.
   */
  restore: (ctx: { key: string }) => Promise<{ pid: number } | null>;
  /** Discard a stale image for `key`. */
  drop: (key: string) => Promise<void>;
  /** True when an image exists for `key`. */
  has: (key: string) => Promise<boolean>;
};

/** EXPERIMENTAL (0.4.0) — see {@link CheckpointDriver}. */
export type RuntimeCheckpointOptions = {
  driver: CheckpointDriver;
  /**
   * Give up on `driver.restore()` after this many ms and fall back to
   * a normal spawn (after `drop(key)`). The driver should bound its
   * own work too — a timed-out restore is abandoned, not cancelled.
   * Default 10_000. Set to `0` to disable the timeout.
   */
  restoreTimeoutMs?: number;
};

/**
 * Cumulative checkpoint/restore counters surfaced on `stats()` /
 * `metrics()` as the `checkpoints` block. All zeros when no
 * `checkpoint.driver` is configured.
 */
export type CheckpointMetrics = {
  /** Successful `driver.checkpoint()` calls (exit reason `checkpointed`). */
  checkpoints: number;
  /** Successful `driver.restore()` calls (tenant resumed as an external pid). */
  restores: number;
  /** Failed/timed-out/null restores — each fell back to a cold spawn after `drop(key)`. */
  restoreFailures: number;
  /** Duration of the most recent successful restore. */
  lastRestoreMs: number;
};

export type RuntimeTransitionEvent =
  | { type: "spawn"; key: string; pid: number; port: number }
  | {
      type: "ready";
      key: string;
      pid: number;
      port: number;
      durationMs: number;
    }
  | {
      type: "idle-kill";
      key: string;
      pid: number;
      reason: "idle-threshold";
      idleMs: number;
    }
  | { type: "lru-evict"; key: string; pid: number; reason: "max-concurrent" }
  | {
      type: "exit";
      key: string;
      pid: number;
      exitCode: number | null;
      reason: ExitReason;
    }
  | {
      /** A spawn was deferred because the key is in the back-off window after a failure. */
      type: "backoff";
      key: string;
      attempt: number;
      retryAfterMs: number;
    }
  | {
      /**
       * A checkpointed tenant was resumed by the {@link CheckpointDriver}
       * instead of cold-spawned. `pid` is the restored (external) pid;
       * `port` is the port remembered from checkpoint time (`0` if the
       * runtime restarted in between and the mapping was lost). Added
       * in 0.4.0 (EXPERIMENTAL).
       */
      type: "restored";
      key: string;
      pid: number;
      port: number;
      durationMs: number;
    }
  | { type: "drain"; reason: "drain-requested" };

export type ReadinessCheck = (args: {
  key: string;
  port: number;
  /** Wall-clock spawn time so the check can compute its own elapsed. */
  startedAt: number;
}) => Promise<boolean>;

export type SpawnFn = (args: {
  cwd: string;
  env: Record<string, string>;
  onLogLine: (event: RuntimeLogEvent) => void;
  key: string;
}) => Promise<Subprocess>;

export type SpawnBackoff = {
  /** First retry waits this long. Default 1000 ms. */
  baseMs?: number;
  /** Maximum back-off (the cap on the doubled wait). Default 60_000 ms. */
  maxMs?: number;
  /** After this many consecutive failures, `ensure()` throws immediately for this key until reset. Default 10. */
  maxFailures?: number;
};

/** Options for {@link createRuntime}. */
export type RuntimeOptions = {
  /** Where to find tenant project directories. */
  source: TenantSource;
  /**
   * Kill the child process after this many ms with no `touch()` call.
   * Default 5 minutes. Set to `0` to disable idle-kill (only LRU and
   * explicit `kill()` shed processes then).
   */
  idleAfterMs?: number;
  /**
   * Max concurrent tenant processes. When a fresh `ensure()` would
   * push past this, the least-recently-touched process is killed
   * first. Default 100.
   */
  maxConcurrent?: number;
  /**
   * Background sweep interval. Default 10_000 ms. The sweep runs only
   * when the runtime is non-empty and is unrefed so the process can
   * exit cleanly.
   */
  sweepIntervalMs?: number;
  /**
   * How often the sweeper observes CPU + RSS per running tenant. Default
   * 30_000 ms. Set to `0` to disable; observation only works on Linux
   * (`/proc/<pid>` derived) — the sweeper silently skips on other OSes.
   * Output goes to `onMetrics` as `{ type: 'observation', ... }`.
   */
  observeIntervalMs?: number;
  /**
   * Override the readiness check. Default: HTTP GET to
   * `http://127.0.0.1:${port}/` with a 100ms retry loop, give up after
   * 30s with a `Tenant readiness timed out` error.
   */
  readiness?: ReadinessCheck;
  /**
   * Override how a child process is spawned. Default: `Bun.spawn` with
   * `['bun', 'run', 'start']`, stdio piped through `onLogLine`, env
   * carrying `PORT=${allocatedPort}` and `NODE_ENV=production`. Tests
   * use this to inject a fixture without writing to disk.
   */
  spawn?: SpawnFn;
  /** Exponential-backoff policy for consecutive spawn failures. */
  backoff?: SpawnBackoff;
  /** Operational metrics — spawn/ready durations + periodic observations. */
  onMetrics?: (event: RuntimeMetricEvent) => void;
  /** stdout/stderr stream. Bounded internally; backpressure to the host. */
  onLog?: (event: RuntimeLogEvent) => void;
  /** Lifecycle events — spawn/ready/idle-kill/lru-evict/exit/backoff/drain. */
  onTransition?: (event: RuntimeTransitionEvent) => void;
  /**
   * Command to run when spawning. Default `['bun', 'run', 'start']`.
   * Tests use this to point at a fixture script.
   */
  command?: readonly string[];
  /**
   * Optional OpenTelemetry tracer provider. When set, each
   * `ensure()` / `restart()` is wrapped in a `runtime.spawn` span
   * with `abs.tenant`, `abs.runtime.pid`, `abs.runtime.port`,
   * `abs.runtime.readiness_ms`, and (on exit) `abs.runtime.exit_reason`
   * attributes. The span is the ROOT of the customer's trace —
   * everything inside the spawned tenant inherits the active context
   * if it propagates correctly (W3C trace context via env / headers).
   * When omitted, all tracing is a zero-allocation noop. Added in 0.3.0.
   *
   * Pass any `@opentelemetry/api`-compatible `TracerProvider`. See
   * `@absolutejs/telemetry` for the type shape — runtime re-uses its
   * helpers but doesn't peer-dep `@opentelemetry/api` directly.
   */
  tracerProvider?: TelemetryTracerProvider;
  /**
   * EXPERIMENTAL (0.4.0) — process-level checkpoint/restore seam. When
   * set, the idle sweep offers each idle process to the driver before
   * killing it (exit reason `checkpointed` instead of `idle-killed`),
   * and `ensure()` tries `driver.restore()` before a cold spawn when
   * `driver.has(key)` is true. See {@link CheckpointDriver} for the
   * full contract and caveats. The `@absolutejs/isolated-jsc` "small
   * tier" remains the recommended hibernation path today.
   */
  checkpoint?: RuntimeCheckpointOptions;
};

export type RuntimeStats = {
  running: number;
  total: number;
  /** True when the runtime is draining — refusing new ensure() calls. */
  draining: boolean;
  /** Number of keys currently in the back-off window. */
  backoff: number;
  /** Cumulative checkpoint/restore counters. All zeros without a `checkpoint.driver`. Added in 0.4.0. */
  checkpoints: CheckpointMetrics;
};

/**
 * Operator-shaped metrics returned by {@link Runtime.metrics}. Combines
 * the point-in-time {@link RuntimeStats} fields with cumulative counters
 * since `createRuntime()`. Survives `dispose()` so post-shutdown
 * introspection still reads the totals. Added in 0.2.0.
 *
 * - `totalSpawns` — successful `spawn()` calls (failed spawns hit
 *   `recordBackoff` instead and bump `totalBackoffEntries`).
 * - `totalExits` — exits keyed by `ExitReason`. A climbing
 *   `crashed` means a tenant is unhealthy; `idle-killed` is the
 *   expected steady-state for hibernation; `lru-evicted` means the
 *   `maxRunning` cap is biting.
 * - `totalBackoffEntries` — `recordBackoff` calls. Distinct from the
 *   point-in-time `backoff` (current keys in window): a single key
 *   that fails 5 times bumps `totalBackoffEntries` by 5 but only
 *   contributes 1 to `backoff`.
 * - `lastSpawnMs` — wall-clock of the most recent spawn. A climb
 *   here is the operator's "is spawning getting slow" signal.
 */
export type RuntimeMetrics = RuntimeStats & {
  totalSpawns: number;
  totalExits: Record<ExitReason, number>;
  totalBackoffEntries: number;
  lastSpawnMs: number;
};

export type Runtime = {
  /**
   * Resolve `key` to a running tenant. Spawns if not running, waits
   * for readiness, returns the live {@link Tenant} including the bound
   * `port`. Concurrent calls to the same key share a single-flight
   * spawn — N callers don't create N processes.
   *
   * If `key` is in the back-off window after a recent failure, throws
   * immediately (without spawning). Use `clearBackoff(key)` to retry early.
   */
  ensure: (key: string) => Promise<Tenant>;
  /**
   * Mark `key` as active right now. Bumps the idle clock; the next
   * sweep won't consider it for idle-kill until `idleAfterMs` again.
   * Cheap; safe to call before/after each request you route to this
   * tenant.
   */
  touch: (key: string) => void;
  /** Synchronous point-in-time snapshot — back-compat alias of metrics() shape (subset). */
  stats: () => RuntimeStats;
  /**
   * Operator-shaped point-in-time + cumulative metrics (since
   * `createRuntime()`). Use this — `stats()` is kept for back-compat
   * but doesn't carry the cumulative counters. Added in 0.2.0.
   */
  metrics: () => RuntimeMetrics;
  /** Force-kill `key`. No-op if not running. */
  kill: (key: string) => Promise<void>;
  /**
   * Kill `key` and respawn it. Used by deploys to swap to a new release
   * after the `current` symlink has been updated. Concurrent restart
   * calls for the same key share a single-flight respawn.
   */
  restart: (key: string) => Promise<Tenant>;
  /** Forget any consecutive-failure state for `key`. Next `ensure()` retries immediately. */
  clearBackoff: (key: string) => void;
  /**
   * Begin draining: refuse new `ensure()` calls (they throw immediately).
   * In-flight spawns and existing tenants are untouched — wait for
   * `stats().running` to reach 0, or call `dispose()` for hard shutdown.
   * Useful for graceful shard shutdown before a host reboot.
   */
  drain: () => void;
  /** Dispose every running child + stop the sweep. Idempotent. */
  dispose: () => Promise<void>;
};

/* ─── internals ──────────────────────────────────────────────────────── */

type Entry = {
  key: string;
  /** Set while the spawn is in-flight; concurrent ensure() callers await it. */
  pending: Promise<Tenant> | null;
  tenant: Tenant | null;
  child: Subprocess | null;
  /**
   * 0.4.0: pid of a checkpoint-restored tenant. Mutually exclusive with
   * `child` — there's no Subprocess handle, so liveness is polled on
   * the sweep interval and kills go through `process.kill(pid)`.
   */
  externalPid: number | null;
  /** Set by code that's about to kill the child, read by the exit handler. */
  pendingExitReason: ExitReason | null;
};

type BackoffState = {
  attempt: number;
  retryAt: number;
  lastError: string;
};

const defaultReadiness: ReadinessCheck = async ({ port, startedAt }) => {
  const deadline = startedAt + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2_000),
      });
      void res;
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Tenant readiness timed out after 30s");
};

const allocateEphemeralPort = (): number => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data: () => {},
      open: () => {},
    },
  });
  const port = server.port;
  server.stop(true);
  return port;
};

const splitLines = (() => {
  const remainders = new Map<string, string>();
  return (key: string, chunk: string): string[] => {
    const prior = remainders.get(key) ?? "";
    const combined = prior + chunk;
    const parts = combined.split("\n");
    remainders.set(key, parts.pop() ?? "");
    return parts;
  };
})();

const isLinux = typeof process !== "undefined" && process.platform === "linux";

/**
 * Existence probe for external (checkpoint-restored) pids — signal 0
 * delivers nothing but errors if the pid is gone. Cross-platform, and
 * cheaper than reading `/proc/<pid>` every sweep tick.
 */
const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Read CPU + RSS for a pid from `/proc`. Returns `null` if the pid is gone
 * or we're not on Linux. The math: `utime + stime` from `/proc/<pid>/stat`
 * is in clock ticks; we divide by `Bun.clockTicksPerSecond` (or fall back
 * to 100 — the universal default for Linux kernels).
 */
const readProcStats = async (
  pid: number,
): Promise<{ cpuMs: number; rssBytes: number } | null> => {
  if (!isLinux) return null;
  try {
    const statText = await Bun.file(`/proc/${pid}/stat`).text();
    const statusText = await Bun.file(`/proc/${pid}/status`).text();
    // /proc/<pid>/stat: ... (comm) ... and utime/stime are fields 14 and 15
    // counting from 1; but `comm` can contain spaces, so we anchor on the
    // closing paren.
    const closeParen = statText.lastIndexOf(")");
    if (closeParen === -1) return null;
    const after = statText.slice(closeParen + 2).split(" ");
    // After (comm), the fields are: state ppid pgrp session ... utime stime ...
    // utime = field 14 of the whole line = index (14 - 3 - 1) = 10 of `after`.
    const utime = Number(after[11]);
    const stime = Number(after[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    const ticksPerSec =
      (globalThis as { Bun?: { clockTicksPerSecond?: number } }).Bun
        ?.clockTicksPerSecond ?? 100;
    const cpuMs = ((utime + stime) / ticksPerSec) * 1000;
    const match = statusText.match(/^VmRSS:\s+(\d+)\s+kB/m);
    const rssBytes = match && match[1] ? Number(match[1]) * 1024 : 0;
    return { cpuMs, rssBytes };
  } catch {
    return null;
  }
};

const defaultSpawn =
  (command: readonly string[]): SpawnFn =>
  async ({ cwd, env, onLogLine, key }) => {
    const child = Bun.spawn({
      cmd: [...command],
      cwd,
      env,
      stderr: "pipe",
      stdout: "pipe",
    });

    const readStream = (
      stream: ReadableStream<Uint8Array> | undefined | null,
      label: "stdout" | "stderr",
    ): void => {
      if (stream === undefined || stream === null) return;
      void (async () => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        const splitKey = `${child.pid}:${label}`;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            for (const line of splitLines(splitKey, text)) {
              onLogLine({
                at: Date.now(),
                key,
                line,
                pid: child.pid,
                stream: label,
              });
            }
          }
        } catch {
          /* stream errored on child exit; nothing to surface */
        }
      })();
    };
    readStream(
      child.stdout as ReadableStream<Uint8Array> | undefined,
      "stdout",
    );
    readStream(
      child.stderr as ReadableStream<Uint8Array> | undefined,
      "stderr",
    );

    return child;
  };

export const createRuntime = (options: RuntimeOptions): Runtime => {
  const source = options.source;
  const idleAfterMs = options.idleAfterMs ?? 5 * 60 * 1000;
  const maxConcurrent = options.maxConcurrent ?? 100;
  const sweepIntervalMs = options.sweepIntervalMs ?? 10_000;
  const observeIntervalMs = options.observeIntervalMs ?? 30_000;
  const readiness = options.readiness ?? defaultReadiness;
  const command = options.command ?? ["bun", "run", "start"];
  const spawn = options.spawn ?? defaultSpawn(command);
  const onMetrics = options.onMetrics;
  const onLog = options.onLog;
  const onTransition = options.onTransition;
  const backoffOptions: Required<SpawnBackoff> = {
    baseMs: options.backoff?.baseMs ?? 1_000,
    maxFailures: options.backoff?.maxFailures ?? 10,
    maxMs: options.backoff?.maxMs ?? 60_000,
  };
  const checkpointDriver = options.checkpoint?.driver;
  const restoreTimeoutMs = options.checkpoint?.restoreTimeoutMs ?? 10_000;

  const entries = new Map<string, Entry>();
  const backoffs = new Map<string, BackoffState>();
  /** Pending exit reasons keyed by child pid — read by the .then exit handler. */
  const exitReasons = new Map<number, ExitReason>();
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let lastObserveAt = 0;
  let disposed = false;
  let draining = false;
  // 0.3.0: OTel tracer + per-pid open spans. spawnFresh opens a
  // `runtime.spawn` span; the exit handler reads it back to close
  // with abs.runtime.exit_reason. Noop when tracerProvider unset.
  const tracer = tracerOrNoop(options.tracerProvider, "@absolutejs/runtime");
  const openSpawnSpans = new Map<number, TelemetrySpan>();
  // 0.2.0: cumulative operator counters surfaced via metrics(). Survive
  // dispose() so post-shutdown introspection still reads totals.
  let totalSpawns = 0;
  const totalExits: Record<ExitReason, number> = {
    crashed: 0,
    "exited-clean": 0,
    "idle-killed": 0,
    "lru-evicted": 0,
    killed: 0,
    "readiness-timeout": 0,
    disposed: 0,
    restarted: 0,
    checkpointed: 0,
  };
  let totalBackoffEntries = 0;
  let lastSpawnMs = 0;
  // 0.4.0: checkpoint/restore seam. Ports are remembered at checkpoint
  // time so a restored tenant reports the port its process re-binds
  // (a criu restore resumes the original socket). Best-effort — the
  // mapping is in-memory only, so a runtime restart loses it (port 0).
  const checkpointedPorts = new Map<string, number>();
  let totalCheckpoints = 0;
  let totalRestores = 0;
  let totalRestoreFailures = 0;
  let lastRestoreMs = 0;

  const emitMetric = (event: RuntimeMetricEvent): void => {
    if (onMetrics === undefined) return;
    try {
      onMetrics(event);
    } catch {
      /* observational only */
    }
  };
  const emitTransition = (event: RuntimeTransitionEvent): void => {
    if (onTransition === undefined) return;
    try {
      onTransition(event);
    } catch {
      /* observational only */
    }
  };
  const emitLog = (event: RuntimeLogEvent): void => {
    if (onLog === undefined) return;
    try {
      onLog(event);
    } catch {
      /* observational only */
    }
  };

  const tenantCwd = (key: string): string => {
    if (source.kind === "directory") {
      return `${source.root}/${key}`;
    }
    throw new Error(
      `Unsupported tenant source kind: ${(source as { kind: string }).kind}`,
    );
  };

  const killChildWithReason = async (
    entry: Entry,
    reason: ExitReason,
  ): Promise<void> => {
    const child = entry.child;
    if (child !== null) {
      entry.pendingExitReason = reason;
      exitReasons.set(child.pid, reason);
      try {
        child.kill();
      } catch {
        /* already dead */
      }
      try {
        await child.exited;
      } catch {
        /* ignore */
      }
      return;
    }
    // 0.4.0: restored (external-pid) tenants have no Subprocess handle,
    // so there's no `.exited` to hook — kill via the OS and emit the
    // exit ourselves.
    if (entry.externalPid !== null) {
      const pid = entry.externalPid;
      entry.externalPid = null;
      try {
        process.kill(pid);
      } catch {
        /* already dead */
      }
      totalExits[reason] += 1;
      emitTransition({
        exitCode: null,
        key: entry.key,
        pid,
        reason,
        type: "exit",
      });
    }
  };

  const removeEntry = async (
    key: string,
    entry: Entry,
    reason: ExitReason,
  ): Promise<void> => {
    entries.delete(key);
    await killChildWithReason(entry, reason);
  };

  const recordBackoff = (key: string, error: unknown): void => {
    const prev = backoffs.get(key);
    const attempt = (prev?.attempt ?? 0) + 1;
    const wait = Math.min(
      backoffOptions.maxMs,
      backoffOptions.baseMs * 2 ** (attempt - 1),
    );
    const message = error instanceof Error ? error.message : String(error);
    backoffs.set(key, {
      attempt,
      lastError: message,
      retryAt: Date.now() + wait,
    });
    totalBackoffEntries += 1;
  };

  /** Best-effort discard of a checkpoint image + its remembered port. */
  const dropImage = (key: string): void => {
    if (checkpointDriver === undefined) return;
    checkpointedPorts.delete(key);
    try {
      void checkpointDriver.drop(key).catch(() => {});
    } catch {
      /* best-effort */
    }
  };

  const observeRunning = async (): Promise<void> => {
    if (!isLinux || observeIntervalMs <= 0 || onMetrics === undefined) return;
    const now = Date.now();
    if (now - lastObserveAt < observeIntervalMs) return;
    lastObserveAt = now;
    for (const [key, entry] of entries) {
      if (entry.tenant === null) continue;
      const stats = await readProcStats(entry.tenant.pid);
      if (stats === null) continue;
      emitMetric({
        at: now,
        cpuMs: stats.cpuMs,
        key,
        pid: entry.tenant.pid,
        rssBytes: stats.rssBytes,
        type: "observation",
      });
    }
  };

  /**
   * 0.4.0: idle path with a checkpoint driver. Mirrors `removeEntry`'s
   * shape (entry leaves the map synchronously, teardown continues
   * async). The exit reason is stashed BEFORE the driver runs — a
   * criu-style dump reaps the process itself, so the exit handler must
   * already see `checkpointed` when `.exited` resolves. On decline
   * (false/throw) the stash is undone and the normal idle-kill runs.
   */
  const checkpointOrIdleKill = async (
    key: string,
    entry: Entry,
    idleMs: number,
  ): Promise<void> => {
    const tenant = entry.tenant;
    if (tenant === null || checkpointDriver === undefined) return;
    entries.delete(key);
    entry.pendingExitReason = "checkpointed";
    exitReasons.set(tenant.pid, "checkpointed");
    let taken = false;
    try {
      taken = await checkpointDriver.checkpoint({ key, pid: tenant.pid });
    } catch {
      taken = false;
    }
    if (taken) {
      totalCheckpoints += 1;
      checkpointedPorts.set(key, tenant.port);
      // External-pid tenants have no exit handler — emit the exit here.
      if (entry.externalPid !== null) {
        const pid = entry.externalPid;
        entry.externalPid = null;
        totalExits.checkpointed += 1;
        emitTransition({
          exitCode: null,
          key,
          pid,
          reason: "checkpointed",
          type: "exit",
        });
      }
      return;
    }
    exitReasons.delete(tenant.pid);
    entry.pendingExitReason = null;
    emitTransition({
      idleMs,
      key,
      pid: tenant.pid,
      reason: "idle-threshold",
      type: "idle-kill",
    });
    await killChildWithReason(entry, "idle-killed");
  };

  const startSweepIfNeeded = (): void => {
    if (sweepTimer !== undefined || disposed) return;
    sweepTimer = setInterval(() => {
      if (disposed) return;
      const now = Date.now();
      for (const [key, entry] of entries) {
        if (entry.tenant === null) continue;
        // 0.4.0: restored (external-pid) tenants have no `.exited` hook,
        // so liveness is polled here. A vanished pid classifies as
        // `crashed` — we can't observe the real exit code.
        if (entry.externalPid !== null && !isPidAlive(entry.externalPid)) {
          const pid = entry.externalPid;
          entry.externalPid = null;
          entries.delete(key);
          totalExits.crashed += 1;
          emitTransition({
            exitCode: null,
            key,
            pid,
            reason: "crashed",
            type: "exit",
          });
          continue;
        }
        if (idleAfterMs <= 0) continue;
        const idleMs = now - entry.tenant.lastTouchedAt;
        if (idleMs >= idleAfterMs) {
          if (checkpointDriver !== undefined) {
            void checkpointOrIdleKill(key, entry, idleMs).catch(() => {});
            continue;
          }
          emitTransition({
            idleMs,
            key,
            pid: entry.tenant.pid,
            reason: "idle-threshold",
            type: "idle-kill",
          });
          void removeEntry(key, entry, "idle-killed").catch(() => {});
        }
      }
      void observeRunning().catch(() => {});
      if (entries.size === 0 && sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
    }, sweepIntervalMs);
    if (typeof sweepTimer === "object" && sweepTimer !== null) {
      (sweepTimer as { unref?: () => void }).unref?.();
    }
  };

  const evictLruIfNeeded = (): void => {
    if (entries.size < maxConcurrent) return;
    let oldestKey: string | undefined;
    let oldestEntry: Entry | undefined;
    for (const [key, entry] of entries) {
      if (entry.tenant === null) continue;
      if (
        oldestEntry === undefined ||
        oldestEntry.tenant === null ||
        entry.tenant.lastTouchedAt < oldestEntry.tenant.lastTouchedAt
      ) {
        oldestKey = key;
        oldestEntry = entry;
      }
    }
    if (
      oldestKey !== undefined &&
      oldestEntry !== undefined &&
      oldestEntry.tenant !== null
    ) {
      emitTransition({
        key: oldestKey,
        pid: oldestEntry.tenant.pid,
        reason: "max-concurrent",
        type: "lru-evict",
      });
      void removeEntry(oldestKey, oldestEntry, "lru-evicted").catch(() => {});
    }
  };

  const spawnFresh = async (key: string): Promise<Tenant> => {
    if (disposed) throw new Error("runtime has been disposed");
    if (draining) throw new Error("runtime is draining; ensure() refused");
    evictLruIfNeeded();

    const port = allocateEphemeralPort();
    const startedAt = Date.now();
    const cwd = tenantCwd(key);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      NODE_ENV: "production",
      PORT: String(port),
    };

    let child: Subprocess;
    const spawnStart = Date.now();
    try {
      child = await spawn({
        cwd,
        env,
        key,
        onLogLine: emitLog,
      });
    } catch (error) {
      entries.delete(key);
      recordBackoff(key, error);
      throw error;
    }

    totalSpawns += 1;
    lastSpawnMs = Date.now() - spawnStart;

    // 0.3.0: open the per-tenant span. Lifetime = from spawn-success
    // through process exit (closed by the exit handler below). The
    // span is the ROOT of the customer's trace for this tenant
    // session — sync mutations / queue jobs / etc. nest under it if
    // OTel context propagates correctly across the process boundary.
    const spawnSpan = tracer.startSpan("runtime.spawn", {
      attributes: {
        [ABS_ATTRS.runtimeKey]: key,
        [ABS_ATTRS.runtimePid]: child.pid,
        [ABS_ATTRS.runtimePort]: port,
        [ABS_ATTRS.runtimeReadinessMs]: lastSpawnMs,
      },
    });
    openSpawnSpans.set(child.pid, spawnSpan);

    emitTransition({ key, pid: child.pid, port, type: "spawn" });

    // Reap the entry when the process exits. We capture the entry's
    // `pendingExitReason` if some code path set one; otherwise classify
    // by exit code.
    void child.exited
      .then((exitCode) => {
        const stashed = exitReasons.get(child.pid);
        const reason: ExitReason =
          stashed ?? (exitCode === 0 ? "exited-clean" : "crashed");
        exitReasons.delete(child.pid);
        totalExits[reason] += 1;
        // 0.3.0: close the tenant's spawn span on exit. Status maps
        // the reason: exited-clean / idle-killed / lru-evicted /
        // disposed / restarted are OK (planned); crashed /
        // readiness-timeout / killed are ERROR.
        const exitSpan = openSpawnSpans.get(child.pid);
        if (exitSpan !== undefined) {
          openSpawnSpans.delete(child.pid);
          exitSpan.setAttribute(ABS_ATTRS.runtimeExitReason, reason);
          if (exitCode !== null && exitCode !== undefined) {
            exitSpan.setAttribute("abs.runtime.exit_code", exitCode);
          }
          const ok =
            reason === "exited-clean" ||
            reason === "idle-killed" ||
            reason === "lru-evicted" ||
            reason === "disposed" ||
            reason === "restarted" ||
            reason === "checkpointed";
          exitSpan.setStatus({ code: ok ? 1 /* OK */ : 2 /* ERROR */ });
          exitSpan.end();
        }
        emitTransition({
          exitCode: exitCode ?? null,
          key,
          pid: child.pid,
          reason,
          type: "exit",
        });
        const current = entries.get(key);
        if (current !== undefined && current.child === child) {
          entries.delete(key);
        }
      })
      .catch(() => {});

    try {
      await readiness({ key, port, startedAt });
    } catch (error) {
      const entry = entries.get(key);
      if (entry !== undefined) {
        entry.pendingExitReason = "readiness-timeout";
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      entries.delete(key);
      recordBackoff(key, error);
      throw error;
    }

    const tenant: Tenant = {
      key,
      lastTouchedAt: Date.now(),
      pid: child.pid,
      port,
      startedAt,
    };
    const entry = entries.get(key);
    if (entry !== undefined) {
      entry.tenant = tenant;
      entry.child = child;
      entry.pending = null;
    }
    backoffs.delete(key);
    const durationMs = Date.now() - startedAt;
    emitMetric({
      durationMs,
      key,
      pid: child.pid,
      port,
      type: "spawn",
    });
    emitTransition({
      durationMs,
      key,
      pid: child.pid,
      port,
      type: "ready",
    });
    startSweepIfNeeded();
    return tenant;
  };

  /**
   * 0.4.0: try to resume `key` from a checkpoint image. Returns the
   * restored tenant, or `null` to fall back to `spawnFresh` (no image,
   * driver returned null, threw, or timed out — the image is dropped
   * on failure so the next `ensure()` doesn't retry a broken one).
   */
  const restoreFromCheckpoint = async (key: string): Promise<Tenant | null> => {
    if (checkpointDriver === undefined) return null;
    try {
      if (!(await checkpointDriver.has(key))) return null;
    } catch {
      return null;
    }
    const startedAt = Date.now();
    try {
      let restored: { pid: number } | null;
      if (restoreTimeoutMs > 0) {
        restored = await Promise.race([
          checkpointDriver.restore({ key }),
          new Promise<null>((resolve) => {
            const timer = setTimeout(() => resolve(null), restoreTimeoutMs);
            if (typeof timer === "object" && timer !== null) {
              (timer as { unref?: () => void }).unref?.();
            }
          }),
        ]);
      } else {
        restored = await checkpointDriver.restore({ key });
      }
      if (restored === null) {
        throw new Error("restore returned null or timed out");
      }
      const pid = restored.pid;
      const port = checkpointedPorts.get(key) ?? 0;
      const tenant: Tenant = {
        key,
        lastTouchedAt: Date.now(),
        pid,
        port,
        startedAt,
      };
      const entry = entries.get(key);
      if (entry !== undefined) {
        entry.tenant = tenant;
        entry.child = null;
        entry.externalPid = pid;
        entry.pending = null;
      }
      totalRestores += 1;
      lastRestoreMs = Date.now() - startedAt;
      // The image has been consumed — resuming it twice would fork the
      // tenant's state. Best-effort discard (also clears the port map).
      dropImage(key);
      backoffs.delete(key);
      emitTransition({
        durationMs: lastRestoreMs,
        key,
        pid,
        port,
        type: "restored",
      });
      startSweepIfNeeded();
      return tenant;
    } catch {
      totalRestoreFailures += 1;
      dropImage(key);
      return null;
    }
  };

  /** ensure()'s spawn path: restore from a checkpoint image when possible, cold-spawn otherwise. */
  const spawnOrRestore = async (key: string): Promise<Tenant> => {
    if (disposed) throw new Error("runtime has been disposed");
    if (draining) throw new Error("runtime is draining; ensure() refused");
    if (checkpointDriver !== undefined) {
      const restored = await restoreFromCheckpoint(key);
      if (restored !== null) return restored;
    }
    return spawnFresh(key);
  };

  const checkBackoff = (key: string): void => {
    const state = backoffs.get(key);
    if (state === undefined) return;
    if (state.attempt >= backoffOptions.maxFailures) {
      throw new Error(
        `Tenant "${key}" exceeded ${backoffOptions.maxFailures} consecutive spawn failures; clearBackoff() to retry. Last error: ${state.lastError}`,
      );
    }
    const remaining = state.retryAt - Date.now();
    if (remaining > 0) {
      emitTransition({
        attempt: state.attempt,
        key,
        retryAfterMs: remaining,
        type: "backoff",
      });
      throw new Error(
        `Tenant "${key}" is backing off after ${state.attempt} failure(s); retry in ${remaining}ms. Last error: ${state.lastError}`,
      );
    }
  };

  return {
    async ensure(key) {
      if (disposed) throw new Error("runtime has been disposed");
      const existing = entries.get(key);
      if (existing !== undefined) {
        if (existing.tenant !== null) {
          existing.tenant.lastTouchedAt = Date.now();
          return existing.tenant;
        }
        if (existing.pending !== null) {
          return existing.pending;
        }
      }
      // From here we'd spawn a fresh process — drain only refuses NEW spawns.
      if (draining) throw new Error("runtime is draining; ensure() refused");
      checkBackoff(key);
      const fresh: Entry = {
        child: null,
        externalPid: null,
        key,
        pending: null,
        pendingExitReason: null,
        tenant: null,
      };
      const promise = spawnOrRestore(key);
      fresh.pending = promise;
      entries.set(key, fresh);
      return promise;
    },

    touch(key) {
      const entry = entries.get(key);
      if (entry === undefined || entry.tenant === null) return;
      entry.tenant.lastTouchedAt = Date.now();
    },

    stats() {
      let running = 0;
      for (const entry of entries.values()) {
        if (entry.tenant !== null) running += 1;
      }
      return {
        backoff: backoffs.size,
        checkpoints: {
          checkpoints: totalCheckpoints,
          lastRestoreMs,
          restoreFailures: totalRestoreFailures,
          restores: totalRestores,
        },
        draining,
        running,
        total: entries.size,
      };
    },

    metrics() {
      let running = 0;
      for (const entry of entries.values()) {
        if (entry.tenant !== null) running += 1;
      }
      return {
        backoff: backoffs.size,
        checkpoints: {
          checkpoints: totalCheckpoints,
          lastRestoreMs,
          restoreFailures: totalRestoreFailures,
          restores: totalRestores,
        },
        draining,
        lastSpawnMs,
        running,
        total: entries.size,
        totalBackoffEntries,
        totalExits: { ...totalExits },
        totalSpawns,
      };
    },

    async kill(key) {
      const entry = entries.get(key);
      if (entry === undefined) return;
      await removeEntry(key, entry, "killed");
    },

    async restart(key) {
      if (disposed) throw new Error("runtime has been disposed");
      const entry = entries.get(key);
      if (entry !== undefined) {
        await removeEntry(key, entry, "restarted");
      }
      // 0.4.0: a restart means new code — any hibernated image is stale.
      dropImage(key);
      // Same single-flight contract as ensure().
      const fresh: Entry = {
        child: null,
        externalPid: null,
        key,
        pending: null,
        pendingExitReason: null,
        tenant: null,
      };
      const promise = spawnFresh(key);
      fresh.pending = promise;
      entries.set(key, fresh);
      return promise;
    },

    clearBackoff(key) {
      backoffs.delete(key);
    },

    drain() {
      if (draining) return;
      draining = true;
      emitTransition({ reason: "drain-requested", type: "drain" });
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      const snapshot = [...entries.entries()];
      entries.clear();
      await Promise.all(
        snapshot.map(([_key, entry]) => killChildWithReason(entry, "disposed")),
      );
    },
  };
};

/* ─── execCheckpointDriver (0.4.0, EXPERIMENTAL) ─────────────────────── */

/** Options for {@link execCheckpointDriver}. */
export type ExecCheckpointDriverOptions = {
  /**
   * Argv that snapshots a process. The placeholders `{key}`, `{pid}`,
   * and `{dir}` are substituted per-argument (no shell involved). Exit
   * code 0 means "image written AND process gone" (criu dump's default);
   * anything else declines and the runtime idle-kills normally. e.g.
   * `['criu', 'dump', '--tree', '{pid}', '--images-dir', '{dir}', '--shell-job']`.
   */
  checkpointCommand: readonly string[];
  /**
   * Argv that restores a process from `{dir}`. Must print a line
   * `RESTORED_PID=<n>` on stdout (e.g. a wrapper around
   * `criu restore --images-dir {dir} --restore-detached --pidfile ...`
   * that cats the pidfile). Non-zero exit or a missing line counts as
   * a failed restore — the runtime drops the image and cold-spawns.
   */
  restoreCommand: readonly string[];
  /** Root directory for images. Each key gets `${imageDir}/${key}`. */
  imageDir: string;
};

/**
 * EXPERIMENTAL (0.4.0) — reference {@link CheckpointDriver} that shells
 * out to criu-shaped checkpoint/restore commands. Substitutes `{key}`,
 * `{pid}`, and `{dir}` placeholders per-argument and parses the restored
 * pid from a `RESTORED_PID=<n>` stdout line.
 *
 * criu needs root (or CAP_CHECKPOINT_RESTORE) + a kernel built with
 * CONFIG_CHECKPOINT_RESTORE, and restoring processes with open sockets
 * has real sharp edges. This driver exists so the control plane can
 * PILOT process-level hibernation without forking the runtime — the
 * `@absolutejs/isolated-jsc` "small tier" remains the recommended
 * hibernation path today.
 */
export const execCheckpointDriver = (
  options: ExecCheckpointDriverOptions,
): CheckpointDriver => {
  const substitute = (
    template: readonly string[],
    vars: Record<string, string>,
  ): string[] =>
    template.map((arg) =>
      arg.replace(
        /\{(key|pid|dir)\}/g,
        (_match, name: string) => vars[name] ?? "",
      ),
    );
  const keyDir = (key: string): string => {
    if (key.includes("/") || key.includes("\\") || key.includes("..")) {
      throw new Error(`execCheckpointDriver: unsafe key "${key}"`);
    }
    return `${options.imageDir}/${key}`;
  };

  return {
    async checkpoint({ key, pid }) {
      const dir = keyDir(key);
      await mkdir(dir, { recursive: true });
      const proc = Bun.spawn({
        cmd: substitute(options.checkpointCommand, {
          dir,
          key,
          pid: String(pid),
        }),
        stderr: "ignore",
        stdout: "ignore",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        // Don't leave a partial image behind — has() must stay false.
        try {
          await rm(dir, { force: true, recursive: true });
        } catch {
          /* best-effort */
        }
        return false;
      }
      return true;
    },

    async restore({ key }) {
      const dir = keyDir(key);
      const proc = Bun.spawn({
        cmd: substitute(options.restoreCommand, { dir, key, pid: "" }),
        stderr: "ignore",
        stdout: "pipe",
      });
      const [stdout, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) return null;
      const match = stdout.match(/^RESTORED_PID=(\d+)$/m);
      if (match === null || match[1] === undefined) return null;
      return { pid: Number(match[1]) };
    },

    async drop(key) {
      await rm(keyDir(key), { force: true, recursive: true });
    },

    async has(key) {
      try {
        const names = await readdir(keyDir(key));
        return names.length > 0;
      } catch {
        return false;
      }
    },
  };
};

/* ─── createEgressGuard (0.4.0) ──────────────────────────────────────── */

/** Why {@link createEgressGuard} denied a request. */
export type EgressDenyReason =
  | "not-allowed"
  | "requests-budget"
  | "bytes-budget";

/** Payload handed to {@link EgressGuardOptions.onDeny}. */
export type EgressDenyInfo = {
  tenant: string;
  url: URL;
  reason: EgressDenyReason;
};

/** Per-tenant rolling-window budgets for {@link createEgressGuard}. */
export type EgressBudgets = {
  /** Max requests STARTED per tenant per rolling window. */
  requests?: number;
  /**
   * Max response bytes per tenant per rolling window. Declared
   * `Content-Length` is counted immediately; otherwise streamed/chunked
   * response bytes are counted as the caller consumes the body.
   */
  bytes?: number;
  /** Rolling window length. Timestamps are pruned on each check. */
  windowMs: number;
};

/** A `fetch`-compatible function (the subset the guard wraps + returns). */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Options for {@link createEgressGuard}. */
export type EgressGuardOptions = {
  /**
   * Per-request allow hook. Default: deny private/loopback/link-local/
   * metadata address space (10/8, 172.16/12, 192.168/16, 127/8,
   * 169.254/16, 0.0.0.0, `::`, `::1`, `fc00::/7`, `fe80::/10`,
   * IPv4-mapped IPv6 equivalents) and the bare hostnames `localhost` /
   * `*.localhost` / `*.internal`; allow everything else. NOTE: the
   * default check is hostname-based — it does NOT resolve DNS, so a
   * public name pointing at a private address (DNS rebinding) passes.
   * Harden with a resolving `allow` hook if that's in your threat model.
   */
  allow?: (tenant: string, url: URL) => boolean;
  /** Per-tenant rolling-window budgets. No budgets → allowlist-only guard. */
  budgets?: EgressBudgets;
  /** Observational deny hook — fires before the {@link EgressDeniedError} throws. */
  onDeny?: (info: EgressDenyInfo) => void;
  /** Underlying fetch. Default `globalThis.fetch`. Tests inject a fake. */
  fetchImpl?: FetchLike;
  /** Clock override for tests. Default `Date.now`. */
  now?: () => number;
  /**
   * Optional OpenTelemetry tracer provider — same pattern as
   * {@link RuntimeOptions.tracerProvider}. Each guarded call becomes a
   * `runtime.egress_fetch` span with `abs.tenant`, `abs.egress.host`,
   * `abs.egress.allowed`, and (on deny) `abs.egress.deny_reason`.
   */
  tracerProvider?: TelemetryTracerProvider;
};

/** Cumulative counters returned by {@link EgressGuard.metrics}. */
export type EgressGuardMetrics = {
  /** Tenants with tracked window state. */
  tenants: number;
  /** Requests that passed the guard and were handed to `fetchImpl`. */
  requests: number;
  /** Denied requests keyed by reason. */
  denied: Record<EgressDenyReason, number>;
  /** Cumulative response bytes counted (Content-Length-derived). */
  bytesEgress: number;
};

export type EgressGuard = {
  /**
   * A `fetch`-compatible function bound to `tenant`. Hand this to the
   * tenant's outbound path (sync's `bridgeFetch` host side, an
   * `unsafeHost` fn, an SDK's fetch override). Throws
   * {@link EgressDeniedError} on deny.
   */
  fetchFor: (tenant: string) => FetchLike;
  metrics: () => EgressGuardMetrics;
  /** Re-open budgets: clear window state for `tenant`, or every tenant when omitted. Cumulative counters are kept. */
  reset: (tenant?: string) => void;
};

/**
 * Thrown by a guarded fetch on deny. `reason` is the machine-readable
 * dimension; `tenant` + `url` say who tried to reach what.
 */
export class EgressDeniedError extends Error {
  readonly reason: EgressDenyReason;
  readonly tenant: string;
  readonly url: string;

  constructor(info: EgressDenyInfo) {
    super(
      `egress denied for tenant "${info.tenant}" → ${info.url.href}: ${info.reason}`,
    );
    this.name = "EgressDeniedError";
    this.reason = info.reason;
    this.tenant = info.tenant;
    this.url = info.url.href;
  }
}

const isPrivateIpv4 = (hostname: string): boolean => {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const [a = -1, b = -1, c = -1, d = -1] = parts.map(Number);
  if (a > 255 || b > 255 || c > 255 || d > 255) return false;
  if (a === 10) return true; // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local + cloud metadata
  if (a === 0) return true; // 0.0.0.0 + "this network"
  return false;
};

const isPrivateIpv6 = (ip: string): boolean => {
  if (ip === "::" || ip === "::1") return true; // unspecified + loopback
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded IPv4. WHATWG URL
  // canonicalizes the tail to hex hextets (`::ffff:a00:1`), so handle
  // both the dotted and hex forms.
  const mapped = ip.match(/^::ffff:([0-9a-f.:]+)$/);
  if (mapped !== null && mapped[1] !== undefined) {
    const tail = mapped[1];
    if (tail.includes(".")) return isPrivateIpv4(tail);
    const hextets = tail.split(":");
    if (hextets.length <= 2) {
      const high = Number.parseInt(
        hextets.length === 2 ? (hextets[0] ?? "0") : "0",
        16,
      );
      const low = Number.parseInt(hextets[hextets.length - 1] ?? "0", 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isPrivateIpv4(
          `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
        );
      }
    }
    return false;
  }
  if (/^f[cd]/.test(ip)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
  return false;
};

/**
 * The default-deny surface: private/loopback/link-local/metadata address
 * space + localhost-shaped hostnames. WHATWG URL lowercases hostnames
 * and canonicalizes IPv6 (compressed, bracketed) — we strip the brackets
 * before matching.
 */
const isPrivateHostname = (rawHostname: string): boolean => {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "") return true; // no host (file:, data:) — never egress
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }
  if (hostname.includes(":")) return isPrivateIpv6(hostname);
  return isPrivateIpv4(hostname);
};

const defaultEgressAllow = (_tenant: string, url: URL): boolean =>
  !isPrivateHostname(url.hostname);

const meterStreamingResponse = (
  response: Response,
  recordBytes: (bytes: number) => void,
): Response => {
  if (response.body === null) return response;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        recordBytes(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
  );
  const metered = new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  // A reconstructed Response otherwise loses fetch metadata that callers may
  // inspect even though its status, headers, and body are preserved.
  Object.defineProperties(metered, {
    redirected: { configurable: true, value: response.redirected },
    type: { configurable: true, value: response.type },
    url: { configurable: true, value: response.url },
  });
  return metered;
};

type TenantEgressState = {
  /** Start timestamps of requests in the current window. */
  requestStamps: number[];
  /** Response byte counts (Content-Length-derived) in the current window. */
  byteStamps: Array<{ at: number; bytes: number }>;
};

/**
 * Host-side guarded-fetch factory — outbound network policy per tenant
 * (PaaS guide gap 5.7). One runaway tenant can DoS outbound bandwidth
 * or poison a shared third-party rate limit; the host hands each tenant
 * `guard.fetchFor(tenant)` instead of the raw `fetch` and gets an
 * SSRF-shaped default allowlist + per-tenant rolling-window budgets.
 *
 * @example Pairing with `@absolutejs/sync`'s sandboxed handlers
 * ```ts
 * const guard = createEgressGuard({
 *   budgets: { requests: 100, bytes: 25 * 1024 * 1024, windowMs: 60_000 },
 *   onDeny: (info) => audit.append({ kind: 'egress.denied', ...info }),
 * });
 *
 * // sync's unsafeHost escape hatch — the sandboxed mutation calls
 * // unsafeHost.fetchJson(...); the host routes it through the guard.
 * const guardedFetch = guard.fetchFor(tenantKey);
 * defineMutation({
 *   name: 'enrich:lookup',
 *   sandboxedHandler: `async (args, ctx, actions, unsafeHost) =>
 *     unsafeHost.fetchJson(args.url)`,
 *   sandbox: {
 *     unsafeHost: {
 *       fetchJson: async (url: string) => (await guardedFetch(url)).json(),
 *     },
 *   },
 * });
 * ```
 */
export const createEgressGuard = (
  options: EgressGuardOptions = {},
): EgressGuard => {
  const allow = options.allow ?? defaultEgressAllow;
  const budgets = options.budgets;
  const onDeny = options.onDeny;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const now = options.now ?? Date.now;
  const tracer = tracerOrNoop(options.tracerProvider, "@absolutejs/runtime");

  const states = new Map<string, TenantEgressState>();
  let totalRequests = 0;
  let totalBytes = 0;
  const denied: Record<EgressDenyReason, number> = {
    "not-allowed": 0,
    "requests-budget": 0,
    "bytes-budget": 0,
  };

  const stateFor = (tenant: string): TenantEgressState => {
    const existing = states.get(tenant);
    if (existing !== undefined) return existing;
    const fresh: TenantEgressState = { byteStamps: [], requestStamps: [] };
    states.set(tenant, fresh);
    return fresh;
  };

  const pruneWindow = (state: TenantEgressState, at: number): void => {
    if (budgets === undefined) return;
    const cutoff = at - budgets.windowMs;
    while (
      state.requestStamps.length > 0 &&
      (state.requestStamps[0] ?? 0) <= cutoff
    ) {
      state.requestStamps.shift();
    }
    while (
      state.byteStamps.length > 0 &&
      (state.byteStamps[0]?.at ?? 0) <= cutoff
    ) {
      state.byteStamps.shift();
    }
  };

  const denyRequest = (
    tenant: string,
    url: URL,
    reason: EgressDenyReason,
  ): never => {
    denied[reason] += 1;
    if (onDeny !== undefined) {
      try {
        onDeny({ reason, tenant, url });
      } catch {
        /* observational only */
      }
    }
    throw new EgressDeniedError({ reason, tenant, url });
  };

  return {
    fetchFor(tenant) {
      return async (input, init) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(input instanceof URL ? input.href : String(input));
        const span = tracer.startSpan("runtime.egress_fetch", {
          attributes: {
            [ABS_ATTRS.tenant]: tenant,
            "abs.egress.host": url.hostname,
          },
        });
        try {
          const state = stateFor(tenant);
          const at = now();
          pruneWindow(state, at);
          if (!allow(tenant, url)) {
            denyRequest(tenant, url, "not-allowed");
          }
          if (
            budgets?.requests !== undefined &&
            state.requestStamps.length >= budgets.requests
          ) {
            denyRequest(tenant, url, "requests-budget");
          }
          if (budgets?.bytes !== undefined) {
            let bytesInWindow = 0;
            for (const stamp of state.byteStamps) bytesInWindow += stamp.bytes;
            if (bytesInWindow >= budgets.bytes) {
              denyRequest(tenant, url, "bytes-budget");
            }
          }
          state.requestStamps.push(at);
          totalRequests += 1;
          const response = await fetchImpl(input, init);
          const contentLength = Number(
            response.headers.get("content-length") ?? "0",
          );
          const bytes =
            Number.isFinite(contentLength) && contentLength > 0
              ? contentLength
              : 0;
          const recordBytes = (observedBytes: number): void => {
            if (observedBytes <= 0) return;
            state.byteStamps.push({ at, bytes: observedBytes });
            totalBytes += observedBytes;
          };
          if (bytes > 0) {
            recordBytes(bytes);
          }
          span.setAttribute("abs.egress.allowed", true);
          span.setStatus({ code: 1 /* OK */ });
          return bytes > 0
            ? response
            : meterStreamingResponse(response, recordBytes);
        } catch (error) {
          if (error instanceof EgressDeniedError) {
            span.setAttribute("abs.egress.allowed", false);
            span.setAttribute("abs.egress.deny_reason", error.reason);
          }
          span.setStatus({ code: 2 /* ERROR */ });
          throw error;
        } finally {
          span.end();
        }
      };
    },

    metrics() {
      return {
        bytesEgress: totalBytes,
        denied: { ...denied },
        requests: totalRequests,
        tenants: states.size,
      };
    },

    reset(tenant) {
      if (tenant === undefined) {
        states.clear();
        return;
      }
      states.delete(tenant);
    },
  };
};
