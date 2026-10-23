import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessCensus } from "../src/domain/process-census.js";
import { listNativeProcesses } from "../src/domain/native-process-lineage.js";

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform !== "win32")("native Windows process census", () => {
  it("enumerates the current process through the production default", async () => {
    const row = (await new ProcessCensus().list()).find(row => row.pid === process.pid);
    expect(row).toBeDefined();
    expect(row?.command).toContain("node");
    expect(Number.isFinite(Date.parse(row?.startedAt ?? ""))).toBe(true);
  }, 15000);

  it("rejects failed enumeration and retries after the executable is restored", async () => {
    const root = process.env.SystemRoot;
    vi.stubEnv("SystemRoot", "Z:\\openrig-missing-system-root");
    const census = new ProcessCensus({ freshnessMs: 60000 });
    await expect(census.list()).rejects.toThrow();
    await expect(listNativeProcesses()).resolves.toEqual([]);
    vi.stubEnv("SystemRoot", root);
    expect((await census.list()).some(row => row.pid === process.pid)).toBe(true);
  }, 15000);
});
