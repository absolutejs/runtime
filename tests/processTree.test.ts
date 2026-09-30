import { describe, expect, test } from "bun:test";
import { readProcessTreeStats } from "../src";

const isLinux = process.platform === "linux";

describe.if(isLinux)("readProcessTreeStats", () => {
  test("counts a busy child the root shim never shows", async () => {
    // A shell that only waits, like an init shim, over a child that burns CPU.
    const shim = Bun.spawn({
      cmd: [
        "sh",
        "-c",
        'bun -e "const end = Date.now() + 10000; while (Date.now() < end) {}" & wait',
      ],
      stderr: "ignore",
      stdout: "ignore",
    });
    // Poll rather than sleep: a loaded machine starts the child late.
    const deadline = Date.now() + 8_000;
    let tree = await readProcessTreeStats(shim.pid);
    while ((tree?.cpuMs ?? 0) < 500 && Date.now() < deadline) {
      await Bun.sleep(100);
      tree = await readProcessTreeStats(shim.pid);
    }
    const statText = await Bun.file(`/proc/${shim.pid}/stat`).text();
    const ownStat = statText.slice(statText.lastIndexOf(")") + 2).split(" ");
    const ticks =
      (globalThis as { Bun?: { clockTicksPerSecond?: number } }).Bun
        ?.clockTicksPerSecond ?? 100;
    const shimOnlyMs =
      ((Number(ownStat[11]) + Number(ownStat[12])) / ticks) * 1000;
    shim.kill();
    await shim.exited;

    expect(tree).not.toBeNull();
    expect(tree!.processes).toBeGreaterThanOrEqual(2);
    expect(tree!.cpuMs).toBeGreaterThanOrEqual(500);
    expect(shimOnlyMs).toBeLessThan(tree!.cpuMs / 5);
    expect(tree!.rssBytes).toBeGreaterThan(0);
  });

  test("keeps the CPU of children that already exited", async () => {
    const shim = Bun.spawn({
      cmd: [
        "sh",
        "-c",
        'bun -e "const end = Date.now() + 800; while (Date.now() < end) {}"; exec sleep 10',
      ],
      stderr: "ignore",
      stdout: "ignore",
    });
    // Once the busy child exits, the shell execs into sleep: one process
    // left, carrying the reaped child's CPU.
    const deadline = Date.now() + 8_000;
    let tree = await readProcessTreeStats(shim.pid);
    while (
      ((tree?.processes ?? 0) !== 1 || (tree?.cpuMs ?? 0) < 500) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(100);
      tree = await readProcessTreeStats(shim.pid);
    }
    shim.kill();
    await shim.exited;

    expect(tree!.processes).toBe(1);
    expect(tree!.cpuMs).toBeGreaterThanOrEqual(500);
  });

  test("is null for a pid that is gone", async () => {
    const gone = Bun.spawn({ cmd: ["true"] });
    await gone.exited;

    expect(await readProcessTreeStats(gone.pid)).toBeNull();
  });
});
