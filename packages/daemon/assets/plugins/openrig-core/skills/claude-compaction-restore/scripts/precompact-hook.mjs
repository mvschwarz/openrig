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

function sanitizeKey(value) {
  return value.replace(/[^a-zA-Z0-9_.@-]/g, "_");
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
  return sanitizeKey(raw);
}

// OPR.0.4.1.09 (rev1-r2 hook-path leak fix): MUST match claude-compaction-enforcer.ts
// declaredSeatOf EXACTLY — a seat is authoritative ONLY inside a WELL-FORMED leading
// frontmatter fence (opened AND closed `---`); the body is NEVER scanned; malformed/absent
// frontmatter -> null (generic). Duplicated (not imported) because this hook is a standalone
// portable plugin asset that cannot import the compiled daemon TS; semantics are kept
// identical so the enforcer and hook paths refuse wrong-seat extras the same way.
function declaredSeatOf(content) {
  const fm = /^\s*---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!fm) return null;
  const m = /^[ \t]*(?:target[_-]?seat|seat|session(?:[_-]?name)?)[ \t]*:[ \t]*["']?([^"'\n#]+?)["']?[ \t]*$/im.exec(fm[1]);
  return m ? m[1].trim() : null;
}

// OPR.0.4.1.09 (rev1-r2): resolve the seat-safe EXTRA-FILE CONTENT for
// postCompactInstruction, mirroring the enforcer resolvePostCompactExtra: (1) prefer the
// PER-SEAT extra post-compact-extra/<seat>.md; (2) else the GLOBAL messageFilePath. In
// EITHER case a file whose WELL-FORMED frontmatter declares a DIFFERENT seat is REFUSED
// (returns "") so a foreign-seat extra never leaks into the marker via the hook path
// (the enforcer path already refused it). Generic/this-seat/malformed -> inject.
function readSeatSafeExtraFile(input, globalFilePath) {
  const seatKey = sessionKey(input);
  const refusedIfForeign = (content) => {
    const declared = declaredSeatOf(content);
    return declared && sanitizeKey(declared) !== seatKey ? "" : content;
  };
  // 1. Per-seat extra preferred (seat-keyed path; still defensively seat-checked to match
  //    the enforcer, which refuses a per-seat file declaring a different seat).
  const perSeatPath = path.join(getOpenRigHome(), "compaction", "post-compact-extra", `${seatKey}.md`);
  if (fs.existsSync(perSeatPath)) {
    return refusedIfForeign(fs.readFileSync(perSeatPath, "utf8"));
  }
  // 2. Global messageFilePath fallback, seat-checked.
  if (!globalFilePath) return "";
  const content = readInstructionFile(globalFilePath);
  if (!content) return "";
  return refusedIfForeign(content);
}

function pendingMarkerPath(input) {
  return path.join(getOpenRigHome(), "compaction", "restore-pending", `${sessionKey(input)}.json`);
}

// OPR.0.4.1.09: pointer to this seat's per-seat post-compaction extra
// (compaction/post-compact-extra/<seat>.md), surfaced by the bridge reader.
// Returned ONLY when it EXISTS, so the marker never points at an unresolvable
// restoreMapPath; null otherwise.
function perSeatRestoreMapPath(input) {
  const p = path.join(getOpenRigHome(), "compaction", "post-compact-extra", `${sessionKey(input)}.md`);
  try {
    fs.accessSync(p);
    return p;
  } catch {
    return null;
  }
}

function writePendingRestoreMarker(input, parsed, restoreInstruction, customMessage) {
  const markerPath = pendingMarkerPath(input);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
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
    // OPR.0.4.1.09: per-seat restore-map pointer (post-compact-extra/<seat>.md) or null.
    restoreMapPath: perSeatRestoreMapPath(input),
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
function readClaudeCompactionMessage(input) {
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
    // Inline has no file/seat to declare; keep as-is.
    parts.push(`Inline restore instruction:\n${inline}`);
  }
  // OPR.0.4.1.09 (rev1-r2): the FILE portion is SEAT-SAFE — per-seat extra preferred, a
  // foreign-seat global refused (mirrors the enforcer). Checked even when messageFilePath
  // is unset, because the per-seat extra is an independent mechanism (the enforcer also
  // checks the per-seat path regardless of the global config).
  try {
    const fileText = readSeatSafeExtraFile(input, filePath);
    if (fileText) {
      parts.push(`Additional restore instruction file:\n${fileText}`);
    }
  } catch {
    // Keep any inline instruction; unreadable extra files degrade quietly.
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
  const input = readHookInput();
  const args = [restoreScript, "--out", outRoot, "--json"];
  if (input.cwd) args.push("--cwd", input.cwd);
  if (input.transcript_path && input.transcript_path.endsWith(".jsonl") && fs.existsSync(input.transcript_path)) {
    args.push(input.transcript_path);
  }

  const customMessage = readClaudeCompactionMessage(input);

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
