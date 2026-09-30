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
        'bun -e "const end = Date.now() + 1500; while (Date.now() < end) {}" & wait',
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.sleep(1_200);
    const tree = await readProcessTreeStats(shim.pid);
    const ownStat = (await Bun.file(`/proc/${shim.pid}/stat`).text())
      .slice(
        (await Bun.file(`/proc/${shim.pid}/stat`).text()).lastIndexOf(")") + 2,
      )
      .split(" ");
    const ticks =
      (globalThis as { Bun?: { clockTicksPerSecond?: number } }).Bun
        ?.clockTicksPerSecond ?? 100;
    const shimOnlyMs =
      ((Number(ownStat[11]) + Number(ownStat[12])) / ticks) * 1000;
    await shim.exited;

    expect(tree).not.toBeNull();
    expect(tree!.processes).toBeGreaterThanOrEqual(2);
    expect(shimOnlyMs).toBeLessThan(200);
    expect(tree!.cpuMs).toBeGreaterThan(700);
    expect(tree!.rssBytes).toBeGreaterThan(0);
  });

  test("keeps the CPU of children that already exited", async () => {
    const shim = Bun.spawn({
      cmd: [
        "sh",
        "-c",
        'bun -e "const end = Date.now() + 800; while (Date.now() < end) {}"; sleep 2',
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.sleep(1_400);
    const tree = await readProcessTreeStats(shim.pid);
    shim.kill();
    await shim.exited;

    expect(tree!.cpuMs).toBeGreaterThan(500);
  });

  test("is null for a pid that is gone", async () => {
    const gone = Bun.spawn({ cmd: ["true"] });
    await gone.exited;

    expect(await readProcessTreeStats(gone.pid)).toBeNull();
  });
});
