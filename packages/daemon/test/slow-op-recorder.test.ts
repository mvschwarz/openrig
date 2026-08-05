import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    degraded.runSync("test.sync.degraded", () => "continued");
    expect(degraded.snapshot()).toMatchObject({
      healthy: false,
      reason: "begin_barrier_timeout",
    });
    await degraded.close();
  });

  it("rotates at the exact cap and records the inclusive slow-request boundary", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "slow-op-recorder production module is missing").not.toBeNull();
    if (!mod) return;

    const dir = tempDir();
    const logPath = path.join(dir, "slow-operations.jsonl");
    const recorder = new mod.SlowOpRecorder({
      logPath,
      maxBytes: 512,
      rotationCount: 2,
      slowThresholdMs: 250,
    });
    recorder.recordRequest("GET /api/queue/:qitemId", 249);
    recorder.recordRequest("GET /api/queue/:qitemId", 250);
    for (let i = 0; i < 30; i += 1) recorder.recordMeasurement(`test.measure.${i}`, 300);
    await recorder.flush();
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    const all = [logPath, `${logPath}.1`, `${logPath}.2`]
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.readFileSync(p, "utf8"))
      .join("\n");
    expect(all).toContain('"site":"request:GET /api/queue/:qitemId"');
    expect(all).not.toContain('"durationMs":249');
    expect(all).toContain('"durationMs":250');
    await recorder.close();
  });

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
    const daemon = await createDaemon({
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
