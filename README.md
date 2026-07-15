# @absolutejs/runtime

Multi-tenant Bun runtime substrate. Wraps `Bun.spawn` so that "run this tenant's `bun run start` inside an idle-killing, metric-emitting child process" is one function call.

Built for PaaS providers and platform layers that want to host many small Bun apps under one host process. The library SB-6 surfaces between `@absolutejs/isolated-jsc` + `@absolutejs/sync` and the hosted product downstream.

```ts
import { createRuntime } from "@absolutejs/runtime";

const runtime = createRuntime({
  source: { kind: "directory", root: "/srv/tenants" },
  idleAfterMs: 5 * 60 * 1000,
  maxConcurrent: 100,
  onMetrics: (event) => prometheus.observe(event),
  onLog: (event) => loki.write(event),
});

// First call: spawns `bun run start` in /srv/tenants/tenant-42,
// injects PORT, waits for readiness, returns the bound port.
const tenant = await runtime.ensure("tenant-42");
await fetch(`http://127.0.0.1:${tenant.port}/`);

// Subsequent calls reuse the running process.
runtime.touch("tenant-42"); // bump idle clock

runtime.stats(); // { running, total }
await runtime.dispose();
```

## Surface (0.1.0)

| API                         | Purpose                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createRuntime(options)`    | Factory. Returns a `Runtime`.                                                                                                                                            |
| `runtime.ensure(key)`       | Spawn-or-reuse. Single-flight on concurrent calls to the same key. Throws fast if `key` is in a back-off window. Returns `{ key, port, pid, startedAt, lastTouchedAt }`. |
| `runtime.touch(key)`        | Bump the idle clock for an active tenant. Cheap; call before/after each request.                                                                                         |
| `runtime.stats()`           | `{ running, total, draining, backoff }` snapshot.                                                                                                                        |
| `runtime.kill(key)`         | Force-kill. No-op if not running.                                                                                                                                        |
| `runtime.restart(key)`      | Kill + spawn fresh in one call. For deploys that swap to a new release.                                                                                                  |
| `runtime.clearBackoff(key)` | Forget consecutive-failure state.                                                                                                                                        |
| `runtime.drain()`           | Refuse new `ensure()` spawns; existing tenants keep running. For graceful shard shutdown.                                                                                |
| `runtime.dispose()`         | Kill all + stop the sweeper. Idempotent.                                                                                                                                 |

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

`spawn` returns the minimal `RuntimeProcess` contract (`pid`, `exited`, and a
sync-or-async `kill`). Bun's `Subprocess` satisfies it directly. Container
adapters can return the host pid plus `resourceId` (for example, a Docker
container id) and `port` when the adapter must bind inside a fixed firewall
range. The reported port becomes the readiness and tenant port while retaining
the same idle-kill, LRU, restart, drain, metrics, and backoff behavior.

Use `runtime.adopt(key, process)` during boot reconciliation when a managed
process survived a control-plane restart. For externally routed traffic,
`shouldIdleKill` can perform a final activity check before eviction instead of
requiring every request to pass through `runtime.touch()`.

### Checkpoint/restore seam (0.4.0) — ⚠️ EXPERIMENTAL

