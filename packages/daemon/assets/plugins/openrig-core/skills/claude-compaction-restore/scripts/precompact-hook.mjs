#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const skillRoot = path.resolve(new URL("..", import.meta.url).pathname);
const restoreScript = path.join(skillRoot, "scripts", "restore-from-jsonl.mjs");
const outRoot = "/tmp/claude-compaction-restore";

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

// Slice 27 — read the OpenRig config directly (no daemon HTTP dependency
// so the hook still works when the daemon isn't running or isn't
// reachable from this process). Returns "" for either field when the
// config is missing, malformed, or the policy isn't set.
function readClaudeCompactionMessage() {
  const configPath = path.join(
    process.env.OPENRIG_HOME || process.env.RIGGED_HOME || path.join(os.homedir(), ".openrig"),
    "config.json",
  );
  let inline = "";
  let filePath = "";
  try {
    if (!fs.existsSync(configPath)) return "";
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const policy = parsed?.policies?.claudeCompaction;
    if (policy && typeof policy === "object") {
      if (typeof policy.messageInline === "string") inline = policy.messageInline;
      if (typeof policy.messageFilePath === "string") filePath = policy.messageFilePath;
    }
  } catch {
    return "";
  }

  if (inline && inline.length > 0) return inline;
  if (filePath && filePath.length > 0) {
    try {
      const expanded = filePath.startsWith("~/")
        ? path.join(os.homedir(), filePath.slice(2))
        : filePath;
      if (fs.existsSync(expanded)) {
        return fs.readFileSync(expanded, "utf8");
      }
    } catch {
      return "";
    }
  }
  return "";
}

function buildSystemMessage(restoreInstruction, customMessage) {
  if (!customMessage) return restoreInstruction;
  return `${restoreInstruction}\n\n--- Operator-configured pre-compaction message ---\n${customMessage}`;
}

try {
  const input = readHookInput();
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
  const baseRestore = `Pre-compaction restore seed packet prepared at ${parsed.outputDir}. After compaction, immediately restore before doing any other work: load/read the claude-compaction-restore skill, run "node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs --out /tmp/claude-compaction-restore --json" yourself, read the generated restore-instructions.md, read the generated touched-files.md, identify remembered important files, read those files in full, read root/as-built/codemap docs before real work, then report exactly "restored from packet at <path>; resumed at step <X>" with the files you read in full. If any step fails, report the failure explicitly.`;
  emit({
    continue: true,
    systemMessage: buildSystemMessage(baseRestore, customMessage),
  });
} catch (error) {
  emit({
    continue: true,
    systemMessage: `Claude compaction restore hook errored: ${error.message}. After compaction, load the claude-compaction-restore skill and run restore-from-jsonl manually.`,
  });
}
