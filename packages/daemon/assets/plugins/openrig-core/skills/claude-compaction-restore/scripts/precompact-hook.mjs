#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const skillRoot = path.resolve(new URL("..", import.meta.url).pathname);
const restoreScript = path.join(skillRoot, "scripts", "restore-from-jsonl.mjs");
const outRoot = "/tmp/claude-compaction-restore";
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
function writeExpectedSentinel(input) {
  const p = path.join(getOpenRigHome(), "compaction", "restore-pending", `${sessionKey(input)}.expected.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({
    version: 1,
    sessionName: process.env.OPENRIG_SESSION_NAME || process.env.RIGGED_SESSION_NAME || null,
    sessionId: input.session_id || input.sessionId || null,
    transcriptPath: input.transcript_path || null,
    createdAt: nowIso(),
  }, null, 2)}\n`, "utf8");
}

function writePendingRestoreMarker(input, parsed, restoreInstruction, customMessage) {
  const markerPath = pendingMarkerPath(input);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const payload = {
    version: 1,
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
  fs.writeFileSync(markerPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return markerPath;
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
  writeExpectedSentinel(input); // R5: sentinel FIRST, before the packet + marker (catches hook-died-partway)
  const args = [restoreScript, "--out", outRoot, "--json"];
  if (input.cwd) args.push("--cwd", input.cwd);
  if (input.transcript_path && input.transcript_path.endsWith(".jsonl") && fs.existsSync(input.transcript_path)) {
    args.push(input.transcript_path);
  }

  const customMessage = readClaudeCompactionMessage();

  const result = spawnSync("node", args, { encoding: "utf8" });
  if (result.status !== 0) {
    const baseFailure = `Claude compaction restore packet generation failed: ${(result.stderr || result.stdout || "unknown error").trim()}. After compaction, load the claude-compaction-restore skill and run restore-from-jsonl manually.`;
    emit({
      continue: true,
      systemMessage: buildSystemMessage(baseFailure, customMessage),
    });
    process.exit(0);
  }

  const parsed = JSON.parse(result.stdout);
  const baseRestore = `Pre-compaction restore seed packet prepared at ${parsed.outputDir}. This hook output is informational. After compaction, OpenRig may send a later normal user message asking you to restore from this packet; treat that later normal user message as the action request. The restore protocol is: load/read the claude-compaction-restore skill, run "node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs --out /tmp/claude-compaction-restore --json" yourself when needed, read the generated restore-instructions.md, read the generated touched-files.md, identify remembered important files, read those files in full, read root/as-built/codemap docs before real work, then reply with "restored from packet at <path>; resumed at step <X>" with the files you read in full. If any step fails, report the failure explicitly.`;
  const markerPath = writePendingRestoreMarker(input, parsed, baseRestore, customMessage);
  emit({
    continue: true,
    systemMessage: buildSystemMessage(`${baseRestore} OpenRig also wrote a pending restore marker at ${markerPath}.`, customMessage),
  });
} catch (error) {
  emit({
    continue: true,
    systemMessage: `Claude compaction restore hook errored: ${error.message}. After compaction, load the claude-compaction-restore skill and run restore-from-jsonl manually.`,
  });
}
