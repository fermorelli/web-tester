import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeHomepage } from "@/lighthouse";
import type { LighthouseMemory } from "@/lighthouse/diagnostics";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), resolvePublicAddress: vi.fn(), startProxy: vi.fn(),
  mkdtemp: vi.fn(), readFile: vi.fn(), rm: vi.fn(), memory: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({ mkdtemp: mocks.mkdtemp, readFile: mocks.readFile, rm: mocks.rm }));
vi.mock("@/crawler/security", () => ({ resolvePublicAddress: mocks.resolvePublicAddress }));
vi.mock("@/lighthouse/proxy", () => ({ startLighthouseProxy: mocks.startProxy }));
vi.mock("@/lighthouse/diagnostics", async importOriginal => ({
  ...await importOriginal<typeof import("@/lighthouse/diagnostics")>(),
  lighthouseMemory: mocks.memory,
}));

const memory: LighthouseMemory = {
  limitMiB: 512, availableMiB: 10, serverRssMiB: 100,
  containerUsedMiB: 500, containerPeakMiB: 512, oomKills: 2,
};
const profile = "mock-lighthouse-profile";
const sensitiveMessage = "A resource failed: https://example.com/login?access_token=private-browser-detail";

/** Exercise the actual parent message handler without starting Chromium or opening sockets. */
function workerReturning(message: unknown) {
  const worker = Object.assign(new EventEmitter(), {
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    send: vi.fn((_input: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null);
      queueMicrotask(() => {
        worker.emit("message", message);
        worker.exitCode = 0;
        worker.emit("exit", 0);
      });
      return true;
    }),
  });
  return worker;
}

describe("Lighthouse worker failure boundary", () => {
  let closeProxy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolvePublicAddress.mockResolvedValue({ address: "93.184.216.34", family: 4 });
    closeProxy = vi.fn().mockResolvedValue(undefined);
    mocks.startProxy.mockResolvedValue({ url: "http://127.0.0.1:12345", stats: { blockedRequests: 0, limitedRequests: 0 }, close: closeProxy });
    mocks.mkdtemp.mockResolvedValue(profile);
    mocks.readFile.mockRejectedValue(new Error("No browser PID file was created."));
    mocks.rm.mockResolvedValue(undefined);
    mocks.memory.mockResolvedValue(memory);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["error IPC", { type: "error", error: sensitiveMessage, errorCode: "TARGET_CRASHED" }],
    ["report runtimeError", { type: "result", report: { runtimeError: { code: "TARGET_CRASHED", message: sensitiveMessage } } }],
  ])("preserves renderer-crash evidence from %s while isolating the unavailable result", async (_source, message) => {
    mocks.spawn.mockReturnValue(workerReturning(message));

    const result = await analyzeHomepage("https://example.com/nested?input_token=private-input-detail");

    expect(result).toMatchObject({
      status: "unavailable", homepageUrl: "https://example.com/nested", finalUrl: null,
      scores: null, metrics: null, error: expect.stringContaining("Chromium's browser tab crashed"),
    });
    expect(result.error).not.toContain("ran out of memory");
    expect(closeProxy).toHaveBeenCalledOnce();
    expect(mocks.rm).toHaveBeenCalledWith(profile, expect.objectContaining({ recursive: true }));

    const warning = vi.mocked(console.warn).mock.calls.find(call => call[0] === "[Lighthouse] Analysis unavailable");
    expect(warning).toBeDefined();
    expect(JSON.parse(String(warning![1]))).toMatchObject({
      homepage: "https://example.com/nested", code: "TARGET_CRASHED", workerExitCode: 0,
      memoryBefore: { oomKills: 2 }, memoryAfter: { oomKills: 2 },
    });
    const logged = JSON.stringify([...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls]);
    expect(logged).not.toContain("private-browser-detail");
    expect(logged).not.toContain("private-input-detail");
  });
});
