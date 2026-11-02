import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

export interface StartupMemory {
  observedAt: number;
  source: string;
  availableBytes: number | null;
  totalBytes: number | null;
  pressure: "normal" | "high" | "unknown";
  error?: string;
}

const exec = promisify(execFile);

export function linuxStartupMemory(text: string, now: number): StartupMemory {
  const field = (key: string) => {
    const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"));
    return match ? Number(match[1]) * 1024 : null;
  };
  return { observedAt: now, source: "linux:MemAvailable", availableBytes: field("MemAvailable"),
    totalBytes: field("MemTotal"), pressure: "unknown" };
}

export function macStartupMemory(text: string, pressure: string, total: number, now: number): StartupMemory {
  // Use the system-wide percentage reported by -Q, not vm_stat's free-page count.
  const match = text.match(/System-wide memory free percentage:\s*(\d+)%/);
  const percent = match ? Number(match[1]) : NaN;
  return { observedAt: now, source: "macos:memory_pressure-Q", totalBytes: total,
    availableBytes: Number.isFinite(percent) && percent >= 0 && percent <= 100 ? total * percent / 100 : null,
    pressure: pressure.trim() === "1" ? "normal" : ["2", "4"].includes(pressure.trim()) ? "high" : "unknown" };
}

/** Bounded read-only OS observations; never invoke memory_pressure's allocation/simulation options. */
export async function observeStartupMemory(): Promise<StartupMemory> {
  try {
    if (process.platform === "linux") {
      const sample = linuxStartupMemory(await readFile("/proc/meminfo", "utf8"), Date.now());
      try {
        const psi = await readFile("/proc/pressure/memory", "utf8");
        const some = psi.match(/^some avg10=([\d.]+)/m);
        const full = psi.match(/^full avg10=([\d.]+)/m);
        if (some && full) {
          sample.pressure = Number(some[1]) >= 10 || Number(full[1]) >= 1 ? "high" : "normal";
          sample.source += "+psi";
        }
      } catch { /* No PSI means pressure protection is unavailable; admission degrades visibly. */ }
      // A constrained daemon cannot spend memory outside its own cgroup ceiling.
      try {
        const group = (await readFile("/proc/self/cgroup", "utf8")).match(/^0::(.+)$/m)?.[1];
        if (group && !group.split("/").includes("..")) {
          const base = `/sys/fs/cgroup${group === "/" ? "" : group}`;
          const [max, current] = await Promise.all([readFile(`${base}/memory.max`, "utf8"), readFile(`${base}/memory.current`, "utf8")]);
          if (/^\d+\s*$/.test(max) && /^\d+\s*$/.test(current)) {
            const remaining = Math.max(0, Number(max) - Number(current));
            sample.totalBytes = sample.totalBytes === null ? Number(max) : Math.min(sample.totalBytes, Number(max));
            sample.availableBytes = sample.availableBytes === null ? remaining : Math.min(sample.availableBytes, remaining);
            sample.source += "+cgroup";
          }
        }
      } catch { /* Host observation remains usable when this kernel has no readable cgroup v2 ceiling. */ }
      return sample;
    }
    if (process.platform === "darwin") {
      const [available, pressure] = await Promise.all([
        exec("/usr/bin/memory_pressure", ["-Q"], { timeout: 1500, maxBuffer: 8192 }),
        exec("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 1500, maxBuffer: 1024 }),
      ]);
      return macStartupMemory(available.stdout, pressure.stdout, os.totalmem(), Date.now());
    }
    throw new Error(`No startup memory observer for ${process.platform}`);
  } catch (error) {
    return { observedAt: Date.now(), source: process.platform, availableBytes: null, totalBytes: null,
      pressure: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
}
