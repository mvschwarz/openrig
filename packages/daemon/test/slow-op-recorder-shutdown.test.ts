import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
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
    // Generous explicit bound: the drain is clean, but the recorder's Worker
    // round-trip can be starved under heavy vitest parallelism; this asserts
    // clean-drain success, not a wall-clock budget (production keeps the 5s
    // default). The hanging-close pin below proves the bound itself fires.
    const code = await drainSlowOpRecorderOnShutdown(recorder, { timeoutMs: 20_000 });
    expect(code).toBe(0);
    const records = await readRecords(logPath);
    expect(records.map((r) => r.site)).toEqual(["test.drain.a", "test.drain.b"]);
  }, 30_000);

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

  it("returns nonzero and logs when the recorder acknowledged a lost write (durability not clean)", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    const { SlowOpRecorder } = await loadRecorder();
    // Deterministic real Worker ok:false — log parent is a regular file (ENOTDIR).
    const dir = tempDir();
    const notADir = path.join(dir, "regular-file");
    fs.writeFileSync(notADir, "x");
    const recorder = new SlowOpRecorder({ logPath: path.join(notADir, "slow-operations.jsonl") });
    recorder.recordMeasurement("test.write.fail", 300);
    const logs: string[] = [];
    const code = await drainSlowOpRecorderOnShutdown(recorder, { timeoutMs: 20_000, log: (m: string) => logs.push(m) });
    expect(code).toBe(1);
    expect(logs.join(" ")).toMatch(/slow-operation/);
  }, 30_000);

  it("treats a FALSEY promise rejection as a failure (logs + nonzero), not a silent success", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    for (const value of [undefined, null, false, 0, ""]) {
      const logs: string[] = [];
      const recorder = { close: () => Promise.reject(value) };
      const code = await drainSlowOpRecorderOnShutdown(recorder, { log: (m: string) => logs.push(m) });
      expect(code, `rejection with ${JSON.stringify(value)} must be a failure`).toBe(1);
      expect(logs.join(" ")).toMatch(/slow-operation/);
    }
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

  it("a real SIGINT crosses the actual startServer shutdown handler and drains to exit 0", async () => {
    // Runs the production entrypoint directly (isDirectRun -> startServer()),
    // which registers the real SIGINT handler at index.ts and builds a real
    // file-backed recorder. A real signal crosses THAT handler — not a test
    // handler — and the clean drain must yield exit 0.
    const home = tempDir();
    const port = await getFreePort();
    const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
    const child = spawn(process.execPath, ["--import", "tsx", indexPath], {
      env: {
        ...process.env,
        OPENRIG_NO_KERNEL: "1",
        OPENRIG_HOME: home,
        OPENRIG_DB: path.join(home, "openrig.sqlite"),
        OPENRIG_PORT: String(port),
        OPENRIG_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (c: string) => { stderr += c; });
    try {
      await waitForHealthz(port, child, () => stderr);
      child.kill("SIGINT");
      const [code] = (await once(child, "exit")) as [number | null];
      expect(code, `daemon should exit 0 after a clean drain; stderr=${stderr}`).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  it("is bounded with no other referenced handles: a hanging close logs and exits nonzero", async () => {
    // No setInterval, no server — the ONLY thing that may keep the process
    // alive to enforce the bound is the drain's own referenced timeout timer.
    // With an unref'd timer the process would exit 0 before the bound fires.
    const indexUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/index.ts")).href;
    const childSource = `
      const { drainSlowOpRecorderOnShutdown } = await import(process.env.INDEX_URL);
      const recorder = { close: () => new Promise(() => {}) }; // never resolves
      const code = await drainSlowOpRecorderOnShutdown(recorder, {
        timeoutMs: 150,
        log: (m) => console.error(m),
      });
      process.exit(code);
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childSource],
      { env: { ...process.env, INDEX_URL: indexUrl }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (c: string) => { stderr += c; });
    try {
      const [code] = (await once(child, "exit")) as [number | null];
      expect(code, "a hanging close must exit nonzero within the bound").not.toBe(0);
      expect(stderr).toMatch(/slow-operation/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealthz(port: number, child: ReturnType<typeof spawn>, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let exited = false;
  child.once("exit", () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error(`daemon exited before ready: ${stderr()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`daemon never became healthy: ${stderr()}`);
}
