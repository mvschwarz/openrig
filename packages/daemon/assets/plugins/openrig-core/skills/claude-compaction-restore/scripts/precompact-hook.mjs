#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const restoreScript = path.join(skillRoot, "scripts", "restore-from-jsonl.mjs");
// P6(C) injectable output-root: the packet base defaults to the shared
// /tmp/claude-compaction-restore (production), but becomes per-run isolated when the
// hermetic env-var OPENRIG_COMPACTION_OUT_ROOT is set — so concurrent writers with the
// same injected clock + sessionId no longer collide on the same `${sessionId}-${stamp}`
// dir. Mirrors the injectable-clock seam (OPENRIG_TEST_CLOCK_NOW). Empty/absent = /tmp.
const outRoot = process.env.OPENRIG_COMPACTION_OUT_ROOT || "/tmp/claude-compaction-restore";
// The packet is built by a detached copy of this hook (--finish), so a large transcript can take as long as it needs. The
// hook waits for it for 25 s by default, inside its own 30 s timeout (hooks/claude.json): a packet ready by then is
// reported as before; otherwise the hook says the packet is still being built, and the finisher writes the pending
// restore marker when it's done, or records why it failed. OPENRIG_COMPACTION_RESTORE_TIMEOUT_MS sets another positive
// wait (tests shorten it); it isn't capped at the default.
const timeoutOverride = Number(process.env.OPENRIG_COMPACTION_RESTORE_TIMEOUT_MS);
const restoreTimeoutMs = Number.isInteger(timeoutOverride) && timeoutOverride > 0 ? timeoutOverride : 25_000;
// A transcript larger than this gets a packet from its last TAIL_BYTES only, so it's made inside the budget (a 2.95 GB
// transcript took 69 s whole). A smaller one gets the whole-session packet, unchanged.
const TAIL_BYTES = 256 * 1024 * 1024;
const defaultRestoreInstruction =
  "Read the claude-compaction-restore skill and follow its \"If You Just Compacted\" protocol.";

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function getOpenRigHome() {
  return process.env.OPENRIG_HOME || process.env.RIGGED_HOME || path.join(os.homedir(), ".openrig");
}

// A3-R3 injectable clock (slice 51-01): marker.createdAt defaults to real wall-clock,
// but becomes deterministic when the shared hermetic env-var OPENRIG_TEST_CLOCK_NOW is
// set (an ISO instant). Empty/absent = production real-time.
function nowIso() {
  const injected = process.env.OPENRIG_TEST_CLOCK_NOW;
  return typeof injected === "string" && injected.trim().length > 0 ? injected : new Date().toISOString();
}

function expandInstructionPath(filePath) {
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  if (filePath.startsWith("${OPENRIG_HOME}/")) {
    return path.join(getOpenRigHome(), filePath.slice("${OPENRIG_HOME}/".length));
  }
  if (filePath.startsWith("$OPENRIG_HOME/")) {
    return path.join(getOpenRigHome(), filePath.slice("$OPENRIG_HOME/".length));
  }
  return filePath;
}

function readInstructionFile(filePath) {
  const expanded = expandInstructionPath(filePath);
  if (!fs.existsSync(expanded)) return "";
  return fs.readFileSync(expanded, "utf8");
}

// OPR.0.4.1.09 / R5 marker-lifecycle (foreign-content-in-marker face): the hook
// path must apply the SAME seat-check the daemon enforcer's resolvePostCompactExtra
// applies (rev1-r2 dcd95bd9), or a FOREIGN seat's global messageFilePath leaks into
// THIS seat's marker. Parse a WELL-FORMED leading `---` frontmatter for a declared
// seat (target_seat / seat / session); body text is never scanned; a broken/absent
// fence is GENERIC (valid for any seat). Byte-mirrors the enforcer regexes.
function declaredSeatOf(content) {
  const fm = /^\s*---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!fm) return null;
  const m = /^[ \t]*(?:target[_-]?seat|seat|session(?:[_-]?name)?)[ \t]*:[ \t]*["']?([^"'\n#]+?)["']?[ \t]*$/im.exec(fm[1]);
  return m ? m[1].trim() : null;
}

