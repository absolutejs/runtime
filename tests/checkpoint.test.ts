/**
 * 0.4.0 checkpoint/restore seam contract tests. Uses a FAKE driver:
 * "images" are an in-memory map, "checkpoint" reaps the real process
 * (criu dump semantics — return true ⇒ process is gone), and "restore"
 * spawns a fresh fixture process on the tenant's remembered port and
 * returns its REAL pid — so external-pid liveness polling and the
 * /proc-based observation path exercise the same code a criu restore
 * would.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRuntime,
  type CheckpointDriver,
  type Runtime,
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
  await Promise.all([setupTenantDir("alpha"), setupTenantDir("beta")]);
});

const waitForHealth = async (
  port: number,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fixture on :${port} never became healthy`);
};

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
};

type FakeDriver = {
  driver: CheckpointDriver;
  calls: { checkpoint: number; restore: number; drop: number };
  /** The test records each tenant's port here so "restore" can rebind it. */
  ports: Map<string, number>;
  /** Pids of processes the fake restore spawned, for cleanup. */
  restoredPids: number[];
};

const makeFakeDriver = (
  overrides: Partial<CheckpointDriver> = {},
): FakeDriver => {
  const images = new Map<string, { port: number }>();
  const calls = { checkpoint: 0, drop: 0, restore: 0 };
  const ports = new Map<string, number>();
  const restoredPids: number[] = [];
  const driver: CheckpointDriver = {
    checkpoint: async ({ key, pid }) => {
      calls.checkpoint += 1;
      images.set(key, { port: ports.get(key) ?? 0 });
      // criu dump semantics: returning true means the process is gone.
      try {
        process.kill(pid);
      } catch {
        /* already dead */
      }
      return true;
    },
    drop: async (key) => {
      calls.drop += 1;
      images.delete(key);
    },
    has: async (key) => images.has(key),
    restore: async ({ key }) => {
      calls.restore += 1;
      const image = images.get(key);
      if (image === undefined) return null;
      images.delete(key);
      // "Restore" = spawn a fresh fixture on the checkpointed port and
      // hand back its real pid, so /proc polling sees a live process.
      const child = Bun.spawn({
        cmd: ["bun", "run", fixtureSource],
        env: {
          ...(process.env as Record<string, string>),
          PORT: String(image.port),
        },
        stderr: "ignore",
        stdout: "ignore",
      });
      restoredPids.push(child.pid);
      await waitForHealth(image.port);
      return { pid: child.pid };
    },
    ...overrides,
  };
  return { calls, driver, ports, restoredPids };
};

let runtime: Runtime | null = null;
let cleanupPids: number[] = [];
afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
  for (const pid of cleanupPids) {
    try {
      process.kill(pid);
    } catch {
      /* already dead */
    }
  }
  cleanupPids = [];
});

