# Changelog

All notable changes to `@absolutejs/runtime` are documented here.

## 0.3.0 — 2026-05-30

### Added — OpenTelemetry tracing via @absolutejs/telemetry

Closes G2 from the deep-research audit for the runtime — the root of
the customer trace. Each tenant spawn becomes a long-running span
that bookends the tenant process's lifetime (from `ensure()` /
`restart()` through process exit), so customer SREs investigating a
crash can follow the trace from the failing tenant's `runtime.spawn`
span down into any sync mutations / queue jobs / secret resolves the
tenant performed before going down.

- **`RuntimeOptions.tracerProvider?: TracerProvider`** — any
  `@opentelemetry/api`-compatible `TracerProvider`. Structural type
  via `@absolutejs/telemetry` (no peer-dep on `@opentelemetry/api`).
- **`runtime.spawn` span** opens on spawn success with
  `abs.runtime.key` / `abs.runtime.pid` / `abs.runtime.port` /
  `abs.runtime.readiness_ms` attributes. Closes on process exit with
  `abs.runtime.exit_reason` (from the structured `ExitReason` union)
  + `abs.runtime.exit_code` set.
- **Status mapping**: `exited-clean` / `idle-killed` / `lru-evicted` /
  `disposed` / `restarted` map to OK (planned exits). `crashed` /
  `readiness-timeout` / `killed` map to ERROR.
- `@absolutejs/telemetry` added as a regular dep (250 LOC, zero
  transitive deps).
- Zero-cost when `tracerProvider` absent — singleton noop tracer.

4 new tests in `tests/tracing.test.ts`: span attributes on spawn,
status + exit_reason on `kill()`, two-tenant distinctness, noop
fallback.

Test count: 29 → 33.

## 0.2.0 — 2026-05-29

Substrate-pattern uniformity. Backwards-compatible — `stats()` keeps
its 0.1.0 shape; `metrics()` is the new operator-shaped surface.

### Added

- **`Runtime.metrics()`** returning `RuntimeMetrics` — the point-in-time
  `RuntimeStats` fields plus cumulative counters:
  - `totalSpawns` — successful `spawn()` calls since `createRuntime()`.
  - `totalExits` — `Record<ExitReason, number>` since start. A climbing
    `crashed` means a tenant is unhealthy; `idle-killed` is the steady
    state for hibernation; `lru-evicted` means the `maxRunning` cap is
    biting.
  - `totalBackoffEntries` — cumulative `recordBackoff` calls. Distinct
    from the point-in-time `backoff` (current keys in window): a key
    that fails 5× bumps `totalBackoffEntries` by 5 but contributes 1
    to `backoff`.
  - `lastSpawnMs` — wall-clock of the most recent spawn. A climb means
    spawning is slowing down (cold disk, contention, network mounts).
- Survives `dispose()` so post-shutdown introspection still reads totals.

`stats()` kept unchanged for back-compat — it returns a subset of
`metrics()`. New code should use `metrics()`.

8 new tests in `tests/metrics.test.ts`. Test count: 21 → 29.

## 0.1.0 - 2026-05-29

Substrate-deepening pass for the PaaS. Backwards-compatible with 0.0.1 —
the new surface is purely additive plus richer event payloads.

### Added

- **Exponential backoff on consecutive spawn failures.** A spawn that
  fails (the spawn fn threw, or readiness timed out) records a per-key
  `{ attempt, retryAt, lastError }` and the next `ensure(key)` throws
  fast until `retryAt`. After `maxFailures` (default 10), the key stays
  refused until `clearBackoff(key)`. Default policy: `baseMs=1_000`,
  `maxMs=60_000`, `maxFailures=10`. Override via `backoff: { baseMs?,
  maxMs?, maxFailures? }`.
- **`restart(key)`** — kill + spawn fresh in one call. Used by deploys
  that need to swap to a new release after the `current` symlink moves.
  Single-flight contract matches `ensure`.
- **`clearBackoff(key)`** — forget per-key failure state.
- **`drain()`** — refuse new `ensure()` spawns while letting in-flight
  spawns and existing tenants keep running. For graceful shard shutdown
  before a host reboot. `stats().draining` reports the state.
- **CPU + RSS observation in the sweeper** (Linux-only). When
  `observeIntervalMs > 0` (default 30_000), the sweeper reads
  `/proc/<pid>/stat` (utime + stime) and `/proc/<pid>/status` (VmRSS)
  per running tenant and emits a new metric event:
  `{ type: 'observation', key, pid, cpuMs, rssBytes, at }`. Silently
  skips on non-Linux. This is the per-tenant data
  `@absolutejs/metering` needs to attribute idle hibernation cost
  precisely.

### Changed (non-breaking)

- **`exit` transition now carries a structured `reason`** of:
  `crashed`, `exited-clean`, `idle-killed`, `lru-evicted`, `killed`,
  `readiness-timeout`, `disposed`, `restarted`. The previous
  `{ type: 'exit', key, pid, exitCode }` shape adds `reason` as a
  required field. Consumers reading the event need to widen their
  type; the field placement is purely additive on the wire.
- **`stats()` now returns `{ running, total, draining, backoff }`** —
  added `draining: boolean` and `backoff: number` for the count of keys
  currently in the back-off window.

### New event type

- `{ type: 'backoff', key, attempt, retryAfterMs }` — emitted when an
  `ensure()` call is refused early because the key is in its back-off
  window.
- `{ type: 'drain', reason: 'drain-requested' }` — emitted once when
  `drain()` is first called.

## 0.0.1 - 2026-05-29

### Added

- **`createRuntime`** — multi-tenant Bun process pool. `ensure(key)`
  spawn-or-reuse, `touch(key)` idle defer, `kill(key)` force-kill,
  `stats()` snapshot, `dispose()` cleanup. Single-flight spawn on
  concurrent `ensure` to the same key. LRU eviction when
  `maxConcurrent` would be exceeded; idle-kill sweep after
  `idleAfterMs`. Pluggable `spawn`, `readiness`, `onMetrics`, `onLog`,
  `onTransition` hooks. Default spawn runs `bun run start` with `PORT`
  injected; default readiness polls `http://127.0.0.1:${port}/` with
  a 30s deadline.
- SB-6 substrate library (per `STRATEGY-CLOUD.md` §9.3). v0.0.1
  hibernation strategy is idle-kill at the process layer — Bun has no
  shipped process-snapshot primitive as of 2026-05-29, so we
  consciously defer that path. JSC-context hibernation comes for free
  via `@absolutejs/isolated-jsc@0.9.0`'s
  `createHibernatingIsolatePool` if the tenant runs sandboxed
  handlers internally.

### Exports

- `createRuntime`, types `Runtime`, `RuntimeOptions`, `RuntimeStats`,
  `Tenant`, `TenantSource`, `RuntimeMetricEvent`, `RuntimeLogEvent`,
  `RuntimeTransitionEvent`, `ReadinessCheck`, `SpawnFn`.
