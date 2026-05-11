#!/usr/bin/env node
import fs from "node:fs";
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

try {
  const input = readHookInput();
  const args = [restoreScript, "--out", outRoot, "--json"];
  if (input.cwd) args.push("--cwd", input.cwd);
  if (input.transcript_path && input.transcript_path.endsWith(".jsonl") && fs.existsSync(input.transcript_path)) {
    args.push(input.transcript_path);
  }

  const result = spawnSync("node", args, { encoding: "utf8" });
  if (result.status !== 0) {
    emit({
      continue: true,
      systemMessage: `Claude compaction restore packet generation failed: ${(result.stderr || result.stdout || "unknown error").trim()}. After compaction, load the claude-compaction-restore skill and run restore-from-jsonl manually.`,
    });
    process.exit(0);
  }

  const parsed = JSON.parse(result.stdout);
  emit({
    continue: true,
    systemMessage: `Pre-compaction restore seed packet prepared at ${parsed.outputDir}. After compaction, immediately restore before doing any other work: load/read the claude-compaction-restore skill, run "node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs --out /tmp/claude-compaction-restore --json" yourself, read the generated restore-instructions.md, read the generated touched-files.md, identify remembered important files, read those files in full, read root/as-built/codemap docs before real work, then report exactly "restored from packet at <path>; resumed at step <X>" with the files you read in full. If any step fails, report the failure explicitly.`,
  });
} catch (error) {
  emit({
    continue: true,
    systemMessage: `Claude compaction restore hook errored: ${error.message}. After compaction, load the claude-compaction-restore skill and run restore-from-jsonl manually.`,
  });
}
