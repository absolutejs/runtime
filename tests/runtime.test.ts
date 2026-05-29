/**
 * v0.0.1 contract tests for `createRuntime`. We point the runtime at
 * a tests/fixtures directory whose `tenant-*` subdirectories each
 * contain a thin `package.json` + a copy of `../../server.ts` as the
 * `start` script. The runtime spawns them, waits for readiness,
 * exposes the bound port, and we drive requests through the port.
 *
 * Each test is independent — runtimes are disposed in afterEach so a
 * test that crashes a fixture doesn't leak children into the next.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRuntime,
  type Runtime,
  type RuntimeLogEvent,
  type RuntimeTransitionEvent,
} from "../src";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesRoot = join(here, "_tenant_root");
const fixtureSource = join(here, "fixtures", "server.ts");

const setupTenantDir = async (key: string): Promise<void> => {
  const dir = join(fixturesRoot, key);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `tenant-${key}`,
        scripts: { start: `bun run ${fixtureSource}` },
        type: "module",
      },
      null,
      2,
    ),
  );
};

beforeAll(async () => {
  await rm(fixturesRoot, { force: true, recursive: true });
  await mkdir(fixturesRoot, { recursive: true });
  await Promise.all([
    setupTenantDir("alpha"),
    setupTenantDir("beta"),
    setupTenantDir("gamma"),
    setupTenantDir("delta"),
  ]);
});

let runtime: Runtime | null = null;
afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
});

describe("createRuntime", () => {
  test("ensure spawns the tenant process, returns a usable port, reaches /health", async () => {
    runtime = createRuntime({ source: { kind: "directory", root: fixturesRoot } });

    const tenant = await runtime.ensure("alpha");
    expect(tenant.key).toBe("alpha");
    expect(tenant.port).toBeGreaterThan(0);
    expect(tenant.pid).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${tenant.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    expect(runtime.stats()).toEqual({ running: 1, total: 1 });
  });

  test("ensure called twice for the same key reuses the same process", async () => {
    runtime = createRuntime({ source: { kind: "directory", root: fixturesRoot } });
    const first = await runtime.ensure("alpha");
    const second = await runtime.ensure("alpha");
    expect(second.pid).toBe(first.pid);
    expect(second.port).toBe(first.port);
    expect(runtime.stats().running).toBe(1);
  });

  test("concurrent ensure for the same key shares a single-flight spawn", async () => {
    runtime = createRuntime({ source: { kind: "directory", root: fixturesRoot } });
    const [a, b, c] = await Promise.all([
      runtime.ensure("alpha"),
      runtime.ensure("alpha"),
      runtime.ensure("alpha"),
    ]);
    expect(a.pid).toBe(b.pid);
    expect(b.pid).toBe(c.pid);
    expect(runtime.stats().running).toBe(1);
  });

  test("different keys spawn distinct processes", async () => {
    runtime = createRuntime({ source: { kind: "directory", root: fixturesRoot } });
    const alpha = await runtime.ensure("alpha");
    const beta = await runtime.ensure("beta");
    expect(alpha.pid).not.toBe(beta.pid);
    expect(alpha.port).not.toBe(beta.port);
    expect(runtime.stats().running).toBe(2);
  });

  test("kill terminates the child and removes it from the map", async () => {
    runtime = createRuntime({ source: { kind: "directory", root: fixturesRoot } });
    const alpha = await runtime.ensure("alpha");
    expect(runtime.stats().running).toBe(1);
    await runtime.kill("alpha");
    expect(runtime.stats().running).toBe(0);

    // The killed child no longer answers.
    let reachable = true;
    try {
      const res = await fetch(`http://127.0.0.1:${alpha.port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
    expect(reachable).toBe(false);
  });

  test("idle-kill terminates a process whose idle window has elapsed", async () => {
    // 100ms idle, 25ms sweep — keep the test fast.
    runtime = createRuntime({
      idleAfterMs: 100,
      source: { kind: "directory", root: fixturesRoot },
      sweepIntervalMs: 25,
    });
    await runtime.ensure("alpha");
    expect(runtime.stats().running).toBe(1);
    // Wait long enough for two sweep cycles after the idle threshold.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(runtime.stats().running).toBe(0);
  });

  test("touch defers idle-kill", async () => {
    runtime = createRuntime({
      idleAfterMs: 200,
      source: { kind: "directory", root: fixturesRoot },
      sweepIntervalMs: 50,
    });
    await runtime.ensure("alpha");
    // Touch four times across 800ms; the idle window resets each time.
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      runtime.touch("alpha");
    }
    // Should still be running.
    expect(runtime.stats().running).toBe(1);
  });

  test("LRU eviction kicks in when maxConcurrent would be exceeded", async () => {
    const transitions: RuntimeTransitionEvent[] = [];
    runtime = createRuntime({
      maxConcurrent: 2,
      onTransition: (event) => transitions.push(event),
      source: { kind: "directory", root: fixturesRoot },
    });

    await runtime.ensure("alpha");
    // Stagger so beta is younger than alpha when gamma arrives.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.ensure("beta");
    expect(runtime.stats().running).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.ensure("gamma");
    // alpha (oldest) should have been evicted.
    expect(runtime.stats().running).toBe(2);
    expect(
      transitions.some(
        (event) =>
          event.type === "lru-evict" &&
          event.key === "alpha" &&
          event.reason === "max-concurrent",
      ),
    ).toBe(true);
  });

  test("dispose kills every running child", async () => {
    runtime = createRuntime({ source: { kind: "directory", root: fixturesRoot } });
    await runtime.ensure("alpha");
    await runtime.ensure("beta");
    expect(runtime.stats().running).toBe(2);
    await runtime.dispose();
    expect(runtime.stats()).toEqual({ running: 0, total: 0 });
    runtime = null; // afterEach no-op
  });

  test("onLog receives lines from the child's stdout", async () => {
    const lines: RuntimeLogEvent[] = [];
    runtime = createRuntime({
      onLog: (event) => lines.push(event),
      source: { kind: "directory", root: fixturesRoot },
    });
    const tenant = await runtime.ensure("alpha");
    // Fire a request so the fixture writes a stdout line.
    await fetch(`http://127.0.0.1:${tenant.port}/health`);
    // Give the stream loop a tick to emit.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      lines.some(
        (event) =>
          event.stream === "stdout" &&
          event.line.includes("GET /health") &&
          event.key === "alpha",
      ),
    ).toBe(true);
  });

  test("onTransition emits spawn → ready → exit", async () => {
    const transitions: RuntimeTransitionEvent[] = [];
    runtime = createRuntime({
      onTransition: (event) => transitions.push(event),
      source: { kind: "directory", root: fixturesRoot },
    });
    await runtime.ensure("alpha");
    await runtime.kill("alpha");
    const types = transitions.map((event) => event.type);
    expect(types).toContain("spawn");
    expect(types).toContain("ready");
    // exit fires asynchronously after kill completes — wait briefly.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transitions.map((event) => event.type)).toContain("exit");
  });

  test("dispose makes further ensure calls throw", async () => {
    runtime = createRuntime({ source: { kind: "directory", root: fixturesRoot } });
    await runtime.ensure("alpha");
    await runtime.dispose();
    let caught: unknown;
    try {
      await runtime.ensure("alpha");
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toMatch(/disposed/);
    runtime = null;
  });

  test("readiness override is honored", async () => {
    const calls: Array<{ port: number; key: string }> = [];
    runtime = createRuntime({
      readiness: async ({ port, key }) => {
        calls.push({ key, port });
        // Default readiness behavior, but track invocations.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            await fetch(`http://127.0.0.1:${port}/`, {
              signal: AbortSignal.timeout(2_000),
            });
            return true;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        throw new Error("custom readiness timed out");
      },
      source: { kind: "directory", root: fixturesRoot },
    });
    await runtime.ensure("alpha");
    expect(calls.length).toBe(1);
    expect(calls[0]?.key).toBe("alpha");
    expect(calls[0]?.port).toBeGreaterThan(0);
  });
});