function sanitizeSeat(value) {
  return value.replace(/[^a-zA-Z0-9_.@-]/g, "_");
}

// Resolve the post-compaction extra FOR THIS SEAT (mirror of the enforcer): (1) prefer
// a per-seat compaction/post-compact-extra/<seat>.md — no cross-seat contamination
// possible; (2) fall back to the global ONLY when it does not declare a DIFFERENT seat
// (a wrong-seat global is REFUSED). Generic/undeclared/configured-but-absent stay
// allowed. Returns the path to read, or null when nothing valid for this seat.
function resolveSeatSafeExtraPath(globalFilePathRaw) {
  const rawSeat = process.env.OPENRIG_SESSION_NAME || process.env.RIGGED_SESSION_NAME || "";
  const seatKey = rawSeat ? sanitizeSeat(rawSeat) : "";
  if (seatKey) {
    const perSeatPath = path.join(getOpenRigHome(), "compaction", "post-compact-extra", `${seatKey}.md`);
    if (fs.existsSync(perSeatPath)) {
      const declared = declaredSeatOf(fs.readFileSync(perSeatPath, "utf8"));
      if (declared && sanitizeSeat(declared) !== seatKey) return null; // wrong-seat per-seat file
      return perSeatPath;
    }
  }
  const trimmed = (globalFilePathRaw || "").trim();
  if (!trimmed) return null;
  const expanded = expandInstructionPath(trimmed);
  // configured-but-absent: keep the path (an absent file cannot be a wrong-seat leak;
  // readInstructionFile returns "" so nothing is appended).
  if (!fs.existsSync(expanded)) return trimmed;
  const declared = declaredSeatOf(fs.readFileSync(expanded, "utf8"));
  if (declared && sanitizeSeat(declared) !== seatKey) return null; // foreign-seat global REFUSED
  return trimmed;
}

function sessionKey(input) {
  const raw = [
    process.env.OPENRIG_SESSION_NAME,
    process.env.RIGGED_SESSION_NAME,
    input.session_id,
    input.sessionId,
    input.session_name,
    input.sessionName,
    input.transcript_path ? path.basename(input.transcript_path, ".jsonl") : "",
  ].find((value) => typeof value === "string" && value.trim().length > 0) || "unknown-session";
  return raw.replace(/[^a-zA-Z0-9_.@-]/g, "_");
}

function pendingMarkerPath(input) {
  return path.join(getOpenRigHome(), "compaction", "restore-pending", `${sessionKey(input)}.json`);
}

