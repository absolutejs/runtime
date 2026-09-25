import { expect, test } from "bun:test";
import { createRuntime, type RuntimeProcess } from "../src";

const fixture = () => {
  let refuse = true;
  let spawned = 0;
  const exited = Promise.withResolvers<number | null>();
  const process: RuntimeProcess = {
    exited: exited.promise,
    pid: 424242,
    resourceId: "original",
    kill: async () => {
      if (refuse) throw new Error("ownership is busy");
      exited.resolve(0);
    },
  };
  const runtime = createRuntime({
    source: { kind: "directory", root: "/tmp" },
    readiness: async () => true,
    spawn: async () => {
      spawned++;
      return process;
    },
  });
  return {
    runtime,
    allow: () => {
      refuse = false;
    },
    spawned: () => spawned,
  };
};

test("a refused shutdown rejects promptly and retains the original process for retry", async () => {
  const { runtime, allow, spawned } = fixture();
  try {
    await runtime.ensure("project");
    await expect(runtime.kill("project")).rejects.toThrow("ownership is busy");
    expect(runtime.stats().running).toBe(1);
    await expect(runtime.restart("project")).rejects.toThrow(
      "ownership is busy",
    );
    expect(spawned()).toBe(1);
    expect((await runtime.ensure("project")).resourceId).toBe("original");
    allow();
    await runtime.kill("project");
    expect(runtime.stats().running).toBe(0);
  } finally {
    allow();
    await runtime.dispose();
  }
});

test("failed disposal preserves failed children and can be retried", async () => {
  const { runtime, allow } = fixture();
  try {
    await runtime.ensure("project");
    await expect(runtime.dispose()).rejects.toThrow(
      "failed processes remain tracked",
    );
    expect(runtime.stats().running).toBe(1);
    await expect(runtime.ensure("another")).rejects.toThrow("disposed");
    allow();
    await runtime.dispose();
    expect(runtime.stats().running).toBe(0);
  } finally {
    allow();
    await runtime.dispose();
  }
});

test("ensure waits for a confirmed shutdown before spawning a replacement", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let spawned = 0;
  const exits: Array<ReturnType<typeof Promise.withResolvers<number | null>>> =
    [];
  const runtime = createRuntime({
    source: { kind: "directory", root: "/tmp" },
    readiness: async () => true,
    spawn: async () => {
      const index = spawned++;
      const exit = Promise.withResolvers<number | null>();
      exits.push(exit);
      return {
        pid: 424243 + index,
        resourceId: `generation-${index}`,
        exited: exit.promise,
        kill: async () => {
          if (index === 0) {
            entered.resolve();
            await release.promise;
          }
          exit.resolve(0);
        },
      };
    },
  });
  try {
    await runtime.ensure("project");
    const stopping = runtime.kill("project");
    await entered.promise;
    const opening = runtime.ensure("project");
    await Promise.resolve();
    expect(spawned).toBe(1);
    release.resolve();
    await stopping;
    expect((await opening).resourceId).toBe("generation-1");
    expect(spawned).toBe(2);
  } finally {
    release.resolve();
    await runtime.dispose();
  }
});
