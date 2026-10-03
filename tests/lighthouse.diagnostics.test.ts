import { afterEach, describe, expect, it, vi } from "vitest";
import { cgroupDirectory, explainLighthouseFailure, lighthouseMemory, memoryCounter, oomKillCounter, type LighthouseMemory } from "@/lighthouse/diagnostics";

const memory = (oomKills: number | null): LighthouseMemory => ({
  limitMiB: 512, availableMiB: 10, serverRssMiB: 100,
  containerUsedMiB: 500, containerPeakMiB: 512, oomKills,
});

describe("Lighthouse failure evidence", () => {
  afterEach(() => vi.restoreAllMocks());
  it("preserves a measured zero available-memory value", async () => {
    vi.spyOn(process, "availableMemory").mockReturnValue(0);
    expect((await lighthouseMemory()).availableMiB).toBe(0);
  });
  it("samples the current unified cgroup instead of an unrelated ancestor", () => {
    expect(cgroupDirectory("0::/\n")).toBe("/sys/fs/cgroup");
    expect(cgroupDirectory("0::/user.slice/app.scope\n")).toBe("/sys/fs/cgroup/user.slice/app.scope");
    for (const value of [null, "", "5:memory:/legacy\n", "0::/../../other\n", "0::/nested/./other\n"]) {
      expect(cgroupDirectory(value)).toBeNull();
    }
  });
  it("reads keyed OOM counters without confusing failed allocations with actual process kills", () => {
    expect(oomKillCounter("low 0\nmax 200\noom 4\noom_kill 2\noom_group_kill 0\n")).toBe(2);
    expect(oomKillCounter("oom 4\nmax 200\n")).toBeNull();
    expect(oomKillCounter(null)).toBeNull();
  });
  it("keeps unlimited, missing, malformed, and unsafe counters unknown", () => {
    expect(memoryCounter("536870912\n")).toBe(536870912);
    expect(memoryCounter("0\n")).toBe(0);
    for (const value of [null, "max\n", "", "-1", "3.5", "9007199254740992"]) expect(memoryCounter(value)).toBeNull();
  });
  it("explains a memory failure only when the container OOM-kill count increased during this run", () => {
    expect(explainLighthouseFailure("Browser crashed.", "TARGET_CRASHED", memory(2), memory(3))).toContain("ran out of memory");
    expect(explainLighthouseFailure("Browser crashed.", "TARGET_CRASHED", memory(2), memory(2))).not.toContain("ran out of memory");
    expect(explainLighthouseFailure("Browser crashed.", "TARGET_CRASHED", memory(3), memory(2))).not.toContain("ran out of memory");
  });
  it("does not infer OOM from low available RAM, historical kills, or absent telemetry", () => {
    for (const before of [null, memory(null), memory(10)]) {
      expect(explainLighthouseFailure("Worker exited.", null, before, memory(10))).toBe("Worker exited.");
    }
    expect(explainLighthouseFailure("Worker exited.", null, memory(0), memory(null))).toBe("Worker exited.");
  });
  it("provides an actionable renderer-crash explanation while preserving other failure reasons", () => {
    expect(explainLighthouseFailure("Browser crashed.", "TARGET_CRASHED", memory(0), memory(0))).toContain("server logs");
    expect(explainLighthouseFailure("Timed out after 120 seconds.", null, memory(0), memory(0))).toBe("Timed out after 120 seconds.");
  });
});
