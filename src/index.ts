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
 * v0.0.1 hibernation strategy (per the design doc, STRATEGY-CLOUD.md
 * §9.5): idle-kill at the process layer. Bun has no shipped
 * process-level snapshot/resume primitive as of 2026-05-29, and no
 * open issue tracking one. When that primitive lands we'll add an
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
 * runtime.stats(); // { running, total }
 * await runtime.dispose();
 * ```
 */

import type { Subprocess } from "bun";

export type TenantSource =
  | { kind: "directory"; root: string }
  // Future: { kind: 's3'; bucket: string; prefix: string };
  // Future: { kind: 'git'; remote: string };
  ;

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

export type RuntimeMetricEvent = {
  type: "spawn";
  key: string;
  pid: number;
  port: number;
  durationMs: number;
};
// Future: cpu / memory observation events emitted by the sweeper.

export type RuntimeLogEvent = {
  key: string;
  pid: number;
  stream: "stdout" | "stderr";
  /** A single line of output (newline-terminated lines are split client-side). */
  line: string;
  at: number;
};

export type RuntimeTransitionEvent =
  | { type: "spawn"; key: string; pid: number; port: number }
  | { type: "ready"; key: string; pid: number; port: number; durationMs: number }
  | {
      type: "idle-kill";
      key: string;
      pid: number;
      reason: "idle-threshold";
      idleMs: number;
    }
  | { type: "lru-evict"; key: string; pid: number; reason: "max-concurrent" }
  | { type: "exit"; key: string; pid: number; exitCode: number | null };

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
   * Override the readiness check. Default: HTTP GET to
   * `http://localhost:${port}/` with a 100ms retry loop, give up after
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
  /** Operational metrics — spawn/ready durations etc. */
  onMetrics?: (event: RuntimeMetricEvent) => void;
  /** stdout/stderr stream. Bounded internally; backpressure to the host. */
  onLog?: (event: RuntimeLogEvent) => void;
  /** Lifecycle events — spawn/ready/idle-kill/lru-evict/exit. */
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
};

export type Runtime = {
  /**
   * Resolve `key` to a running tenant. Spawns if not running, waits
   * for readiness, returns the live {@link Tenant} including the bound
   * `port`. Concurrent calls to the same key share a single-flight
   * spawn — N callers don't create N processes.
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
};

const defaultReadiness: ReadinessCheck = async ({ port, startedAt }) => {
  const deadline = startedAt + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2_000),
      });
      // Any response — even 404 — means the server bound the port.
      void res;
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Tenant readiness timed out after 30s");
};

/**
 * Ask the OS for a currently-free TCP port by binding 0 + closing.
 * Race window: another process can grab the port between close and
 * the child's bind. Acceptable for v0.0.1; production deployments
 * should use a coordinated port allocator (or have the child bind 0
 * and report back via stdout, which is a v0.0.2 follow-up).
 */
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
  // Per-stream remainder, keyed by child pid + stream label.
  const remainders = new Map<string, string>();
  return (key: string, chunk: string): string[] => {
    const prior = remainders.get(key) ?? "";
    const combined = prior + chunk;
    const parts = combined.split("\n");
    remainders.set(key, parts.pop() ?? "");
    return parts;
  };
})();

const defaultSpawn: SpawnFn = async ({
  cwd,
  env,
  onLogLine,
  key,
}) => {
  const child = Bun.spawn({
    cmd: ["bun", "run", "start"],
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });

  // Stream stdout/stderr into onLogLine as newline-terminated lines.
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
        // stream errored on child exit; nothing to surface
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
  const readiness = options.readiness ?? defaultReadiness;
  const spawn = options.spawn ?? defaultSpawn;
  const onMetrics = options.onMetrics;
  const onLog = options.onLog;
  const onTransition = options.onTransition;

  const entries = new Map<string, Entry>();
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

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

  const killChild = async (entry: Entry): Promise<void> => {
    const child = entry.child;
    if (child === null) return;
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

  const removeEntry = async (key: string, entry: Entry): Promise<void> => {
    entries.delete(key);
    await killChild(entry);
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
          void removeEntry(key, entry).catch(() => {});
        }
      }
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
      if (entry.tenant === null) continue; // mid-spawn; don't evict
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
      void removeEntry(oldestKey, oldestEntry).catch(() => {});
    }
  };

  const spawnFresh = async (key: string): Promise<Tenant> => {
    if (disposed) throw new Error("runtime has been disposed");
    evictLruIfNeeded();

    const port = allocateEphemeralPort();
    const startedAt = Date.now();
    const cwd = tenantCwd(key);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      NODE_ENV: "production",
      PORT: String(port),
    };

    const child = await spawn({
      cwd,
      env,
      key,
      onLogLine: emitLog,
    });

    emitTransition({ key, pid: child.pid, port, type: "spawn" });

    // Reap the entry when the process exits — whether we killed it or
    // it died on its own. Single source of truth for "is this tenant
    // running": the entry's `tenant` field.
    void child.exited
      .then((exitCode) => {
        emitTransition({
          exitCode: exitCode ?? null,
          key,
          pid: child.pid,
          type: "exit",
        });
        // Only delete if THIS entry is still the live one. A consumer
        // who killed + immediately re-ensured may have replaced it.
        const current = entries.get(key);
        if (current !== undefined && current.child === child) {
          entries.delete(key);
        }
      })
      .catch(() => {});

    try {
      await readiness({ key, port, startedAt });
    } catch (error) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      entries.delete(key);
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
      const fresh: Entry = {
        child: null,
        key,
        pending: null,
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
      return { running, total: entries.size };
    },

    async kill(key) {
      const entry = entries.get(key);
      if (entry === undefined) return;
      await removeEntry(key, entry);
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      const snapshot = [...entries.values()];
      entries.clear();
      await Promise.all(snapshot.map((entry) => killChild(entry)));
    },
  };
};
