import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemon } from "../src/startup.js";

const expectedSites = new Map<string, string[]>([
  ["adapters/codex-resume.ts", ["codex.resume.profile_preflight"]],
  ["adapters/codex-runtime-adapter.ts", ["codex.runtime.profile_preflight", "codex.runtime.list_processes"]],
  ["routes/rigspec.ts", ["rigspec.import.preflight"]],
  ["domain/bootstrap-orchestrator.ts", ["bootstrap.plan.preflight"]],
  ["domain/resume-metadata-refresher.ts", ["resume_metadata.list_processes"]],
  ["domain/codex-thread-id.ts", ["codex_thread_id.resolve_home"]],
  ["domain/review/gather.ts", ["review.gather.git"]],
  ["domain/tmux-option-defaults.ts", ["tmux_options.command_v"]],
]);

const pluginVendorUrl = "https://github.com/mvschwarz/openrig-plugins/releases/latest/download/openrig-core.tar.gz";

async function createTestDaemon(
  options: Parameters<typeof createDaemon>[0],
): Promise<Awaited<ReturnType<typeof createDaemon>>> {
  const originalFetch = globalThis.fetch;
  const fetchedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchedUrls.push(url);
    if (url !== pluginVendorUrl) throw new Error(`unexpected startup fetch: ${url}`);
    return new Response(null, { status: 404 });
  };
  try {
    const daemon = await createDaemon(options);
    expect(fetchedUrls).toEqual([pluginVendorUrl]);
    return daemon;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-slow-op-"));
  tempDirs.push(dir);
  return dir;
}

async function loadRecorderModule(): Promise<Record<string, any> | null> {
  return import("../src/domain/slow-op-recorder.js").catch(() => null);
}

