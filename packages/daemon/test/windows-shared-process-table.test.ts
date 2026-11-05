import { describe, expect, it } from "vitest";
import { readProcessTable } from "../src/domain/process-table.js";
import { parseWindowsProcesses } from "../src/domain/windows-process-table.js";

describe.skipIf(process.platform !== "win32")("shared process table on Windows", () => {
  it("serves reconciliation and resume metadata from the native census without invented foreground groups", async () => {
    const [first, same] = await Promise.all([readProcessTable(), readProcessTable()]);
    expect(first).toBe(same);
    const own = first.find(row => row.pid === process.pid);
    expect(own?.platform).toBe("win32");
    expect(own?.ppid).toBe(process.ppid);
    expect(Date.parse(own!.startedAt)).toBeLessThanOrEqual(Date.now());
    expect(own?.pgid).toBeUndefined();
    expect(own?.tpgid).toBeUndefined();
    expect((await readProcessTable()).find(row => row.pid === process.pid)?.startedAt).toBe(own!.startedAt);
  }, 20_000);
  it("rejects a non-census response instead of turning it into an empty success", () => {
    expect(() => parseWindowsProcesses('{}')).toThrow("not an array");
    expect(() => parseWindowsProcesses('not json')).toThrow();
  });
});
