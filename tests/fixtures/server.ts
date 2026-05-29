/**
 * Test fixture — a tiny Bun child process that:
 *  - reads PORT from env
 *  - binds Bun.serve on that port
 *  - logs a line to stdout on each request
 *  - exposes `/health` (returns 200 "ok") and `/sleep?ms=N` (delays then 200)
 *
 * Used by tests/runtime.test.ts. Each test spawns this fixture via the
 * runtime's `spawn` hook (or directly through the default `bun run
 * start` path if the runtime points at a directory containing this).
 */

const port = Number(process.env.PORT ?? "0");
if (!Number.isFinite(port) || port <= 0) {
  console.error("fixture: invalid PORT", process.env.PORT);
  process.exit(1);
}

console.log(`fixture: starting on port ${port}`);

Bun.serve({
  fetch: async (request) => {
    const url = new URL(request.url);
    console.log(`fixture: ${request.method} ${url.pathname}`);
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    if (url.pathname === "/sleep") {
      const ms = Number(url.searchParams.get("ms") ?? "100");
      await new Promise((resolve) => setTimeout(resolve, ms));
      return new Response(`slept ${ms}ms`);
    }
    return new Response(`fixture: ${url.pathname}`);
  },
  hostname: "127.0.0.1",
  port,
});
