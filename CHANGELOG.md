# Changelog

All notable changes to `@absolutejs/runtime` are documented here.

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
