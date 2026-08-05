import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-slow-op-shutdown-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function loadIndex(): Promise<Record<string, any>> {
  return import("../src/index.js");
}
async function loadRecorder(): Promise<Record<string, any>> {
  return import("../src/domain/slow-op-recorder.js");
}
async function readRecords(logPath: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.promises.readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("drainSlowOpRecorderOnShutdown — bounded shutdown drain", () => {
  it("returns exit 0 and persists queued records when a real recorder drains cleanly", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    const { SlowOpRecorder } = await loadRecorder();
    const logPath = path.join(tempDir(), "drain.jsonl");
    const recorder = new SlowOpRecorder({ logPath });
    recorder.recordMeasurement("test.drain.a", 300);
    recorder.recordMeasurement("test.drain.b", 300);
    const code = await drainSlowOpRecorderOnShutdown(recorder);
    expect(code).toBe(0);
    const records = await readRecords(logPath);
    expect(records.map((r) => r.site)).toEqual(["test.drain.a", "test.drain.b"]);
  });

  it("returns 0 when no recorder is wired", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    expect(await drainSlowOpRecorderOnShutdown(undefined)).toBe(0);
  });

  it("returns nonzero and logs when the drain rejects (unproven durability)", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    const logs: string[] = [];
    const recorder = { close: async () => { throw new Error("terminal drain failure"); } };
    const code = await drainSlowOpRecorderOnShutdown(recorder, { log: (m: string) => logs.push(m) });
    expect(code).toBe(1);
    expect(logs.join(" ")).toMatch(/slow-operation/);
  });

  it("is bounded: returns nonzero within the timeout when the drain hangs", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    const logs: string[] = [];
    const recorder = { close: () => new Promise<void>(() => {}) }; // never resolves
    const started = process.hrtime.bigint();
    const code = await drainSlowOpRecorderOnShutdown(recorder, { timeoutMs: 50, log: (m: string) => logs.push(m) });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(code).toBe(1);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(logs.join(" ")).toMatch(/slow-operation/);
  });

  it("crosses a real signal through the same drain helper: success persists records and exits 0", async () => {
    const logPath = path.join(tempDir(), "signal-success.jsonl");
    const indexUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/index.ts")).href;
    const recorderUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/domain/slow-op-recorder.ts")).href;
    const childSource = `
      const { drainSlowOpRecorderOnShutdown } = await import(process.env.INDEX_URL);
      const { SlowOpRecorder } = await import(process.env.RECORDER_URL);
      const recorder = new SlowOpRecorder({ logPath: process.env.LOG_PATH });
      recorder.recordMeasurement("test.signal.a", 300);
      recorder.recordMeasurement("test.signal.b", 300);
      process.once("SIGINT", () => { void drainSlowOpRecorderOnShutdown(recorder).then((code) => process.exit(code)); });
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
    `;
    const exitCode = await runSignalChild(childSource, { LOG_PATH: logPath, INDEX_URL: indexUrl, RECORDER_URL: recorderUrl });
    expect(exitCode).toBe(0);
    const records = await readRecords(logPath);
    expect(records.map((r) => r.site)).toEqual(["test.signal.a", "test.signal.b"]);
  }, 20_000);

  it("crosses a real signal: a forced drain failure is bounded, logged, and exits nonzero", async () => {
    const indexUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/index.ts")).href;
    const childSource = `
      const { drainSlowOpRecorderOnShutdown } = await import(process.env.INDEX_URL);
      const recorder = { close: async () => { throw new Error("forced drain failure"); } };
      process.once("SIGINT", () => { void drainSlowOpRecorderOnShutdown(recorder, { timeoutMs: 1000 }).then((code) => process.exit(code)); });
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
    `;
    const exitCode = await runSignalChild(childSource, { INDEX_URL: indexUrl });
    expect(exitCode).not.toBe(0);
  }, 20_000);
});

async function runSignalChild(childSource: string, env: Record<string, string>): Promise<number | null> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", childSource],
    { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      const timeout = setTimeout(() => reject(new Error(`child never signalled ready: ${stderr}`)), 15_000);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("ready")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`child exited before ready (code=${code}): ${stderr}`));
      });
    });
    child.kill("SIGINT");
    const [code] = (await once(child, "exit")) as [number | null];
    return code;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
