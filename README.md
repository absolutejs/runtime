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

## v0.0.1 surface

| API | Purpose |
|---|---|
| `createRuntime(options)` | Factory. Returns a `Runtime`. |
| `runtime.ensure(key)` | Spawn-or-reuse. Single-flight on concurrent calls to the same key. Returns `{ key, port, pid, startedAt, lastTouchedAt }`. |
| `runtime.touch(key)` | Bump the idle clock for an active tenant. Cheap; call before/after each request. |
| `runtime.stats()` | `{ running, total }` snapshot. |
| `runtime.kill(key)` | Force-kill. No-op if not running. |
| `runtime.dispose()` | Kill all + stop the sweeper. Idempotent. |

### Hibernation strategy (v0.0.1)

**Idle-kill at the process layer**, plus the JSC-context hibernation any tenant gets for free via `@absolutejs/isolated-jsc`'s `createHibernatingIsolatePool`. Bun has no process-level snapshot/resume primitive shipped or tracked in an open issue as of 2026-05-29; when one lands we'll add an opt-in `hibernate: 'process-snapshot'` mode and keep idle-kill as the default.

The trade-off the default makes explicit: first call after idle pays a full Bun cold spawn (~50–200ms). That's worth it for the free-tier multi-tenant economics; if the wake latency matters for your workload, set `idleAfterMs: 0` and rely on `maxConcurrent`'s LRU eviction instead.

### Observability hooks

`onLog`, `onMetrics`, and `onTransition` are pluggable. `onLog` receives newline-split stdout/stderr from every child; `onMetrics` fires on spawn with `durationMs`; `onTransition` fires on every state change (`spawn` / `ready` / `idle-kill` / `lru-evict` / `exit`).

### Pluggable spawn + readiness

`spawn` and `readiness` are overrides on `createRuntime`. The default `spawn` runs `['bun', 'run', 'start']` with `PORT` injected; the default `readiness` polls `http://127.0.0.1:${port}/` every 100ms with a 30s deadline. Tests use the spawn override to bypass disk; production use is mostly the defaults.

## Architectural role

- **`@absolutejs/isolated-jsc`** — heap-isolated *JS contexts*. One library down: the unit the runtime hibernates is a child process, not a JSC context.
- **`@absolutejs/sync`** — reactive engine. Independent of the runtime; consumed inside tenant processes when the tenant uses it.
- **`@absolutejs/runtime`** — *this library*. The process-pool layer.
- **`@absolutejs/metering`** (planned) — consumes the runtime's metrics + handlerMetrics from sync into a cost-attribution → billing-events pipeline.
- **`@absolutejs/router`** (planned) — multi-tenant routing in front of one or more runtime instances.

## License

CC BY-NC 4.0 — same as the rest of the AbsoluteJS ecosystem.
