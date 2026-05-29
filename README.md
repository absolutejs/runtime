# @absolutejs/runtime

Multi-tenant Bun runtime substrate. Wraps `Bun.spawn` so that "run this tenant's `bun run start` inside an idle-killing, metric-emitting child process" is one function call.

Built for PaaS providers and platform layers that want to host many small Bun apps under one host process. The library SB-6 surfaces between `@absolutejs/isolated-jsc` + `@absolutejs/sync` and the hosted product downstream.

```ts
import { createRuntime } from '@absolutejs/runtime';

const runtime = createRuntime({
  source: { kind: 'directory', root: '/srv/tenants' },
  idleAfterMs: 5 * 60 * 1000,
  maxConcurrent: 100,
  onMetrics: (event) => prometheus.observe(event),
  onLog: (event) => loki.write(event),
});

// First call: spawns `bun run start` in /srv/tenants/tenant-42,
// injects PORT, waits for readiness, returns the bound port.
const tenant = await runtime.ensure('tenant-42');
await fetch(`http://127.0.0.1:${tenant.port}/`);

// Subsequent calls reuse the running process.
runtime.touch('tenant-42'); // bump idle clock

runtime.stats(); // { running, total }
await runtime.dispose();
```

## Surface (0.1.0)

| API | Purpose |
|---|---|
| `createRuntime(options)` | Factory. Returns a `Runtime`. |
| `runtime.ensure(key)` | Spawn-or-reuse. Single-flight on concurrent calls to the same key. Throws fast if `key` is in a back-off window. Returns `{ key, port, pid, startedAt, lastTouchedAt }`. |
| `runtime.touch(key)` | Bump the idle clock for an active tenant. Cheap; call before/after each request. |
| `runtime.stats()` | `{ running, total, draining, backoff }` snapshot. |
| `runtime.kill(key)` | Force-kill. No-op if not running. |
| `runtime.restart(key)` | Kill + spawn fresh in one call. For deploys that swap to a new release. |
| `runtime.clearBackoff(key)` | Forget consecutive-failure state. |
| `runtime.drain()` | Refuse new `ensure()` spawns; existing tenants keep running. For graceful shard shutdown. |
| `runtime.dispose()` | Kill all + stop the sweeper. Idempotent. |

### Back-off on spawn failures

A spawn that fails (spawn fn threw, or readiness timed out) records a per-key `{ attempt, retryAt, lastError }` and the next `ensure(key)` throws fast until `retryAt`. After `maxFailures` (default 10) consecutive failures, the key stays refused until `clearBackoff(key)`. Defaults: `baseMs=1000`, `maxMs=60_000`, `maxFailures=10`. Override via the `backoff` option. Without this, one broken tenant thrashes the host with rapid spawn retries.

### Observation (Linux-only)

When `observeIntervalMs > 0` (default `30_000`), the sweeper periodically reads `/proc/<pid>/stat` (utime + stime) and `/proc/<pid>/status` (VmRSS) per running tenant and emits `{ type: 'observation', key, pid, cpuMs, rssBytes, at }` via `onMetrics`. This is the per-tenant data `@absolutejs/metering` consumes to attribute idle hibernation cost. Silently skips on non-Linux.

### Hibernation strategy

**Idle-kill at the process layer**, plus the JSC-context hibernation any tenant gets for free via `@absolutejs/isolated-jsc`'s `createHibernatingIsolatePool`. Bun has no process-level snapshot/resume primitive shipped or tracked in an open issue as of 2026-05-29; when one lands we'll add an opt-in `hibernate: 'process-snapshot'` mode and keep idle-kill as the default.

The trade-off the default makes explicit: first call after idle pays a full Bun cold spawn (~50–200ms). That's worth it for the free-tier multi-tenant economics; if the wake latency matters for your workload, set `idleAfterMs: 0` and rely on `maxConcurrent`'s LRU eviction instead.

### Observability hooks

`onLog`, `onMetrics`, and `onTransition` are pluggable. `onLog` receives newline-split stdout/stderr from every child; `onMetrics` fires on spawn (`{ type: 'spawn', durationMs }`) and periodically with observations on Linux (`{ type: 'observation', cpuMs, rssBytes }`); `onTransition` fires on every state change: `spawn`, `ready`, `idle-kill`, `lru-evict`, `exit` (with a structured `reason`), `backoff`, `drain`.

### Exit reasons

The `exit` transition's `reason` field is one of: `crashed`, `exited-clean`, `idle-killed`, `lru-evicted`, `killed`, `readiness-timeout`, `disposed`, `restarted`. The meter / control plane uses this to decide whether to charge, retry, or alert.

### Pluggable spawn + readiness

`spawn` and `readiness` are overrides on `createRuntime`. The default `spawn` runs `['bun', 'run', 'start']` with `PORT` injected; the default `readiness` polls `http://127.0.0.1:${port}/` every 100ms with a 30s deadline. Tests use the spawn override to bypass disk; production use is mostly the defaults.

## Architectural role

- **`@absolutejs/isolated-jsc`** — heap-isolated *JS contexts*. One library down: the unit the runtime hibernates is a child process, not a JSC context.
- **`@absolutejs/sync`** — reactive engine. Independent of the runtime; consumed inside tenant processes when the tenant uses it.
- **`@absolutejs/runtime`** — *this library*. The process-pool layer.
- **`@absolutejs/metering`** (planned) — consumes the runtime's metrics + handlerMetrics from sync into a cost-attribution → billing-events pipeline.
- **`@absolutejs/router`** (planned) — multi-tenant routing in front of one or more runtime instances.

## License

BSL 1.1 with a named carveout for the hosted multi-tenant Bun runtime / PaaS substrate category (Convex, Liveblocks, Vercel, Render, Fly, Cloudflare Workers). See [LICENSE](./LICENSE). Change Date: 4 years from first release; Change License: Apache 2.0.