// R5 absent-when-needed: drop a lightweight EXPECTED sentinel FIRST (before the packet is
// generated + the marker is written), carrying the SAME identity binding the marker gets.
// Its presence-without-a-marker is what lets the bridge be LOUD about a missing packet
// (hook died partway / write failed); policy off = no hook = no sentinel = silent.
// It also names this compaction's packet build from the start (packetJob), so a marker from any other build can't stand
// in for it.
function writeExpectedSentinel(input, packetJob) {
  const p = sentinelPath(input);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({
    version: 1,
    managedRefocusPending: typeof input.custom_instructions === "string"
      && input.custom_instructions.trimStart().startsWith("OpenRig managed compaction; wait for the restore request."),
    sessionName: process.env.OPENRIG_SESSION_NAME || process.env.RIGGED_SESSION_NAME || null,
    sessionId: input.session_id || input.sessionId || null,
    transcriptPath: input.transcript_path || null,
    createdAt: nowIso(),
    packetJob,
  }, null, 2)}\n`, "utf8");
}

function sentinelPath(input) {
  return path.join(getOpenRigHome(), "compaction", "restore-pending", `${sessionKey(input)}.expected.json`);
}

// The marker carries its build's jobId: the bridge delivers it only while the sentinel names that build.
function restoreMarker(input, parsed, restoreInstruction, customMessage, jobId) {
  return {
    version: 1,
    jobId,
    managedRefocusPending: typeof input.custom_instructions === "string"
      && input.custom_instructions.trimStart().startsWith("OpenRig managed compaction; wait for the restore request."),
    createdAt: nowIso(),
    sessionName: process.env.OPENRIG_SESSION_NAME || process.env.RIGGED_SESSION_NAME || null,
    sessionId: input.session_id || input.sessionId || null,
    transcriptPath: input.transcript_path || null,
    cwd: input.cwd || null,
    outputDir: parsed.outputDir,
    restoreInstruction,
    postCompactInstruction: customMessage || "",
    expectedAck: "restored from packet at <path>; resumed at step <X>",
    deliveredAt: null,
    deliveryCount: 0,
  };
}

// Slice 27 — read the OpenRig config directly (no daemon HTTP dependency
// so the hook still works when the daemon isn't running or isn't
// reachable from this process). Returns "" for either field when the
// config is missing, malformed, or the policy isn't set. If the policy is
// enabled but restore text has not been written yet, use OpenRig's default
// instruction to load the canonical restore skill. Inline instructions and
// file-path content are both included when both are configured.
function readClaudeCompactionMessage() {
  const configPath = path.join(getOpenRigHome(), "config.json");
  let inline = "";
  let filePath = "";
  let inlineConfigured = false;
  let filePathConfigured = false;
  let policyEnabled = false;
  try {
    if (!fs.existsSync(configPath)) return "";
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const policy = parsed?.policies?.claudeCompaction;
    if (policy && typeof policy === "object") {
      policyEnabled = policy.enabled === true;
      if (typeof policy.messageInline === "string") {
        inlineConfigured = true;
        inline = policy.messageInline;
      }
      if (typeof policy.messageFilePath === "string") {
        filePathConfigured = true;
        filePath = policy.messageFilePath;
      }
    }
  } catch {
    return "";
  }

  const parts = [];
  if (inline && inline.length > 0) {
    parts.push(`Inline restore instruction:\n${inline}`);
  }
  if (filePath && filePath.length > 0) {
    // R5 seat-check: resolve to the per-seat extra or a seat-safe global; a
    // foreign-seat global resolves to null and is never injected into this marker.
    const resolved = resolveSeatSafeExtraPath(filePath);
    if (resolved) {
      try {
        const fileText = readInstructionFile(resolved);
        if (fileText) {
          parts.push(`Additional restore instruction file (${resolved}):\n${fileText}`);
        }
      } catch {
        // Keep any inline instruction; unreadable extra files degrade quietly.
      }
    }
  }
  if (parts.length > 0) return parts.join("\n\n");
  if (policyEnabled && !inlineConfigured && !filePathConfigured) {
    return defaultRestoreInstruction;
  }
  return "";
}

function buildSystemMessage(restoreInstruction, customMessage) {
  if (!customMessage) return restoreInstruction;
  return `${restoreInstruction}\n\n--- Operator-configured post-compaction restore instruction ---\n${customMessage}`;
}

// --- seat project boundary: keep this block identical in every script that has it ---
// A Claude started from inside a seat (its shell, its Bash tool) inherits the seat's environment, so it loads this plugin
// and its hooks would act as the seat. OpenRig tells the plugin the seat's launch project in OPENRIG_SEAT_PROJECT_DIR;
// Claude's own CLAUDE_PROJECT_DIR is fixed for the life of a Claude and names the project it was started in (unlike the
// hook payload's cwd, which follows a `cd`). The seat's effects run only when the two name the same folder. Spellings of
// one folder (a symlink, a trailing slash, letter case on a case-insensitive disk) count as the same, and a missing
// variable (an older or manual launch, a runtime without CLAUDE_PROJECT_DIR) leaves the hook doing what it always did.
function runsForThisSeatsProject(env = process.env) {
  const launch = env.OPENRIG_SEAT_PROJECT_DIR;
  const project = env.CLAUDE_PROJECT_DIR;
  if (!launch || !project) return true;
  const canonical = (dir) => {
    const absolute = path.resolve(dir);
    // .native gives the case the disk has (plain realpathSync keeps the case the path was typed in), which is what Claude's
    // CLAUDE_PROJECT_DIR carries on a case-insensitive filesystem such as macOS's default.
    try { return fs.realpathSync.native(absolute); } catch { return absolute; }
  };
  return canonical(launch) === canonical(project);
}
// --- end seat project boundary ---

// A Claude started elsewhere inside this seat is not the seat: no packet, no marker.
if (!runsForThisSeatsProject()) process.exit(0);

function restoreText(outputDir) {
  return `Pre-compaction restore seed packet prepared at ${outputDir}. This hook output is informational. After compaction, OpenRig may send a later normal user message asking you to restore from this packet; treat that later normal user message as the action request. The restore protocol is: load/read the claude-compaction-restore skill, run "node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs --out /tmp/claude-compaction-restore --json" yourself when needed, read the generated restore-instructions.md, read the generated touched-files.md, identify remembered important files, read those files in full, read root/as-built/codemap docs before real work, then reply with "restored from packet at <path>; resumed at step <X>" with the files you read in full. If any step fails, report the failure explicitly.`;
}

function failureText(reason) {
  return `Claude compaction restore packet generation failed: ${reason}. After compaction, load the claude-compaction-restore skill and run restore-from-jsonl manually.`;
}

// Each packet build has its own job, result and reported-status files, named by its jobId, so builds for one seat never
// read, replace or remove each other's. The hook writes the job; the finisher writes the result and removes its own job;
// the bridge writes which status it last reported. Results stay behind, a few KB each.
function packetJobPaths(input, jobId) {
  const base = path.join(getOpenRigHome(), "compaction", "packet-jobs", `${sessionKey(input)}.${jobId}`);
  return { jobPath: `${base}.job.json`, resultPath: `${base}.result.json`, reportPath: `${base}.reported.json` };
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function readResult(resultPath, jobId) {
  try {
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    return result.jobId === jobId ? result : null;
  } catch { return null; }
}

function recordPacketJob(input, packetJob) {
  const p = sentinelPath(input);
  try {
    const sentinel = JSON.parse(fs.readFileSync(p, "utf8"));
    // Only into this build's sentinel: an overlapping hook for the seat may have written its own since.
    if (sentinel.packetJob?.jobId !== packetJob.jobId) return;
    writeJsonAtomic(p, { ...sentinel, packetJob });
  } catch { /* the sentinel is written first; without it the bridge stays as it was */ }
}

// The seat's marker from an earlier compaction moves aside as superseded, its bytes kept. Every reader of the marker file
// (the bridge, the restore request's instruction to the agent, the rebuild priming chain, refocus) then takes its missing-marker
// route until this build publishes, instead of finding the earlier packet.
function supersedeEarlierMarker(input) {
  const markerPath = pendingMarkerPath(input);
  try { fs.renameSync(markerPath, markerPath.replace(/\.json$/, ".superseded.json")); } catch { /* no earlier marker */ }
}

function isCurrentJob(input, jobId) {
  try { return JSON.parse(fs.readFileSync(sentinelPath(input), "utf8")).packetJob?.jobId === jobId; } catch { return false; }
}

// --finish <job>: the detached packet build. It has no time limit. Its result records the outcome either way, and on
// success carries the marker. It publishes that marker only while the seat's sentinel still names this build; a later
// compaction's build owns the marker otherwise, and the bridge reads the current build's own result if this one wins a
// late write anyway.
function runFinisher(jobPath) {
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  const result = spawnSync(process.execPath, job.args, { encoding: "utf8" });
  let outcome;
  if (result.status === 0) {
    try {
      const parsed = JSON.parse(result.stdout);
      const marker = restoreMarker(job.input, parsed, restoreText(parsed.outputDir), job.customMessage, job.jobId);
      const markerPath = pendingMarkerPath(job.input);
      const published = isCurrentJob(job.input, job.jobId);
      if (published) writeJsonAtomic(markerPath, marker);
      outcome = { ok: true, outputDir: parsed.outputDir, markerPath, published, marker };
    } catch (error) {
      outcome = { ok: false, reason: error.message };
    }
  } else {
    outcome = { ok: false, reason: (result.error?.message || result.stderr || result.stdout || "unknown error").trim() };
  }
  writeJsonAtomic(job.resultPath, { jobId: job.jobId, ...outcome, endedAt: nowIso() });
  fs.rmSync(jobPath, { force: true });
}

if (process.argv[2] === "--finish") {
  try { runFinisher(process.argv[3]); } catch { /* the bridge reports a finisher that ended without a result */ }
  process.exit(0);
}

try {
  // Slice 51-01 RIDER (leak-visibility, review-r1 escalation): OPENRIG_TEST_CLOCK_NOW is
  // read by nowIso() to make createdAt deterministic in tests — but a LEAKED var in a
  // real seat would silently FREEZE production createdAt. Announce loudly on stderr when
  // active so any leak is visible in seat logs; absence stays silent (production path).
  // MUST stay byte-identical to STUB_CLOCK_ANNOUNCEMENT in stub-runner.ts.
  if (typeof process.env.OPENRIG_TEST_CLOCK_NOW === "string" && process.env.OPENRIG_TEST_CLOCK_NOW.trim().length > 0) {
    process.stderr.write("OPENRIG_TEST_CLOCK_NOW active — timestamps are injected\n");
  }
  const input = readHookInput();
  const jobId = randomUUID();
  const { jobPath, resultPath, reportPath } = packetJobPaths(input, jobId);
  writeExpectedSentinel(input, { jobId, resultPath, reportPath }); // R5: sentinel FIRST, before the packet + marker (catches hook-died-partway)
  supersedeEarlierMarker(input);
  const args = [restoreScript, "--out", outRoot, "--json"];
  if (input.cwd) args.push("--cwd", input.cwd);
  if (input.transcript_path && input.transcript_path.endsWith(".jsonl") && fs.existsSync(input.transcript_path)) {
    // The transcript as it stands now: compaction appends to it once this hook returns, and the packet is of what came
    // before.
    args.push("--until-byte", String(fs.statSync(input.transcript_path).size), input.transcript_path);
    if (fs.statSync(input.transcript_path).size > TAIL_BYTES) args.push("--tail-bytes", String(TAIL_BYTES));
  }

  const customMessage = readClaudeCompactionMessage();

  writeJsonAtomic(jobPath, { jobId, input, args, customMessage, resultPath });
  const finisher = spawn(process.execPath, [fileURLToPath(import.meta.url), "--finish", jobPath], { detached: true, stdio: "ignore" });
  finisher.unref();
  const startedAt = nowIso();
  recordPacketJob(input, { jobId, pid: finisher.pid ?? null, resultPath, reportPath, startedAt });

  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + restoreTimeoutMs;
  let result = readResult(resultPath, jobId);
  while (!result && Date.now() < deadline) {
    Atomics.wait(sleeper, 0, 0, Math.min(100, Math.max(1, deadline - Date.now())));
    result = readResult(resultPath, jobId);
  }

  if (!result) {
    const markerPath = pendingMarkerPath(input);
    emit({
      continue: true,
      systemMessage: buildSystemMessage(`Claude compaction restore packet is still being built: the transcript takes longer than the PreCompact hook's ${restoreTimeoutMs / 1000}-second wait. A background process (pid ${finisher.pid ?? "unknown"}, started ${startedAt}) finishes it and then writes the pending restore marker at ${markerPath}, which the restore picks up. If no marker appears, load the claude-compaction-restore skill and run restore-from-jsonl manually.`, customMessage),
    });
    process.exit(0);
  }
  if (!result.ok) {
    emit({ continue: true, systemMessage: buildSystemMessage(failureText(result.reason), customMessage) });
    process.exit(0);
  }
  emit({
    continue: true,
    systemMessage: buildSystemMessage(`${restoreText(result.outputDir)} OpenRig also wrote a pending restore marker at ${result.markerPath}.`, customMessage),
  });
} catch (error) {
  emit({
    continue: true,
    systemMessage: `Claude compaction restore hook errored: ${error.message}. After compaction, load the claude-compaction-restore skill and run restore-from-jsonl manually.`,
  });
}