async function readRecords(logPath: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.promises.readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("SlowOpRecorder locked instrumentation contract", () => {
  it("pins the absolute boundary, rotation, filename, and secret-safe record contract", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "slow-op-recorder production module is missing").not.toBeNull();
    if (!mod) return;

    expect(mod.SLOW_OPERATION_BARRIER_TIMEOUT_MS).toBe(250);
    expect(mod.SLOW_OPERATION_THRESHOLD_MS).toBe(250);
    expect(mod.SLOW_OPERATION_ROTATION_BYTES).toBe(1024 * 1024);
    expect(mod.SLOW_OPERATION_ROTATION_COUNT).toBe(3);
    expect(mod.SLOW_OPERATION_LOG_BASENAME).toBe("slow-operations.jsonl");

    const dir = tempDir();
    const logPath = path.join(dir, "slow-operations.jsonl");
    const recorder = new mod.SlowOpRecorder({ logPath });
    const secret = "OPENRIG_TEST_SECRET_DO_NOT_RECORD";
    process.env.OPENRIG_TEST_SECRET = secret;
    try {
      const value = recorder.runSync("test.sync.boundary", () => {
        const records = fs.readFileSync(logPath, "utf8");
        expect(records).toContain('"phase":"begin"');
        expect(records).toContain('"site":"test.sync.boundary"');
        return 41;
      });
      expect(value).toBe(41);
      await recorder.flush();
      const records = await readRecords(logPath);
      expect(records.map((r) => r.phase)).toEqual(["begin", "end"]);
      expect(records.every((r) => r.v === 1 && typeof r.ts === "string" && typeof r.spanId === "string")).toBe(true);
      expect(records[0]).not.toHaveProperty("durationMs");
      expect(records[0]).not.toHaveProperty("outcome");
      expect(records[1]).toMatchObject({ site: "test.sync.boundary", outcome: "ok" });
      expect(typeof records[1]!.durationMs).toBe("number");
      expect(fs.readFileSync(logPath, "utf8")).not.toContain(secret);
      expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      delete process.env.OPENRIG_TEST_SECRET;
      await recorder.close();
    }
  });

  it("leaves a durable open span after the begin barrier and exposes fail-visible degradation", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "slow-op-recorder production module is missing").not.toBeNull();
    if (!mod) return;

    const dir = tempDir();
    const logPath = path.join(dir, "slow-operations.jsonl");
    const recorder = new mod.SlowOpRecorder({ logPath });
    const span = recorder.beginSyncSpan("test.sync.wedge");
    expect(span).toBeTruthy();
    const records = await readRecords(logPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ phase: "begin", site: "test.sync.wedge" });
    expect(recorder.snapshot()).toMatchObject({ healthy: true });
    await recorder.close();

    const degraded = new mod.SlowOpRecorder({
      logPath: path.join(dir, "degraded.jsonl"),
      barrierTimeoutMs: 0,
    });
    const oldNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
    const daemon = await createTestDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
      slowOpRecorder: degraded,
    } as never);
    try {
      expect(degraded.runSync("test.sync.degraded", () => "continued")).toBe("continued");
      expect(degraded.snapshot()).toMatchObject({
        healthy: false,
        reason: "begin_barrier_timeout",
      });

      const healthResponse = await daemon.app.request("/healthz");
      expect(await healthResponse.json()).toMatchObject({
        status: "ok",
        slowOperations: {
          healthy: false,
          reason: "begin_barrier_timeout",
        },
      });
      const observations = daemon.deps.streamStore!.list();
      expect(observations).toHaveLength(1);
      expect(observations[0]!.body).toContain("begin_barrier_timeout");
      expect(observations[0]!.body).toContain("test.sync.degraded");
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      await degraded.close();
      if (oldNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = oldNoKernel;
    }
  });

  it("isolates a throwing degradation observer so wrapped work still proceeds", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "slow-op-recorder production module is missing").not.toBeNull();
    if (!mod) return;

    const recorder = new mod.SlowOpRecorder({ logPath: tempDir() });
    recorder.setDegradedHandler(() => {
      throw new Error("stream sink failed");
    });
    let ran = false;
    try {
      const value = recorder.runSync("test.sync.observer_failure", () => {
        ran = true;
        return "continued";
      });
      expect(value).toBe("continued");
      expect(ran).toBe(true);
      expect(recorder.snapshot()).toEqual({
        healthy: false,
        reason: "begin_barrier_failed",
        site: "test.sync.observer_failure",
      });
    } finally {
      await recorder.close();
    }
  });

  it("durably records an open span before a main-thread sync wedge is killed", async () => {
    const dir = tempDir();
    const logPath = path.join(dir, "crash.jsonl");
    fs.writeFileSync(logPath, "", { mode: 0o600 });
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/domain/slow-op-recorder.ts")).href;
    const childSource = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { isMainThread, threadId } from "node:worker_threads";
      for (const name of [
        "appendFileSync", "chmodSync", "fchmodSync", "fdatasyncSync", "fsyncSync",
        "ftruncateSync", "mkdirSync", "openSync", "renameSync", "rmSync", "rmdirSync",
        "truncateSync", "unlinkSync", "writeFileSync", "writeSync",
      ]) {
        fs[name] = () => { throw new Error("main-thread synchronous recorder I/O: " + name); };
      }
      syncBuiltinESMExports();
      const mod = await import(process.env.RECORDER_MODULE_URL);
      const recorder = new mod.SlowOpRecorder({ logPath: process.env.RECORDER_LOG_PATH });
      recorder.runSync("test.sync.crash", () => {
        process.stdout.write(JSON.stringify({ isMainThread, threadId }) + "\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
      env: {
        ...process.env,
        RECORDER_LOG_PATH: logPath,
        RECORDER_MODULE_URL: moduleUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });

    try {
      const callbackEvidence = await new Promise<{ isMainThread: boolean; threadId: number }>((resolve, reject) => {
        let stdout = "";
        const timeout = setTimeout(() => reject(new Error(`child callback did not begin: ${stderr}`)), 5_000);
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          stdout += chunk;
          const newline = stdout.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timeout);
          resolve(JSON.parse(stdout.slice(0, newline)) as { isMainThread: boolean; threadId: number });
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`child exited before callback (code=${code}): ${stderr}`));
        });
      });
      expect(callbackEvidence).toEqual({ isMainThread: true, threadId: 0 });
      child.kill("SIGKILL");
      await once(child, "exit");

      const records = await readRecords(logPath);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ phase: "begin", site: "test.sync.crash" });
      expect(records[0]).not.toHaveProperty("durationMs");
      expect(records[0]).not.toHaveProperty("outcome");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);

  it("rotates at the exact cap and records the inclusive slow-request boundary", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "slow-op-recorder production module is missing").not.toBeNull();
    if (!mod) return;

    const dir = tempDir();
    const logPath = path.join(dir, "slow-operations.jsonl");
    const recorder = new mod.SlowOpRecorder({
      logPath,
      maxBytes: 512,
      rotationCount: 3,
      slowThresholdMs: 250,
    });
    for (let i = 0; i < 30; i += 1) recorder.recordMeasurement(`test.measure.${i}`, 300);
    recorder.recordRequest("GET /api/queue/:qitemId", 249);
    recorder.recordRequest("GET /api/queue/:qitemId", 250);
    await recorder.flush();
    const retained = [logPath, `${logPath}.1`, `${logPath}.2`, `${logPath}.3`];
    for (const retainedPath of retained) {
      expect(fs.existsSync(retainedPath), `${retainedPath} should exist`).toBe(true);
      expect(fs.statSync(retainedPath).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(`${logPath}.4`)).toBe(false);
    const all = retained
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.readFileSync(p, "utf8"))
      .join("\n");
    expect(all).toContain('"site":"request:GET /api/queue/:qitemId"');
    expect(all).not.toContain('"durationMs":249');
    expect(all).toContain('"durationMs":250');
    await recorder.close();
  });

  it("composes request timing across health and unmatched routes in the real server", async () => {
    const requests: Array<{ site: string; durationMs: number }> = [];
    const recorder = {
      recordRequest(site: string, durationMs: number): void {
        requests.push({ site, durationMs });
      },
      snapshot: () => ({ healthy: true }),
    };
    const oldNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
    const daemon = await createTestDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
      slowOpRecorder: recorder,
    } as never);
    try {
      expect((await daemon.app.request("/healthz?probe=1")).status).toBe(200);
      expect((await daemon.app.request("/definitely-missing?token=must-not-appear")).status).toBe(404);
      expect(requests.map((request) => request.site)).toEqual([
        "GET /healthz",
        "GET /definitely-missing",
      ]);
      expect(requests.every((request) => Number.isFinite(request.durationMs) && request.durationMs >= 0)).toBe(true);
      expect(JSON.stringify(requests)).not.toContain("must-not-appear");
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      if (oldNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = oldNoKernel;
    }
  }, 10_000);

  it("wraps all nine accepted sync calls without moving them off the main thread", () => {
    const srcRoot = path.resolve(import.meta.dirname, "../src");
    for (const [relativePath, sites] of expectedSites) {
      const source = fs.readFileSync(path.join(srcRoot, relativePath), "utf8");
      for (const site of sites) expect(source, `${relativePath} missing ${site}`).toContain(site);
    }
  });

  it("drives the real tmux command-v spawnSync site through a hermetic daemon", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "slow-op-recorder production module is missing").not.toBeNull();
    if (!mod) return;

    const dir = tempDir();
    const logPath = path.join(dir, "slow-operations.jsonl");
    const recorder = new mod.SlowOpRecorder({ logPath });
    const oldNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
    const daemon = await createTestDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
      slowOpRecorder: recorder,
      tmuxOptionPlatform: "linux",
    } as never);
    try {
      await daemon.deps.tmuxOptionDefaults!.applyToFreshSession("instrumentation-control");
      await recorder.flush();
      const records = await readRecords(logPath);
      expect(records.some((r) => r.site === "tmux_options.command_v" && r.phase === "end")).toBe(true);
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      await recorder.close();
      if (oldNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = oldNoKernel;
    }
  });
});
