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

export type TenantSource =
  | { kind: "directory"; root: string };

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
 */
export type ExitReason =
  | "crashed"
  | "exited-clean"
  | "idle-killed"
  | "lru-evicted"
  | "killed"
  | "readiness-timeout"
  | "disposed"
  | "restarted";

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
};

export type RuntimeStats = {
  running: number;
  total: number;
  /** True when the runtime is draining — refusing new ensure() calls. */
  draining: boolean;
  /** Number of keys currently in the back-off window. */
  backoff: number;
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
  /** Synchronous snapshot. */
  stats: () => RuntimeStats;
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
 * Read CPU + RSS for a pid from `/proc`. Returns `null` if the pid is gone
 * or we're not on Linux. The math: `utime + stime` from `/proc/<pid>/stat`
 * is in clock ticks; we divide by `Bun.clockTicksPerSecond` (or fall back
 * to 100 — the universal default for Linux kernels).
 */
const readProcStats = async (pid: number): Promise<{ cpuMs: number; rssBytes: number } | null> => {
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
    const ticksPerSec = (globalThis as { Bun?: { clockTicksPerSecond?: number } }).Bun?.clockTicksPerSecond ?? 100;
    const cpuMs = ((utime + stime) / ticksPerSec) * 1000;
    const match = statusText.match(/^VmRSS:\s+(\d+)\s+kB/m);
    const rssBytes = match && match[1] ? Number(match[1]) * 1024 : 0;
    return { cpuMs, rssBytes };
  } catch {
    return null;
  }
};

const defaultSpawn = (command: readonly string[]): SpawnFn => async ({
  cwd,
  env,
  onLogLine,
  key,
}) => {
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
  readStream(child.stdout as ReadableStream<Uint8Array> | undefined, "stdout");
  readStream(child.stderr as ReadableStream<Uint8Array> | undefined, "stderr");

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

  const entries = new Map<string, Entry>();
  const backoffs = new Map<string, BackoffState>();
  /** Pending exit reasons keyed by child pid — read by the .then exit handler. */
  const exitReasons = new Map<number, ExitReason>();
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let lastObserveAt = 0;
  let disposed = false;
  let draining = false;

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

  const killChildWithReason = async (entry: Entry, reason: ExitReason): Promise<void> => {
    const child = entry.child;
    if (child === null) return;
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
  };

  const removeEntry = async (key: string, entry: Entry, reason: ExitReason): Promise<void> => {
    entries.delete(key);
    await killChildWithReason(entry, reason);
  };

  const recordBackoff = (key: string, error: unknown): void => {
    const prev = backoffs.get(key);
    const attempt = (prev?.attempt ?? 0) + 1;
    const wait = Math.min(backoffOptions.maxMs, backoffOptions.baseMs * 2 ** (attempt - 1));
    const message = error instanceof Error ? error.message : String(error);
    backoffs.set(key, { attempt, lastError: message, retryAt: Date.now() + wait });
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

  const startSweepIfNeeded = (): void => {
    if (sweepTimer !== undefined || disposed) return;
    sweepTimer = setInterval(() => {
      if (disposed) return;
      const now = Date.now();
      for (const [key, entry] of entries) {
        if (entry.tenant === null) continue;
        if (idleAfterMs <= 0) continue;
        const idleMs = now - entry.tenant.lastTouchedAt;
        if (idleMs >= idleAfterMs) {
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
    if (oldestKey !== undefined && oldestEntry !== undefined && oldestEntry.tenant !== null) {
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
      return { backoff: backoffs.size, draining, running, total: entries.size };
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
      // Same single-flight contract as ensure().
      const fresh: Entry = {
        child: null,
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
      await Promise.all(snapshot.map(([_key, entry]) => killChildWithReason(entry, "disposed")));
    },
  };
};
