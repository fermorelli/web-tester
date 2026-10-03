import { readFile } from "node:fs/promises";

export interface LighthouseMemory {
  limitMiB: number | null;
  availableMiB: number | null;
  serverRssMiB: number;
  containerUsedMiB: number | null;
  containerPeakMiB: number | null;
  oomKills: number | null;
}

const mib = (bytes: number | null): number | null => bytes === null ? null : Math.round(bytes / 1024 / 1024);

/** Unknown or unlimited cgroup values must not be presented as a zero limit. */
export function memoryCounter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const count = Number(value.trim());
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function oomKillCounter(events: string | null): number | null {
  const match = events?.match(/^oom_kill\s+(\d+)\s*$/m);
  return memoryCounter(match?.[1] ?? null);
}

export function cgroupDirectory(membership: string | null): string | null {
  const group = membership?.match(/^0::(\/[^\r\n]*)$/m)?.[1];
  if (!group || group.split("/").some(part => part === "." || part === "..")) return null;
  return `/sys/fs/cgroup${group === "/" ? "" : group}`;
}

/** Read only the container's resource counters; never retain browser/page logs. */
export async function lighthouseMemory(): Promise<LighthouseMemory> {
  const membership = process.platform === "linux" ? await readFile("/proc/self/cgroup", "utf8").catch(() => null) : null;
  const directory = cgroupDirectory(membership);
  const read = async (name: string) => directory ? readFile(`${directory}/${name}`, "utf8").catch(() => null) : null;
  const [limit, used, peak, events] = await Promise.all([
    read("memory.max"), read("memory.current"), read("memory.peak"), read("memory.events"),
  ]);
  const constrained = process.constrainedMemory();
  const available = process.availableMemory();
  return {
    limitMiB: mib(memoryCounter(limit) ?? (constrained > 0 ? constrained : null)),
    availableMiB: mib(available),
    serverRssMiB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    containerUsedMiB: mib(memoryCounter(used)), containerPeakMiB: mib(memoryCounter(peak)),
    oomKills: oomKillCounter(events),
  };
}

export function explainLighthouseFailure(message: string, code: string | null, before: LighthouseMemory | null, after: LighthouseMemory): string {
  // A low RAM limit or SIGKILL alone cannot prove that the OS killed a process for memory.
  if (before?.oomKills !== null && before?.oomKills !== undefined && after.oomKills !== null && after.oomKills > before.oomKills) {
    return "The server ran out of memory during homepage analysis. Increase the service memory limit and run a new audit.";
  }
  if (code === "TARGET_CRASHED") {
    return "Chromium's browser tab crashed while analyzing the homepage. Check the service memory usage and server logs, then run a new audit.";
  }
  return message;
}
