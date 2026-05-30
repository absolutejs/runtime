/**
 * 0.3.0 OTel integration. Spawns a real tenant fixture, captures the
 * runtime.spawn span, asserts attributes + lifecycle (open on spawn,
 * close on exit with the right ExitReason).
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ABS_ATTRS,
  createNoopSpan,
  type Span,
  type Tracer,
  type TracerProvider,
} from "@absolutejs/telemetry";
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
  await Promise.all([setupTenantDir("alpha"), setupTenantDir("beta")]);
});

type CapturedSpan = {
  name: string;
  attrs: Record<string, unknown>;
  status?: { code: number; message?: string };
  ended: boolean;
};

const makeCapturingTracerProvider = (): {
  provider: TracerProvider;
  spans: CapturedSpan[];
} => {
  const spans: CapturedSpan[] = [];
  const makeSpan = (record: CapturedSpan): Span => {
    const noop = createNoopSpan();
    return {
      ...noop,
      end: () => {
        record.ended = true;
      },
      isRecording: () => !record.ended,
      setAttribute: ((key: string, value: unknown) => {
        record.attrs[key] = value;
        return makeSpan(record);
      }) as Span["setAttribute"],
      setStatus: ((status) => {
        record.status = status;
        return makeSpan(record);
      }) as Span["setStatus"],
    };
  };
  const tracer: Tracer = {
    startActiveSpan: ((name, optionsOrFn, maybeFn) => {
      const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
      const record: CapturedSpan = { attrs: {}, ended: false, name };
      spans.push(record);
      return (fn as (s: Span) => unknown)(makeSpan(record));
    }) as Tracer["startActiveSpan"],
    startSpan: (name, options) => {
      const record: CapturedSpan = {
        attrs: { ...(options?.attributes ?? {}) },
        ended: false,
        name,
      };
      spans.push(record);
      return makeSpan(record);
    },
  };
  return {
    provider: { getTracer: () => tracer },
    spans,
  };
};

let runtime: Runtime | null = null;
afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
});

describe("runtime 0.3.0 — OTel via @absolutejs/telemetry", () => {
  test("ensure() opens a runtime.spawn span with ABS_ATTRS", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
      tracerProvider: provider,
    });
    const tenant = await runtime.ensure("alpha");
    const spawnSpan = spans.find((s) => s.name === "runtime.spawn");
    expect(spawnSpan).toBeDefined();
    expect(spawnSpan!.attrs[ABS_ATTRS.runtimeKey]).toBe("alpha");
    expect(spawnSpan!.attrs[ABS_ATTRS.runtimePid]).toBe(tenant.pid);
    expect(spawnSpan!.attrs[ABS_ATTRS.runtimePort]).toBe(tenant.port);
    expect(typeof spawnSpan!.attrs[ABS_ATTRS.runtimeReadinessMs]).toBe(
      "number",
    );
    // Span is still open while the tenant is running.
    expect(spawnSpan!.ended).toBe(false);
  });

  test("kill() ends the span with ERROR + exit_reason=killed", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
      tracerProvider: provider,
    });
    await runtime.ensure("alpha");
    await runtime.kill("alpha");
    // Give the exit handler a tick.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const spawnSpan = spans.find((s) => s.name === "runtime.spawn");
    expect(spawnSpan!.ended).toBe(true);
    expect(spawnSpan!.attrs[ABS_ATTRS.runtimeExitReason]).toBe("killed");
    expect(spawnSpan!.status?.code).toBe(2);
  });

  test("two tenants get two distinct spans", async () => {
    const { provider, spans } = makeCapturingTracerProvider();
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
      tracerProvider: provider,
    });
    await runtime.ensure("alpha");
    await runtime.ensure("beta");
    const spawnSpans = spans.filter((s) => s.name === "runtime.spawn");
    expect(spawnSpans).toHaveLength(2);
    const keys = spawnSpans.map((s) => s.attrs[ABS_ATTRS.runtimeKey]);
    expect(keys).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  test("without tracerProvider runtime still works (noop)", async () => {
    runtime = createRuntime({
      source: { kind: "directory", root: fixturesRoot },
    });
    const tenant = await runtime.ensure("alpha");
    expect(tenant.pid).toBeGreaterThan(0);
    // No assertion on spans — there's no tracer to capture against.
  });
});
