import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SlowOpRecorder } from "../src/domain/slow-op-recorder.js";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of dirs.splice(0)) fs.rmSync(p, { force: true, recursive: true }); });
function fixture(options = {}) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "request-records-")); dirs.push(dir); const file = path.join(dir, "slow.jsonl"); return { dir, file, recorder: new SlowOpRecorder({ logPath: file, ...options }) }; }
function rows(file: string) { return fs.readFileSync(file, "utf8").trim().split("\n").map(s => JSON.parse(s)); }
it("writes fast diagnostic events asynchronously with bounded backlog, explicit drops and private rotation", async () => {
  const { recorder, file, dir } = fixture({ maxBytes: 1000 });
  const wait = vi.spyOn(Atomics, "wait");
  try {
    expect(recorder.recordDiagnostic({ schema: "openrig.request-phase/v1", seq: 1, phase: "node_arrival" })).toBe(true);
    expect(recorder.recordDiagnostic({ field: "x".repeat(1025) })).toBe(false);
    await recorder.flush();
    recorder.recordDiagnostic({ schema: "openrig.request-phase/v1", seq: 3, phase: "response_finish", status: 200 });
    await recorder.flush();
    expect(rows(file).at(-1).coverage).toMatchObject({ offered: 3, enqueued: 1, dropped: 1, acknowledged: 1, pending: 0 });
    for (let i = 0; i < 1025; i++) recorder.recordDiagnostic({ seq: i + 4, phase: "test" });
    await recorder.flush(); recorder.recordDiagnostic({ phase: "tail" }); await recorder.flush();
    expect(rows(file).at(-1).coverage.dropped).toBe(2);
    expect(wait).not.toHaveBeenCalled();
    const files = fs.readdirSync(dir); expect(files.length).toBeLessThanOrEqual(4);
    for (const name of files) { const stat = fs.statSync(path.join(dir, name)); expect(stat.size).toBeLessThanOrEqual(1000); expect(stat.mode & 0o777).toBe(0o600); }
  } finally { await recorder.close(); }
});
it("retains write-failure and worker-loss drain refusal", async () => {
  const { recorder, file } = fixture();
  try {
    fs.mkdirSync(file); recorder.recordDiagnostic({ phase: "write_failure" });
    await expect(recorder.flush()).rejects.toThrow("recorder_write_failed");
  } finally { await recorder.close().catch(() => {}); }
  expect(recorder.recordDiagnostic({ phase: "after_close" })).toBe(false);
  const second = fixture();
  await (second.recorder as any).worker.terminate();
  expect(second.recorder.recordDiagnostic({ phase: "lost" })).toBe(false);
  await expect(second.recorder.flush()).rejects.toThrow("terminated");
  await second.recorder.close().catch(() => {});
});
