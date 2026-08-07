import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDaemon } from "../src/startup.js";
import { createSlowOpRequestMiddleware } from "../src/domain/slow-op-recorder.js";

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
      // This recorder's log path is intentionally unwritable (to force the
      // begin-barrier failure above), so close() now correctly rejects on the
      // latched lost-write durability — tolerate it in teardown.
      await recorder.close().catch(() => {});
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

  // The request-timing MIDDLEWARE CONTRACT, hermetic + deterministic. The prior "real server" form
  // ran the full daemon (event-loop monitor + a globalThis.fetch monkey-patch), which is structurally
  // ambient-fragile under the concurrent-workspace gate: it intermittently returned 200 for an unmatched
  // route (a full-daemon/global-mutation concurrency artifact — NOT the middleware, which is
  // measurement-only). This tests the extracted seam directly, with an INJECTED clock so durations are
  // deterministic (the injectable-clock discipline, third instance after P6-C + VM-005). The "real server
  // actually uses this middleware" enable-path moves to the startup-wiring pin (startup-wiring-pins.test).
  it("composes request timing across health and unmatched routes (hermetic middleware contract)", async () => {
    const requests: Array<{ site: string; durationMs: number }> = [];
    const recorder = { recordRequest(site: string, durationMs: number): void { requests.push({ site, durationMs }); } };
    let clock = 1000;
    const now = (): number => (clock += 5); // each now() advances 5ms → one 5ms tick brackets each request

    const app = new Hono();
    app.use("*", createSlowOpRequestMiddleware(recorder, now));
    app.get("/healthz", (c) => c.json({ status: "ok" }));
    // no /definitely-missing route → deterministic 404 (Hono default), never a load-dependent 200

    expect((await app.request("/healthz?probe=1")).status).toBe(200);
    expect((await app.request("/definitely-missing?token=must-not-appear")).status).toBe(404);
    expect(requests.map((request) => request.site)).toEqual(["GET /healthz", "GET /definitely-missing"]);
    // Deterministic durations under the injected clock (start + end = one 5ms tick), no real timer.
    expect(requests.map((request) => request.durationMs)).toEqual([5, 5]);
    // The observer records site + duration only — the query param never leaks.
    expect(JSON.stringify(requests)).not.toContain("must-not-appear");
  });

  it("wraps all nine accepted sync calls without moving them off the main thread", () => {
    const srcRoot = path.resolve(import.meta.dirname, "../src");
    for (const [relativePath, sites] of expectedSites) {
      const source = fs.readFileSync(path.join(srcRoot, relativePath), "utf8");
      for (const site of sites) expect(source, `${relativePath} missing ${site}`).toContain(site);
    }
  });

  it("degrades once and releases every pending waiter on an unexpected worker exit (code 0 counts)", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "slow-op-recorder production module is missing").not.toBeNull();
    if (!mod) return;

    const dir = tempDir();
    const recorder = new mod.SlowOpRecorder({ logPath: path.join(dir, "exit.jsonl") });
    let highUrgencyEmissions = 0;
    recorder.setDegradedHandler(() => { highUrgencyEmissions += 1; });
    const worker = (recorder as any).worker;
    // Wedge the worker so posted records stay pending (no response arrives).
    worker.postMessage = () => {};
    const inflightFlush = recorder.flush();
    recorder.recordMeasurement("test.pending.a", 300);
    recorder.recordMeasurement("test.pending.b", 300);
    expect((recorder as any).pending.size).toBeGreaterThan(0);

    // Unexpected worker exit — even an exit code of 0 is a loss while open.
    worker.emit("exit", 0);

    await expect(inflightFlush).rejects.toBeInstanceOf(mod.SlowOpRecorderTerminatedError);
    expect((recorder as any).pending.size).toBe(0);
    expect(recorder.snapshot()).toMatchObject({ healthy: false });
    // Second terminal trigger must not re-emit the one-shot high-urgency signal.
    worker.emit("error", new Error("second"));
    expect(highUrgencyEmissions).toBe(1);
    await recorder.close().catch(() => {});
  });

  it("routes error, messageerror, and synchronous post failure through the same terminal transition", async () => {
    const mod = await loadRecorderModule();
    if (!mod) return;
    const dir = tempDir();

    for (const trigger of ["error", "messageerror"] as const) {
      const recorder = new mod.SlowOpRecorder({ logPath: path.join(dir, `${trigger}.jsonl`) });
      (recorder as any).worker.postMessage = () => {};
      const pending = recorder.flush();
      (recorder as any).worker.emit(trigger, new Error(trigger));
      await expect(pending).rejects.toBeInstanceOf(mod.SlowOpRecorderTerminatedError);
      expect(recorder.snapshot()).toMatchObject({ healthy: false });
      await recorder.close().catch(() => {});
    }

    // Synchronous worker.postMessage failure is the same terminal transition;
    // fire-and-forget measurement must internalize it (no unhandled rejection).
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const recorder = new mod.SlowOpRecorder({ logPath: path.join(dir, "syncpost.jsonl") });
      (recorder as any).worker.postMessage = () => { throw new Error("posting to terminated worker"); };
      expect(() => recorder.recordMeasurement("test.syncpost", 300)).not.toThrow();
      await expect(recorder.flush()).rejects.toBeInstanceOf(mod.SlowOpRecorderTerminatedError);
      expect(recorder.snapshot()).toMatchObject({ healthy: false });
      await recorder.close().catch(() => {});
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("makes future flush finite + explicitly unsuccessful after a real worker termination", async () => {
    const mod = await loadRecorderModule();
    if (!mod) return;
    const recorder = new mod.SlowOpRecorder({ logPath: path.join(tempDir(), "realterm.jsonl") });
    await (recorder as any).worker.terminate(); // real, unexpected (not via close())
    await new Promise((r) => setImmediate(r));   // let the 'exit' handler run
    expect(recorder.snapshot()).toMatchObject({ healthy: false });
    await expect(recorder.flush()).rejects.toBeInstanceOf(mod.SlowOpRecorderTerminatedError);
    // wrapped value identity is authoritative even after terminal failure
    expect(recorder.runSync("test.after.terminal", () => 7)).toBe(7);
    await expect(recorder.runStage("test.after.stage", async () => "ok")).resolves.toBe("ok");
    const boom = new Error("wrapped");
    await expect(recorder.runStage("test.after.throw", async () => { throw boom; })).rejects.toBe(boom);
    await recorder.close().catch(() => {});
  });

  it("treats a normal close() as expected termination — no degradation, no high-urgency event", async () => {
    const mod = await loadRecorderModule();
    if (!mod) return;
    const recorder = new mod.SlowOpRecorder({ logPath: path.join(tempDir(), "normalclose.jsonl") });
    let emissions = 0;
    recorder.setDegradedHandler(() => { emissions += 1; });
    recorder.recordMeasurement("test.normal", 300);
    await recorder.close();
    expect(recorder.snapshot()).toMatchObject({ healthy: true });
    expect(emissions).toBe(0);
  });

  it("latches an acknowledged Worker write failure so flush/close cannot report a clean durable drain", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "slow-op-recorder production module is missing").not.toBeNull();
    if (!mod) return;

    // Deterministic real Worker append rejection: the log's parent is a regular
    // file, so the Worker's mkdirSync(dirname) fails ENOTDIR-class -> ok:false.
    const dir = tempDir();
    const notADir = path.join(dir, "regular-file");
    fs.writeFileSync(notADir, "x");
    const recorder = new mod.SlowOpRecorder({ logPath: path.join(notADir, "slow-operations.jsonl") });
    let emissions = 0;
    recorder.setDegradedHandler(() => { emissions += 1; });
    recorder.recordMeasurement("test.write.fail", 300);

    // A known-lost write must make the drain non-clean: flush rejects with the
    // write-failure error (distinct from the worker-terminal error).
    await expect(recorder.flush()).rejects.toBeInstanceOf(mod.SlowOpRecorderWriteError);
    expect(recorder.snapshot()).toMatchObject({
      healthy: false,
      reason: "recorder_write_failed",
      site: "recorder.worker",
    });
    expect(emissions).toBe(1);
    // Wrapped operation identity is still authoritative after a write failure.
    expect(recorder.runSync("test.after.write", () => 7)).toBe(7);
    // close() preserves the drain failure (rejects) but still tears down finitely.
    await expect(recorder.close()).rejects.toBeInstanceOf(mod.SlowOpRecorderWriteError);
    expect(emissions).toBe(1);
  });

  // A throwing observer must NEVER replace the route's real status/body (it is isolated in a finally).
  // Hermetic + deterministic — same contract, no full-daemon boot.
  it("isolates a throwing request observer so the route keeps its exact successful status and body (hermetic)", async () => {
    const recorder = { recordRequest(): void { throw new Error("request observer sink failed"); } };
    const app = new Hono();
    app.use("*", createSlowOpRequestMiddleware(recorder, () => 0));
    app.get("/healthz", (c) => c.json({ status: "ok" }));

    const res = await app.request("/healthz");
    expect(res.status).toBe(200); // the throw is swallowed at the boundary, not surfaced as a 500
    expect(await res.json()).toMatchObject({ status: "ok" });
    // an unmatched route keeps its exact 404 even though the observer throws on it too
    expect((await app.request("/definitely-missing")).status).toBe(404);
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