describe("runtime 0.4.0 — checkpoint/restore seam (EXPERIMENTAL)", () => {
  test("idle sweep checkpoints instead of idle-killing; exit reason is `checkpointed`", async () => {
    const fake = makeFakeDriver();
    cleanupPids = fake.restoredPids;
    const transitions: RuntimeTransitionEvent[] = [];
    runtime = createRuntime({
      checkpoint: { driver: fake.driver },
      idleAfterMs: 75,
      onTransition: (event) => transitions.push(event),
      source: { kind: "directory", root: fixturesRoot },
      sweepIntervalMs: 25,
    });
    const tenant = await runtime.ensure("alpha");
    fake.ports.set("alpha", tenant.port);
    await waitFor(() => runtime!.stats().running === 0);
    await waitFor(() => transitions.some((event) => event.type === "exit"));

    expect(fake.calls.checkpoint).toBe(1);
    const exit = transitions.find((event) => event.type === "exit");
    expect(exit).toBeDefined();
    if (exit && exit.type === "exit") {
      expect(exit.reason).toBe("checkpointed");
    }
    // No idle-kill transition on the checkpoint path.
    expect(transitions.some((event) => event.type === "idle-kill")).toBe(false);
    const m = runtime.metrics();
    expect(m.checkpoints.checkpoints).toBe(1);
    expect(m.totalExits.checkpointed).toBe(1);
    expect(m.totalExits["idle-killed"]).toBe(0);
  });

  test("ensure() after checkpoint restores: external pid, `restored` transition, port works", async () => {
    const fake = makeFakeDriver();
    cleanupPids = fake.restoredPids;
    const transitions: RuntimeTransitionEvent[] = [];
    runtime = createRuntime({
      checkpoint: { driver: fake.driver },
      idleAfterMs: 75,
      onTransition: (event) => transitions.push(event),
      source: { kind: "directory", root: fixturesRoot },
      sweepIntervalMs: 25,
    });
    const first = await runtime.ensure("alpha");
    fake.ports.set("alpha", first.port);
    await waitFor(() => runtime!.stats().running === 0);

    const restored = await runtime.ensure("alpha");
    expect(fake.calls.restore).toBe(1);
    expect(restored.pid).not.toBe(first.pid);
    expect(restored.port).toBe(first.port);
    expect(runtime.stats().running).toBe(1);

    const restoredEvent = transitions.find(
      (event) => event.type === "restored",
    );
    expect(restoredEvent).toBeDefined();
    if (restoredEvent && restoredEvent.type === "restored") {
      expect(restoredEvent.key).toBe("alpha");
      expect(restoredEvent.pid).toBe(restored.pid);
      expect(restoredEvent.port).toBe(first.port);
      expect(restoredEvent.durationMs).toBeGreaterThanOrEqual(0);
    }
    // The restored tenant actually serves on the remembered port.
    const res = await fetch(`http://127.0.0.1:${restored.port}/health`);
    expect(res.status).toBe(200);
    const m = runtime.metrics();
    expect(m.checkpoints.restores).toBe(1);
    expect(m.checkpoints.restoreFailures).toBe(0);
  });

  test("restored (external-pid) tenant: liveness poll detects death; observation still emits", async () => {
    const fake = makeFakeDriver();
    cleanupPids = fake.restoredPids;
    const transitions: RuntimeTransitionEvent[] = [];
    const observations: Array<{ pid: number; rssBytes: number }> = [];
    runtime = createRuntime({
      checkpoint: { driver: fake.driver },
      idleAfterMs: 0, // no idle-kill after restore — we kill manually
      observeIntervalMs: 40,
      onMetrics: (event) => {
        if (event.type === "observation") {
          observations.push({ pid: event.pid, rssBytes: event.rssBytes });
        }
      },
      onTransition: (event) => transitions.push(event),
      source: { kind: "directory", root: fixturesRoot },
      sweepIntervalMs: 25,
    });
    // Checkpoint via a one-off runtime pass: ensure → idle → checkpointed.
    const idleRuntime = createRuntime({
      checkpoint: { driver: fake.driver },
      idleAfterMs: 50,
      source: { kind: "directory", root: fixturesRoot },
      sweepIntervalMs: 25,
    });
    const first = await idleRuntime.ensure("alpha");
    fake.ports.set("alpha", first.port);
    await waitFor(() => idleRuntime.stats().running === 0);
    await idleRuntime.dispose();

    const restored = await runtime.ensure("alpha");
    // Observation events are /proc-based and work unchanged (Linux only).
    if (process.platform === "linux") {
      await waitFor(() =>
        observations.some(
          (observation) =>
            observation.pid === restored.pid && observation.rssBytes > 0,
        ),
      );
    }
    // Kill the external process out-of-band; the sweep's liveness poll
    // must notice and classify it as crashed.
    process.kill(restored.pid);
    await waitFor(() => runtime!.stats().running === 0);
    await waitFor(() =>
      transitions.some(
        (event) => event.type === "exit" && event.reason === "crashed",
      ),
    );
    const exit = transitions.find((event) => event.type === "exit");
    if (exit && exit.type === "exit") {
      expect(exit.pid).toBe(restored.pid);
      expect(exit.exitCode).toBeNull();
    }
  });

  test("restore returning null falls back to a cold spawn and drops the image", async () => {
    const fake = makeFakeDriver({
      restore: async () => null,
    });
    cleanupPids = fake.restoredPids;
    runtime = createRuntime({
      checkpoint: { driver: fake.driver },
      idleAfterMs: 75,
      source: { kind: "directory", root: fixturesRoot },
      sweepIntervalMs: 25,
    });
    const first = await runtime.ensure("alpha");
    fake.ports.set("alpha", first.port);
    await waitFor(() => runtime!.stats().running === 0);

    const respawned = await runtime.ensure("alpha");
    expect(respawned.pid).not.toBe(first.pid);
    expect(runtime.stats().running).toBe(1);
    expect(fake.calls.drop).toBeGreaterThanOrEqual(1);
    // Fresh spawn — the fixture serves on its NEW port.
    const res = await fetch(`http://127.0.0.1:${respawned.port}/health`);
    expect(res.status).toBe(200);
    const m = runtime.metrics();
    expect(m.checkpoints.restoreFailures).toBe(1);
    expect(m.checkpoints.restores).toBe(0);
    expect(m.totalSpawns).toBe(2);
  });

  test("driver.checkpoint returning false falls back to a normal idle-kill", async () => {
    const fake = makeFakeDriver({
      checkpoint: async () => false,
    });
    cleanupPids = fake.restoredPids;
    const transitions: RuntimeTransitionEvent[] = [];
    runtime = createRuntime({
      checkpoint: { driver: fake.driver },
      idleAfterMs: 75,
      onTransition: (event) => transitions.push(event),
      source: { kind: "directory", root: fixturesRoot },
      sweepIntervalMs: 25,
    });
    await runtime.ensure("alpha");
    await waitFor(() => runtime!.stats().running === 0);
    await waitFor(() =>
      transitions.some(
        (event) => event.type === "exit" && event.reason === "idle-killed",
      ),
    );
    expect(transitions.some((event) => event.type === "idle-kill")).toBe(true);
    const m = runtime.metrics();
    expect(m.checkpoints.checkpoints).toBe(0);
    expect(m.totalExits["idle-killed"]).toBe(1);
    expect(m.totalExits.checkpointed).toBe(0);
  });

  test("explicit kill() and dispose() never checkpoint — only the idle path does", async () => {
    const fake = makeFakeDriver();
    cleanupPids = fake.restoredPids;
    runtime = createRuntime({
      checkpoint: { driver: fake.driver },
      idleAfterMs: 60_000,
      source: { kind: "directory", root: fixturesRoot },
      sweepIntervalMs: 25,
    });
    await runtime.ensure("alpha");
    await runtime.kill("alpha");
    await runtime.ensure("beta");
    await runtime.dispose();
    expect(fake.calls.checkpoint).toBe(0);
    runtime = null;
  });

  test("metrics counters: checkpoint → restore round-trip fills the checkpoints block", async () => {
    const fake = makeFakeDriver();
    cleanupPids = fake.restoredPids;
    runtime = createRuntime({
      checkpoint: { driver: fake.driver },
      idleAfterMs: 75,
      source: { kind: "directory", root: fixturesRoot },
      sweepIntervalMs: 25,
    });
    const tenant = await runtime.ensure("alpha");
    fake.ports.set("alpha", tenant.port);
    await waitFor(() => runtime!.stats().running === 0);
    await runtime.ensure("alpha");

    const m = runtime.metrics();
    expect(m.checkpoints.checkpoints).toBe(1);
    expect(m.checkpoints.restores).toBe(1);
    expect(m.checkpoints.restoreFailures).toBe(0);
    expect(m.checkpoints.lastRestoreMs).toBeGreaterThanOrEqual(0);
    // stats() carries the same block.
    expect(runtime.stats().checkpoints).toEqual(m.checkpoints);
    // A restore is not a cold spawn.
    expect(m.totalSpawns).toBe(1);
  });
});
