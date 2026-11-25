// Slice 27 — precompact-hook.mjs end-to-end tests.
//
// The hook ships as a static asset under
// `packages/daemon/assets/plugins/openrig-core/skills/claude-compaction-restore/scripts/precompact-hook.mjs`
// and is invoked by Claude Code as a child process. These tests spawn the
// actual hook file with controlled stdin + an isolated OPENRIG_HOME so
// the on-disk behavior matches what Claude will observe at PreCompact
// time.
//
// Hard-gate coverage:
//   HG-6  inline message appended to systemMessage
//   HG-7  file-path message read + appended
//   HG-8  neither set → existing restore-instructions only (no custom append)
//   Inline + file both contribute when both are set

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(
  HERE,
  "..",
  "assets",
  "plugins",
  "openrig-core",
  "skills",
  "claude-compaction-restore",
  "scripts",
  "precompact-hook.mjs",
);
const BRIDGE_SCRIPT = resolve(
  HERE,
  "..",
  "assets",
  "plugins",
  "openrig-core",
  "hooks",
  "scripts",
  "compaction-restore-bridge.cjs",
);
const APPEND_MARKER = "Operator-configured post-compaction restore instruction";

function runHook(openrigHome: string, withTranscript = true, extraEnv: NodeJS.ProcessEnv = {}, hook = HOOK_SCRIPT, transcriptSize = 0): { stdout: string; stderr: string; status: number | null } {
  const fixtureRoot = dirname(openrigHome);
  const transcript = join(fixtureRoot, "transcript.jsonl");
  if (withTranscript) writeFileSync(transcript, `${JSON.stringify({
    sessionId: "precompact-fixture",
    cwd: fixtureRoot,
    message: { role: "user", content: "Resume the private compaction fixture." },
  })}\n`);
  // A larger size extends the file without writing it (a sparse file): the hook only reads its size.
  if (withTranscript && transcriptSize) truncateSync(transcript, transcriptSize);
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd: fixtureRoot, ...(withTranscript ? { transcript_path: transcript } : {}) }),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fixtureRoot,
      CLAUDE_CONFIG_DIR: join(fixtureRoot, ".claude"),
      OPENRIG_HOME: openrigHome,
      OPENRIG_SESSION_NAME: "test-seat@kernel",
      OPENRIG_COMPACTION_OUT_ROOT: join(fixtureRoot, "packets"),
      // Ensure RIGGED_HOME doesn't pre-empt OPENRIG_HOME selection.
      RIGGED_HOME: undefined,
      ...extraEnv,
    } as NodeJS.ProcessEnv,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function runBridge(openrigHome: string, input: Record<string, unknown> = {
  hook_event_name: "UserPromptSubmit",
}): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [BRIDGE_SCRIPT], {
    input: JSON.stringify({ transcript_path: join(dirname(openrigHome), "transcript.jsonl"), ...input }),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENRIG_HOME: openrigHome,
      OPENRIG_SESSION_NAME: "test-seat@kernel",
      RIGGED_HOME: undefined,
    } as NodeJS.ProcessEnv,
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function writePolicyConfig(home: string, policy: {
  enabled?: boolean;
  thresholdPercent?: number;
  preCompactInstruction?: string;
  compactInstruction?: string;
  messageInline?: string;
  messageFilePath?: string;
  postRestoreAuditInstruction?: string;
}): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      policies: {
        claudeCompaction: {
          enabled: policy.enabled ?? false,
          thresholdPercent: policy.thresholdPercent ?? 80,
          preCompactInstruction: policy.preCompactInstruction ?? "",
          compactInstruction: policy.compactInstruction ?? "",
          messageInline: policy.messageInline ?? "",
          messageFilePath: policy.messageFilePath ?? "",
          postRestoreAuditInstruction: policy.postRestoreAuditInstruction ?? "",
        },
      },
    }),
  );
}

function writePartialPolicyConfig(home: string, policy: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      policies: {
        claudeCompaction: policy,
      },
    }),
  );
}

