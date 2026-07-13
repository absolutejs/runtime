/**
 * 0.2.0 metrics() contract tests. Builds on the runtime test fixtures:
 * tenant directories under tests/_tenant_root with a thin package.json
 * + fixtures/server.ts as the entry point. Each test creates a runtime,
 * exercises a path, asserts the cumulative counters, disposes.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, type Runtime } from "../src";

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
  ]);
});

let runtime: Runtime | null = null;
afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
});

describe("runtime.metrics() — 0.2.0", () => {
  test("starts with zeroed cumulative counters", () => {
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
    });
    const m = runtime.metrics();
    expect(m.totalSpawns).toBe(0);
    expect(m.totalBackoffEntries).toBe(0);
    expect(m.lastSpawnMs).toBe(0);
    expect(m.totalExits).toEqual({
      crashed: 0,
      "exited-clean": 0,
      "idle-killed": 0,
      "lru-evicted": 0,
      killed: 0,
      "readiness-timeout": 0,
      disposed: 0,
      restarted: 0,
      checkpointed: 0,
    });
    expect(m.checkpoints).toEqual({
      checkpoints: 0,
      lastRestoreMs: 0,
      restoreFailures: 0,
      restores: 0,
    });
    // Mirror RuntimeStats fields.
    expect(m.running).toBe(0);
    expect(m.total).toBe(0);
    expect(m.draining).toBe(false);
    expect(m.backoff).toBe(0);
  });

  test("totalSpawns + lastSpawnMs bump after ensure()", async () => {
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
    });
    await runtime.ensure("alpha");
    const m = runtime.metrics();
    expect(m.totalSpawns).toBe(1);
    expect(m.lastSpawnMs).toBeGreaterThan(0);
    expect(m.running).toBe(1);
  });

  test('totalExits["killed"] bumps after kill()', async () => {
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
    });
    await runtime.ensure("alpha");
    await runtime.kill("alpha");
    // exit handler fires async; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runtime.metrics().totalExits.killed).toBe(1);
  });

  test('totalExits["restarted"] bumps after restart()', async () => {
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
    });
    await runtime.ensure("alpha");
    await runtime.restart("alpha");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const m = runtime.metrics();
    expect(m.totalExits.restarted).toBe(1);
    // Restart spawns again — totalSpawns should be 2.
    expect(m.totalSpawns).toBe(2);
  });

  test("totalSpawns reflects multiple tenants", async () => {
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
    });
    await runtime.ensure("alpha");
    await runtime.ensure("beta");
    await runtime.ensure("gamma");
    expect(runtime.metrics().totalSpawns).toBe(3);
    expect(runtime.metrics().running).toBe(3);
  });

  test("totalBackoffEntries bumps on spawn failure", async () => {
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
    });
    // A key that doesn't exist as a tenant dir → spawn fails →
    // recordBackoff fires.
    await expect(runtime.ensure("nonexistent-tenant")).rejects.toThrow();
    const m = runtime.metrics();
    expect(m.totalBackoffEntries).toBeGreaterThanOrEqual(1);
    expect(m.backoff).toBeGreaterThanOrEqual(1);
    expect(m.totalSpawns).toBe(0);
  });

  test("stats() and metrics() agree on the shared fields", async () => {
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
    });
    await runtime.ensure("alpha");
    const s = runtime.stats();
    const m = runtime.metrics();
    expect(m.running).toBe(s.running);
    expect(m.total).toBe(s.total);
    expect(m.backoff).toBe(s.backoff);
    expect(m.draining).toBe(s.draining);
  });

  test("counters survive drain() — useful for post-shutdown introspection", async () => {
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
    });
    await runtime.ensure("alpha");
    runtime.drain();
    const m = runtime.metrics();
    expect(m.totalSpawns).toBe(1);
    expect(m.draining).toBe(true);
  });
});