Bun has no `process.checkpoint()`, so the first request after an idle-kill pays a full cold spawn. The `checkpoint` option is a **seam**: the control plane can pilot [criu](https://criu.org) (or any snapshot mechanism) without forking the runtime.

```ts
import { createRuntime, execCheckpointDriver } from "@absolutejs/runtime";

const runtime = createRuntime({
  source: { kind: "directory", root: "/srv/tenants" },
  checkpoint: {
    driver: execCheckpointDriver({
      checkpointCommand: [
        "criu",
        "dump",
        "--tree",
        "{pid}",
        "--images-dir",
        "{dir}",
        "--shell-job",
        "--tcp-established",
      ],
      restoreCommand: ["restore-and-print-pid.sh", "{dir}"], // must print RESTORED_PID=<n>
      imageDir: "/var/lib/tenants/images",
    }),
    restoreTimeoutMs: 10_000,
  },
});
```

Behavior:

- **Only the idle path checkpoints.** When the sweeper finds an idle tenant and a driver is configured, it calls `driver.checkpoint({ key, pid })` first. `true` means "image written AND process gone" (criu dump's default) — the exit is recorded with the new reason `checkpointed` instead of `idle-killed`. `false`/throw declines, and the normal idle-kill proceeds. Explicit `kill()`, `dispose()`, and LRU eviction never checkpoint.
- **`ensure()` restores when it can.** If `driver.has(key)` is true, `driver.restore({ key })` runs before any cold spawn. On success the tenant is tracked as an **external pid** — no `Subprocess` handle, liveness polled on the sweep interval, kills via `process.kill(pid)`, `/proc`-based observation events unchanged — and a `{ type: 'restored', key, pid, port, durationMs }` transition fires. On `null`/throw/timeout the runtime calls `driver.drop(key)` and cold-spawns.
- After a successful restore the image is dropped (best-effort) — resuming the same image twice would fork the tenant's state. `restart(key)` also drops any image (a restart means new code).
- The tenant's `port` on restore is remembered from checkpoint time (a criu restore resumes the original socket). The mapping is in-memory — if the host process restarted in between, the restored tenant reports `port: 0`.
- `stats()`/`metrics()` gain a `checkpoints` block: `{ checkpoints, restores, restoreFailures, lastRestoreMs }` cumulative counters.

**Why experimental**: criu needs root (or `CAP_CHECKPOINT_RESTORE`) + a kernel with `CONFIG_CHECKPOINT_RESTORE`, and restoring processes with open TCP sockets has real sharp edges. The `@absolutejs/isolated-jsc` "small tier" (`createHibernatingIsolatePool`) remains the recommended hibernation path today. This surface exists so process-level hibernation can be piloted per-shard behind a flag — expect the driver contract to evolve.

### Egress guard (0.4.0)

One runaway tenant can DoS outbound bandwidth or poison a shared third-party rate limit. `createEgressGuard` is a host-side guarded-`fetch` factory: hand each tenant `guard.fetchFor(tenant)` instead of the raw `fetch`.

```ts
import { createEgressGuard, EgressDeniedError } from "@absolutejs/runtime";

const guard = createEgressGuard({
  budgets: { requests: 100, bytes: 25 * 1024 * 1024, windowMs: 60_000 },
  onDeny: (info) =>
    audit.append({
      kind: "egress.denied",
      tenant: info.tenant,
      url: info.url.href,
      reason: info.reason,
    }),
});

const guardedFetch = guard.fetchFor("tenant-42");
await guardedFetch("https://api.stripe.com/v1/charges"); // ok
await guardedFetch("http://169.254.169.254/latest/meta-data/"); // throws EgressDeniedError { reason: 'not-allowed' }

guard.metrics(); // { tenants, requests, denied: { 'not-allowed', 'requests-budget', 'bytes-budget' }, bytesEgress }
guard.reset("tenant-42"); // re-open the tenant's budget window
```

Pairing with `@absolutejs/sync`'s sandboxed handlers — route the sandbox's outbound escape hatch through the guard so every tenant mutation shares one policy:

```ts
const guardedFetch = guard.fetchFor(tenantKey);

defineMutation({
  name: "enrich:lookup",
  sandboxedHandler: `async (args, ctx, actions, unsafeHost) =>
    unsafeHost.fetchJson(args.url)`,
  sandbox: {
    unsafeHost: {
      fetchJson: async (url: string) => (await guardedFetch(url)).json(),
    },
  },
});
```

(The same shape works for `bridgeFetch`-style host-side fetches: wherever the host performs network I/O on a tenant's behalf, use the tenant's guarded fetch.)

Details:

- **Default allowlist** denies private/loopback/link-local/metadata address space — `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`, `0.0.0.0`, `::`, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6 equivalents — plus the bare hostnames `localhost`, `*.localhost`, `*.internal`. Everything else is allowed. Override with `allow: (tenant, url) => boolean` (it replaces the default entirely). **Caveat**: the default check is hostname-based and does not resolve DNS — a public name pointing at a private address (DNS rebinding) passes; use a resolving `allow` hook if that's in your threat model.
- **Budgets** are per-tenant rolling windows (timestamps pruned on each check). Requests count on start; a request that would push past `requests`, or that starts while window bytes already ≥ `bytes`, throws `EgressDeniedError` with `reason: 'requests-budget'` / `'bytes-budget'`.
- **Byte accounting covers declared and streamed responses.** A valid
  `Content-Length` is counted immediately. Without it, the returned body is
  wrapped in a zero-buffer transform and chunks are counted as the caller
  consumes them. The bytes budget applies to the next request once the rolling
  total reaches its cap; it does not truncate a response already in flight.
- `tracerProvider` (same pattern as `createRuntime`) wraps each call in a `runtime.egress_fetch` span with `abs.tenant`, `abs.egress.host`, `abs.egress.allowed`, and `abs.egress.deny_reason` attributes.

## Architectural role

- **`@absolutejs/isolated-jsc`** — heap-isolated _JS contexts_. One library down: the unit the runtime hibernates is a child process, not a JSC context.
- **`@absolutejs/sync`** — reactive engine. Independent of the runtime; consumed inside tenant processes when the tenant uses it.
- **`@absolutejs/runtime`** — _this library_. The process-pool layer.
- **`@absolutejs/metering`** (planned) — consumes the runtime's metrics + handlerMetrics from sync into a cost-attribution → billing-events pipeline.
- **`@absolutejs/router`** (planned) — multi-tenant routing in front of one or more runtime instances.

## License

BSL 1.1 with a named carveout for the hosted multi-tenant Bun runtime / PaaS substrate category (Convex, Liveblocks, Vercel, Render, Fly, Cloudflare Workers). See [LICENSE](./LICENSE). Change Date: 4 years from first release; Change License: Apache 2.0.