describe("precompact-hook.mjs (slice 27 custom message append)", () => {
  let tmpDir: string;
  let openrigHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "precompact-hook-"));
    openrigHome = join(tmpDir, ".openrig");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prepares the restore packet and pending marker with no Node on PATH", () => {
    const { stdout, status } = runHook(openrigHome, true, { PATH: "" });
    expect(status).toBe(0);
    expect(JSON.parse(stdout).systemMessage).toContain("Pre-compaction restore seed packet prepared");
    const marker = JSON.parse(readFileSync(join(openrigHome, "compaction/restore-pending/test-seat@kernel.json"), "utf8"));
    expect(existsSync(join(marker.outputDir, "restore-instructions.md"))).toBe(true);
  });

  it("HG-6: inline message is appended to systemMessage", () => {
    writePolicyConfig(openrigHome, {
      messageInline: "Operator says hi — remember the migration step.",
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Operator says hi — remember the migration step.");
  });

  it("writes a pending restore marker and bridge injects restore context once", () => {
    writePolicyConfig(openrigHome, {
      messageInline: "Read the queue before resuming.",
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.systemMessage).toContain("pending restore marker");

    const markerDir = join(openrigHome, "compaction", "restore-pending");
    const markerPath = join(markerDir, "test-seat@kernel.json");
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(dirname(marker.outputDir)).toBe(join(tmpDir, "packets"));
    expect(marker.postCompactInstruction).toContain("Inline restore instruction");
    expect(marker.postCompactInstruction).toContain("Read the queue before resuming.");
    expect(marker.deliveryCount).toBe(0);

    const wrongTranscript = runBridge(openrigHome, {
      hook_event_name: "UserPromptSubmit", transcript_path: join(tmpDir, "other.jsonl"),
    });
    expect(wrongTranscript.status).toBe(0);
    expect(wrongTranscript.stdout).toBe("");
    expect(JSON.parse(readFileSync(markerPath, "utf8")).deliveryCount).toBe(0);

    const bridge = runBridge(openrigHome);
    expect(bridge.status).toBe(0);
    const bridgePayload = JSON.parse(bridge.stdout.trim());
    expect(bridgePayload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(bridgePayload.hookSpecificOutput.additionalContext).toContain("OpenRig compaction restore packet is available");
    expect(bridgePayload.hookSpecificOutput.additionalContext).toContain("informational context");
    expect(bridgePayload.hookSpecificOutput.additionalContext).toContain(marker.outputDir);
    expect(bridgePayload.hookSpecificOutput.additionalContext).toContain("Read the queue before resuming.");

    const delivered = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(delivered.deliveryCount).toBe(1);
    expect(delivered.deliveredAt).toBeTruthy();

    const secondBridge = runBridge(openrigHome);
    expect(secondBridge.status).toBe(0);
    expect(secondBridge.stdout).toBe("");
  });

  it("HG-7: file-path message is read + appended when inline is empty", () => {
    const messageFile = join(tmpDir, "msg.txt");
    writeFileSync(messageFile, "Read from disk on every compaction.");
    writePolicyConfig(openrigHome, {
      messageInline: "",
      messageFilePath: messageFile,
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Read from disk on every compaction.");
  });

  it("HG-7: file-path supports ${OPENRIG_HOME} expansion", () => {
    const messageDir = join(openrigHome, "instructions");
    mkdirSync(messageDir, { recursive: true });
    writeFileSync(join(messageDir, "restore.md"), "Read from OPENRIG_HOME-relative path.");
    writePolicyConfig(openrigHome, {
      messageInline: "",
      messageFilePath: "${OPENRIG_HOME}/instructions/restore.md",
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Read from OPENRIG_HOME-relative path.");
  });

  it.each(["~\\instructions\\restore.md", "${OPENRIG_HOME}\\instructions\\restore.md", "$OPENRIG_HOME\\instructions\\restore.md"])("HG-7: native instruction prefix %s follows host path syntax", filePath => {
    const base = filePath.startsWith("~") ? tmpDir : openrigHome;
    mkdirSync(join(base, "instructions"), { recursive: true });
    writeFileSync(join(base, "instructions", "restore.md"), "Owned native-prefix restore witness.");
    writePolicyConfig(openrigHome, { messageInline: "", messageFilePath: filePath });
    const { stdout, status } = runHook(openrigHome, true, process.platform === "win32" ? { USERPROFILE: tmpDir } : {});
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    if (process.platform === "win32") expect(payload.systemMessage).toContain("Owned native-prefix restore witness.");
    else expect(payload.systemMessage).not.toContain("Owned native-prefix restore witness.");
  });

  it("HG-8: neither inline nor file-path set → no custom append (existing restore-instructions preserved)", () => {
    writePolicyConfig(openrigHome, { messageInline: "", messageFilePath: "" });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).not.toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Pre-compaction restore seed packet prepared");
  });

  it("uses the default restore instruction when compaction policy is enabled but restore text is not configured", () => {
    writePartialPolicyConfig(openrigHome, {
      enabled: true,
      thresholdPercent: 80,
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Read the claude-compaction-restore skill");
  });

  it("inline and file-path both contribute when both are set", () => {
    const messageFile = join(tmpDir, "msg.txt");
    writeFileSync(messageFile, "FILE ALSO INCLUDED");
    writePolicyConfig(openrigHome, {
      messageInline: "INLINE INCLUDED",
      messageFilePath: messageFile,
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.systemMessage).toContain("INLINE INCLUDED");
    expect(payload.systemMessage).toContain("FILE ALSO INCLUDED");
  });

  it("file-path with missing file degrades gracefully (no append, no error)", () => {
    writePolicyConfig(openrigHome, {
      messageInline: "",
      messageFilePath: join(tmpDir, "no-such-file.txt"),
    });

    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).not.toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Pre-compaction restore seed packet prepared");
  });

  it("missing config.json: hook still emits restore-instructions (graceful degrade)", () => {
    // No config written — OPENRIG_HOME directory may not even exist.
    const { stdout, status } = runHook(openrigHome);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).not.toContain(APPEND_MARKER);
    expect(payload.systemMessage).toContain("Pre-compaction restore seed packet prepared");
  });

  it("missing transcript is reported without inventing a restore packet or borrowing ambient history", () => {
    const { stdout, status } = runHook(openrigHome, false);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).systemMessage).toContain("could not find a Claude JSONL transcript");
    const markerDir = join(openrigHome, "compaction", "restore-pending");
    expect(existsSync(join(markerDir, "test-seat@kernel.expected.json"))).toBe(true);
    expect(existsSync(join(markerDir, "test-seat@kernel.json"))).toBe(false);
    expect(existsSync(join(tmpDir, "packets"))).toBe(false);
  });

  // The hook runs restore-from-jsonl.mjs from its own folder, so a copy beside a slow stand-in tests the wait without a
  // multi-GB transcript.
  function slowSkill(standIn: string): string {
    const scripts = join(tmpDir, "skill", "scripts");
    mkdirSync(scripts, { recursive: true });
    copyFileSync(HOOK_SCRIPT, join(scripts, "precompact-hook.mjs"));
    writeFileSync(join(scripts, "restore-from-jsonl.mjs"), standIn);
    return join(scripts, "precompact-hook.mjs");
  }
  const pendingDir = () => join(openrigHome, "compaction", "restore-pending");
  // The seat's files, named from the sentinel the hook writes first (its key is the fixture's session name).
  const sentinelFile = () => join(pendingDir(), readdirSync(pendingDir()).find((f) => f.endsWith(".expected.json"))!);
  const markerFile = () => sentinelFile().replace(/\.expected\.json$/, ".json");
  const sentinel = () => JSON.parse(readFileSync(sentinelFile(), "utf8"));
  const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  // The bridge's status reaches the agent as informational context, never as stderr.
  function bridgeContext(input?: Record<string, unknown>): string {
    const run = runBridge(openrigHome, input);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const out = JSON.parse(run.stdout);
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput.hookEventName).toBe(input?.hook_event_name ?? "UserPromptSubmit");
    return out.hookSpecificOutput.additionalContext;
  }

  it("a packet that takes longer than the wait keeps building in the background; the hook says so, and the finisher writes the marker", async () => {
    const hook = slowSkill(`import fs from "node:fs"; import path from "node:path";
const out = process.argv[process.argv.indexOf("--out") + 1];
setTimeout(() => { const dir = path.join(out, "late-packet"); fs.mkdirSync(dir, { recursive: true }); process.stdout.write(JSON.stringify({ ok: true, outputDir: dir })); }, 2000);
`);
    const started = Date.now();
    const { stdout, status } = runHook(openrigHome, true, { OPENRIG_COMPACTION_RESTORE_TIMEOUT_MS: "300" }, hook);
    expect(Date.now() - started).toBeLessThan(1900);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.continue).toBe(true);
    expect(payload.systemMessage).toContain("Claude compaction restore packet is still being built");
    expect(payload.systemMessage).toContain(markerFile());
    expect(payload.systemMessage).toContain("If no marker appears, load the claude-compaction-restore skill and run restore-from-jsonl manually.");
    expect(sentinel().packetJob).toMatchObject({ jobId: expect.any(String), pid: expect.any(Number), resultPath: expect.any(String) });
    expect(existsSync(markerFile())).toBe(false);
    // Meanwhile the bridge tells the agent the packet is being built, not that the write may have failed, and says it once.
    const building = bridgeContext({ hook_event_name: "SessionStart" });
    expect(building).toContain("the restore packet is still being built");
    expect(building).toContain("This is informational, not an action request.");
    expect(runBridge(openrigHome).stdout).toBe("");
    await vi.waitFor(() => expect(existsSync(markerFile())).toBe(true), { timeout: 15_000, interval: 100 });
    const marker = JSON.parse(readFileSync(markerFile(), "utf8"));
    expect(marker.jobId).toBe(sentinel().packetJob.jobId);
    expect(marker.outputDir).toBe(join(tmpDir, "packets", "late-packet"));
    expect(marker.restoreInstruction).toContain(`Pre-compaction restore seed packet prepared at ${join(tmpDir, "packets", "late-packet")}`);
  });

  it("a background build that fails is recorded, and the bridge names the failure", async () => {
    const hook = slowSkill(`setTimeout(() => { process.stderr.write("the transcript could not be read"); process.exit(1); }, 1000);\n`);
    const { stdout } = runHook(openrigHome, true, { OPENRIG_COMPACTION_RESTORE_TIMEOUT_MS: "200" }, hook);
    expect(JSON.parse(stdout).systemMessage).toContain("still being built");
    const { resultPath } = sentinel().packetJob;
    await vi.waitFor(() => expect(existsSync(resultPath)).toBe(true), { timeout: 15_000, interval: 100 });
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({ ok: false, reason: "the transcript could not be read" });
    expect(existsSync(markerFile())).toBe(false);
    expect(bridgeContext()).toContain("the restore packet build failed: the transcript could not be read");
  });

  it("a background build that ended without a result reads as ended, not as still building", () => {
    const hook = slowSkill(`setTimeout(() => {}, 60_000);\n`);
    runHook(openrigHome, true, { OPENRIG_COMPACTION_RESTORE_TIMEOUT_MS: "100" }, hook);
    const job = sentinel().packetJob;
    // The finisher is detached into its own process group; stop it and the restore it started.
    process.kill(-job.pid, "SIGKILL");
    const ended = spawnSync("sh", ["-c", `while kill -0 ${job.pid} 2>/dev/null; do sleep 0.05; done`], { timeout: 10_000 });
    expect(ended.status).toBe(0);
    expect(bridgeContext()).toContain("the restore packet build ended without a packet or a recorded failure");
  });

  it("a packet built within the wait is reported as before, with its marker", () => {
    const { stdout } = runHook(openrigHome, true);
    expect(JSON.parse(stdout).systemMessage).toContain("Pre-compaction restore seed packet prepared");
    expect(existsSync(markerFile())).toBe(true);
    expect(JSON.parse(readFileSync(sentinel().packetJob.resultPath, "utf8"))).toMatchObject({ ok: true });
  });

  // A marker from another build in the seat's marker file after the new sentinel (an earlier compaction's, written in place
  // after the hook moved the file aside): the bridge still counts only the current build's.
  function writeEarlierMarker(delivered: boolean): void {
    writeFileSync(markerFile(), JSON.stringify({
      version: 1, outputDir: join(tmpDir, "packets", "earlier-packet"), transcriptPath: join(tmpDir, "transcript.jsonl"),
      deliveryCount: delivered ? 1 : 0, deliveredAt: delivered ? "2026-11-20T00:00:00.000Z" : null,
    }));
  }

  it("an earlier compaction's delivered marker doesn't hide the new build: the agent hears it's building, then that it failed, once each", async () => {
    const hook = slowSkill(`setTimeout(() => { process.stderr.write("the transcript could not be read"); process.exit(1); }, 1500);\n`);
    runHook(openrigHome, true, { OPENRIG_COMPACTION_RESTORE_TIMEOUT_MS: "200" }, hook);
    writeEarlierMarker(true);
    expect(bridgeContext({ hook_event_name: "SessionStart" })).toContain("the restore packet is still being built");
    const { resultPath } = sentinel().packetJob;
    await vi.waitFor(() => expect(existsSync(resultPath)).toBe(true), { timeout: 15_000, interval: 100 });
    expect(bridgeContext()).toContain("the restore packet build failed: the transcript could not be read");
    expect(runBridge(openrigHome).stdout).toBe("");
    expect(runBridge(openrigHome, { hook_event_name: "PostCompact" }).stdout).toBe("");
    expect(readJson(markerFile())).toMatchObject({ deliveryCount: 1, outputDir: join(tmpDir, "packets", "earlier-packet") });
  });

  it("an earlier compaction's undelivered marker isn't delivered for the new build and doesn't clear its sentinel; the new packet is delivered", async () => {
    const hook = slowSkill(`import fs from "node:fs"; import path from "node:path";
const out = process.argv[process.argv.indexOf("--out") + 1];
setTimeout(() => { const dir = path.join(out, "late-packet"); fs.mkdirSync(dir, { recursive: true }); process.stdout.write(JSON.stringify({ ok: true, outputDir: dir })); }, 1500);
`);
    runHook(openrigHome, true, { OPENRIG_COMPACTION_RESTORE_TIMEOUT_MS: "200" }, hook);
    writeEarlierMarker(false);
    expect(bridgeContext()).toContain("the restore packet is still being built");
    expect(readJson(markerFile())).toMatchObject({ deliveryCount: 0, outputDir: join(tmpDir, "packets", "earlier-packet") });
    expect(existsSync(sentinelFile())).toBe(true);
    const { jobId, resultPath } = sentinel().packetJob;
    await vi.waitFor(() => expect(existsSync(resultPath)).toBe(true), { timeout: 15_000, interval: 100 });
    const [sentinelPath, markerPath] = [sentinelFile(), markerFile()];
    const delivered = bridgeContext();
    expect(delivered).toContain("OpenRig compaction restore packet is available");
    expect(delivered).toContain(join(tmpDir, "packets", "late-packet"));
    expect(readJson(markerPath)).toMatchObject({ jobId, deliveryCount: 1 });
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("two builds for one seat that finish out of order keep their own files, and the newer build's packet is the one delivered", async () => {
    // The first build to start (A) is slow; the second (B) is fast.
    const flag = join(tmpDir, "first-build-started");
    const hook = slowSkill(`import fs from "node:fs"; import path from "node:path";
const out = process.argv[process.argv.indexOf("--out") + 1];
const first = !fs.existsSync(${JSON.stringify(flag)}); fs.writeFileSync(${JSON.stringify(flag)}, "");
setTimeout(() => { const dir = path.join(out, first ? "packet-a" : "packet-b"); fs.mkdirSync(dir, { recursive: true }); process.stdout.write(JSON.stringify({ ok: true, outputDir: dir })); }, first ? 2500 : 0);
`);
    runHook(openrigHome, true, { OPENRIG_COMPACTION_RESTORE_TIMEOUT_MS: "200" }, hook);
    const a = sentinel().packetJob;
    const { stdout } = runHook(openrigHome, true, { OPENRIG_COMPACTION_RESTORE_TIMEOUT_MS: "10000" }, hook);
    const b = sentinel().packetJob;
    expect(b.jobId).not.toBe(a.jobId);
    expect(b.resultPath).not.toBe(a.resultPath);
    // B finished while A was still running: A didn't remove B's job, and B published its marker.
    expect(JSON.parse(stdout).systemMessage).toContain(join(tmpDir, "packets", "packet-b"));
    expect(existsSync(a.resultPath)).toBe(false);
    expect(readJson(markerFile())).toMatchObject({ jobId: b.jobId, outputDir: join(tmpDir, "packets", "packet-b") });
    await vi.waitFor(() => expect(existsSync(a.resultPath)).toBe(true), { timeout: 15_000, interval: 100 });
    // A kept its packet but didn't publish over B; each removed only its own job.
    const resultA = readJson(a.resultPath);
    expect(resultA).toMatchObject({ ok: true, published: false, outputDir: join(tmpDir, "packets", "packet-a") });
    expect(readJson(markerFile())).toMatchObject({ jobId: b.jobId });
    expect(readJson(b.resultPath)).toMatchObject({ jobId: b.jobId, ok: true, published: true });
    expect(readdirSync(dirname(a.resultPath)).filter((f) => f.endsWith(".job.json"))).toEqual([]);
    // Even if A's marker lands over B's late, the bridge delivers B's packet from B's own result and puts B's marker back.
    const markerPath = markerFile();
    writeFileSync(markerPath, JSON.stringify(resultA.marker));
    expect(bridgeContext()).toContain(join(tmpDir, "packets", "packet-b"));
    expect(readJson(markerPath)).toMatchObject({ jobId: b.jobId, deliveryCount: 1 });
    // And A's marker landing after B was delivered is no compaction's marker, so it's never delivered.
    writeFileSync(markerPath, JSON.stringify(resultA.marker));
    expect(runBridge(openrigHome).stdout).toBe("");
  });

  it("the hook moves an earlier compaction's marker aside, so the marker file is absent while the new build runs, and keeps its bytes", async () => {
    runHook(openrigHome, true); // an earlier compaction, built within the wait
    const marker = markerFile();
    expect(bridgeContext()).toContain("OpenRig compaction restore packet is available");
    const earlier = readFileSync(marker, "utf8");
    const hook = slowSkill(`import fs from "node:fs"; import path from "node:path";
const out = process.argv[process.argv.indexOf("--out") + 1];
setTimeout(() => { const dir = path.join(out, "late-packet"); fs.mkdirSync(dir, { recursive: true }); process.stdout.write(JSON.stringify({ ok: true, outputDir: dir })); }, 1500);
`);
    runHook(openrigHome, true, { OPENRIG_COMPACTION_RESTORE_TIMEOUT_MS: "200" }, hook);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(marker.replace(/\.json$/, ".superseded.json"), "utf8")).toBe(earlier);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 15_000, interval: 100 });
    expect(readJson(marker)).toMatchObject({ jobId: sentinel().packetJob.jobId, outputDir: join(tmpDir, "packets", "late-packet") });
  });

  it("restore-from-jsonl --until-byte 0 reads an empty prefix, not the whole transcript", () => {
    const transcript = join(tmpDir, "zero.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ sessionId: "zero", cwd: tmpDir, message: { role: "user", content: "written after the bound" } })}\n`);
    const script = join(dirname(HOOK_SCRIPT), "restore-from-jsonl.mjs");
    const run = spawnSync(process.execPath, [script, "--out", join(tmpDir, "zero-out"), "--json", "--until-byte", "0", transcript], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(readFileSync(JSON.parse(run.stdout).narrative, "utf8")).not.toContain("written after the bound");
  });

  it("restore-from-jsonl --until-byte reads only the transcript as it was at that size", () => {
    const transcript = join(tmpDir, "bounded.jsonl");
    const first = `${JSON.stringify({ sessionId: "bounded", cwd: tmpDir, message: { role: "user", content: "before compaction" } })}\n`;
    writeFileSync(transcript, first + `${JSON.stringify({ sessionId: "bounded", cwd: tmpDir, message: { role: "user", content: "appended after" } })}\n`);
    const script = join(dirname(HOOK_SCRIPT), "restore-from-jsonl.mjs");
    const run = spawnSync(process.execPath, [script, "--out", join(tmpDir, "bounded-out"), "--json", "--until-byte", String(Buffer.byteLength(first)), transcript], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const narrative = readFileSync(JSON.parse(run.stdout).narrative, "utf8");
    expect(narrative).toContain("before compaction");
    expect(narrative).not.toContain("appended after");
  });

  it("asks for a tail packet when the transcript is over 256 MB, and for the whole session otherwise", () => {
    // A copy beside a stand-in that records the arguments it was given.
    const scripts = join(tmpDir, "skill", "scripts");
    mkdirSync(scripts, { recursive: true });
    copyFileSync(HOOK_SCRIPT, join(scripts, "precompact-hook.mjs"));
    const argsFile = join(tmpDir, "args.json");
    writeFileSync(join(scripts, "restore-from-jsonl.mjs"), `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ ok: true, outputDir: ${JSON.stringify(tmpDir)} }));
`);
    const argsFor = (size: number) => {
      expect(runHook(openrigHome, true, {}, join(scripts, "precompact-hook.mjs"), size).status).toBe(0);
      return JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    };
    expect(argsFor(300 * 1024 * 1024).slice(-2)).toEqual(["--tail-bytes", String(256 * 1024 * 1024)]);
    expect(argsFor(256 * 1024 * 1024)).not.toContain("--tail-bytes");
    expect(argsFor(0)).not.toContain("--tail-bytes");
  });
});

// OPR.0.4.1.09 (part 2 guard blocker de2d25c7): the product-owned PreCompact writer must
// GENERATE the restore packet (run restore-from-jsonl) and persist the REAL on-disk
// outputDir + the operator customMessage — never a hard-coded/nonexistent outputDir or an
// emptied message. (The bridge-writer draft hard-coded both: marker pointed at an
// ungenerated packet.) Plus the new per-seat restoreMapPath pointer (the part-1 extra dir).
describe("OPR.0.4.1.09 — PreCompact writer generates a real packet + records restoreMapPath", () => {
  let tmpDir: string;
  let openrigHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "precompact-0419-"));
    openrigHome = join(tmpDir, ".openrig");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function readMarker(): Record<string, unknown> {
    const markerPath = join(openrigHome, "compaction", "restore-pending", "test-seat@kernel.json");
    return JSON.parse(readFileSync(markerPath, "utf8"));
  }

  it("GUARD REGRESSION: marker.outputDir is a REAL generated packet that EXISTS on disk (not hard-coded/ungenerated)", () => {
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    const marker = readMarker();
    expect(dirname(marker["outputDir"] as string)).toBe(join(tmpDir, "packets"));
    // The writer RAN restore-from-jsonl, so the packet directory actually exists on disk.
    expect(existsSync(marker["outputDir"] as string)).toBe(true);
  });

  it("GUARD REGRESSION: the operator customMessage is preserved in the marker (not emptied)", () => {
    writePolicyConfig(openrigHome, { messageInline: "Operator: read the queue before resuming." });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    const marker = readMarker();
    expect(marker["postCompactInstruction"]).toContain("Operator: read the queue before resuming.");
    expect(existsSync(marker["outputDir"] as string)).toBe(true);
  });

  it("records restoreMapPath = the per-seat post-compact-extra/<seat>.md when it EXISTS", () => {
    const extra = join(openrigHome, "compaction", "post-compact-extra", "test-seat@kernel.md");
    mkdirSync(dirname(extra), { recursive: true });
    writeFileSync(extra, "my per-seat restore map");
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(readMarker()["restoreMapPath"]).toBe(extra);
    const bridge = runBridge(openrigHome);
    expect(bridge.status).toBe(0);
    expect(JSON.parse(bridge.stdout).hookSpecificOutput.additionalContext).toContain(`Per-seat restore map: ${extra}`);
  });

  it("records restoreMapPath = null when no per-seat extra exists (never an unresolvable pointer)", () => {
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(readMarker()["restoreMapPath"]).toBeNull();
  });

  it("does not publish a per-seat restore-map pointer whose contents declare another seat", () => {
    const extra = join(openrigHome, "compaction", "post-compact-extra", "test-seat@kernel.md");
    mkdirSync(dirname(extra), { recursive: true });
    writeFileSync(extra, "---\nseat: different-seat@kernel\n---\nForeign owned test witness.");
    expect(runHook(openrigHome).status).toBe(0);
    expect(readMarker()["restoreMapPath"]).toBeNull();
  });
});

// OPR.0.4.1.09 (rev1-r2 blocker dcd95bd9): the PreCompact hook path must apply the SAME
// wrong-seat refusal as the enforcer's resolvePostCompactExtra. Before the fix, the hook
// read the GLOBAL policy.messageFilePath into marker.postCompactInstruction with NO
// seat-check, so a foreign-seat global extra (which the enforcer path refuses) LEAKED via
// the hook path. The FILE portion is now seat-safe: per-seat extra preferred; a global
// declaring a DIFFERENT seat (well-formed frontmatter only) is refused.
describe("OPR.0.4.1.09 (rev1-r2) — hook-path post-compact extra is seat-safe (no wrong-seat leak)", () => {
  let tmpDir: string;
  let openrigHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "precompact-0419-seat-"));
    openrigHome = join(tmpDir, ".openrig");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function markerPostInstruction(): string {
    const markerPath = join(openrigHome, "compaction", "restore-pending", "test-seat@kernel.json");
    return JSON.parse(readFileSync(markerPath, "utf8"))["postCompactInstruction"] as string;
  }

  it("REGRESSION: a foreign-seat GLOBAL messageFilePath is REFUSED — content never reaches the marker (mirrors the enforcer)", () => {
    const globalExtra = join(tmpDir, "global-extra.md");
    writeFileSync(globalExtra, "---\nseat: advisor-lead@kernel\n---\nADVISOR SECRET restore steps.");
    writePolicyConfig(openrigHome, { messageFilePath: globalExtra });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(markerPostInstruction()).not.toContain("ADVISOR SECRET restore steps.");
    expect(markerPostInstruction()).not.toContain("Additional restore instruction file");
  });

  it("prefers the PER-SEAT extra content over a foreign global (seat-safe by construction)", () => {
    const perSeat = join(openrigHome, "compaction", "post-compact-extra", "test-seat@kernel.md");
    mkdirSync(dirname(perSeat), { recursive: true });
    writeFileSync(perSeat, "MY OWN seat restore steps.");
    const globalExtra = join(tmpDir, "global-extra.md");
    writeFileSync(globalExtra, "---\nseat: advisor-lead@kernel\n---\nNOT MINE.");
    writePolicyConfig(openrigHome, { messageFilePath: globalExtra });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(markerPostInstruction()).toContain("MY OWN seat restore steps.");
    expect(markerPostInstruction()).not.toContain("NOT MINE.");
  });

  it("R5 absent-when-needed: the PreCompact hook drops the EXPECTED sentinel (seat identity) so an absent marker is loud", () => {
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    const sentinelPath = join(openrigHome, "compaction", "restore-pending", "test-seat@kernel.expected.json");
    expect(existsSync(sentinelPath)).toBe(true);
    const sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));
    expect(sentinel.sessionName).toBe("test-seat@kernel");
    expect("transcriptPath" in sentinel).toBe(true); // identity-binding field present (matches the marker's)
  });

  it("injects a GENERIC global extra (no frontmatter -> valid for any seat)", () => {
    const globalExtra = join(tmpDir, "global-extra.md");
    writeFileSync(globalExtra, "Generic restore note for all seats.");
    writePolicyConfig(openrigHome, { messageFilePath: globalExtra });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(markerPostInstruction()).toContain("Generic restore note for all seats.");
  });

  it("injects a global extra whose WELL-FORMED frontmatter declares THIS seat", () => {
    const globalExtra = join(tmpDir, "global-extra.md");
    writeFileSync(globalExtra, "---\nseat: test-seat@kernel\n---\nMine, by frontmatter.");
    writePolicyConfig(openrigHome, { messageFilePath: globalExtra });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(markerPostInstruction()).toContain("Mine, by frontmatter.");
  });

  it("injects a MALFORMED-frontmatter global extra (unclosed fence -> generic, not refused)", () => {
    const globalExtra = join(tmpDir, "global-extra.md");
    writeFileSync(globalExtra, "---\nseat: advisor-lead@kernel\n# no closing fence\nStill generic content.");
    writePolicyConfig(openrigHome, { messageFilePath: globalExtra });
    const { status } = runHook(openrigHome);
    expect(status).toBe(0);
    expect(markerPostInstruction()).toContain("Still generic content.");
  });
});
