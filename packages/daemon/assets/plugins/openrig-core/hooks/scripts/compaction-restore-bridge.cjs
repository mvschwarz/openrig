#!/usr/bin/env node
"use strict";

// OpenRig Claude compaction restore bridge.
//
// PreCompact writes a pending marker under OPENRIG_HOME. SessionStart
// (matcher=compact) and UserPromptSubmit can then inject one restore
// directive into Claude context via hookSpecificOutput.additionalContext.
// PostCompact uses the same script as a cheap marker timestamp hook.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function openrigHome(env = process.env) {
  return firstString(env.OPENRIG_HOME, env.RIGGED_HOME) || path.join(os.homedir(), ".openrig");
}

function sanitizeKey(value) {
  return value.replace(/[^a-zA-Z0-9_.@-]/g, "_");
}

function sessionKey(payload, env = process.env) {
  const raw = firstString(
    env.OPENRIG_SESSION_NAME,
    env.RIGGED_SESSION_NAME,
    payload.session_id,
    payload.sessionId,
    payload.session_name,
    payload.sessionName,
    payload.transcript_path ? path.basename(payload.transcript_path, ".jsonl") : null,
  );
  return raw ? sanitizeKey(raw) : null;
}

function markerDir(env = process.env) {
  return path.join(openrigHome(env), "compaction", "restore-pending");
}

function readMarker(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return { filePath, data: parsed };
  } catch {
    return null;
  }
}

function findMarker(payload, env = process.env) {
  const dir = markerDir(env);
  const key = sessionKey(payload, env);
  if (key) {
    const direct = readMarker(path.join(dir, `${key}.json`));
    if (direct) return direct;
  }
  try {
    const candidates = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name))
      .map((filePath) => ({ filePath, stat: fs.statSync(filePath) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const candidate of candidates) {
      const marker = readMarker(candidate.filePath);
      if (marker) return marker;
    }
  } catch {
    return null;
  }
  return null;
}

function writeMarker(marker) {
  fs.writeFileSync(marker.filePath, `${JSON.stringify(marker.data, null, 2)}\n`, "utf8");
}

function buildRestoreContext(marker) {
  const outputDir = firstString(marker.data.outputDir) || "/tmp/claude-compaction-restore";
  const ack = firstString(marker.data.expectedAck) || "restored from packet at <path>; resumed at step <X>";
  const postInstruction = firstString(marker.data.postCompactInstruction);
  const pieces = [
    "OpenRig compaction restore is pending for this Claude session.",
    `Restore packet: ${outputDir}`,
    "Before doing any substantive work, load/read the claude-compaction-restore skill, run `node ~/.claude/skills/claude-compaction-restore/scripts/restore-from-jsonl.mjs --out /tmp/claude-compaction-restore --json`, read restore-instructions.md and touched-files.md, then read the important source/docs files named there in full.",
    `After restoration, report exactly: ${ack}`,
  ];
  if (postInstruction) {
    pieces.push(`Operator post-compaction instruction: ${postInstruction}`);
  }
  return pieces.join("\n");
}

function hookEventName(payload) {
  return firstString(
    payload.hook_event_name,
    payload.hookEventName,
    payload.hookEvent,
    payload.event_name,
    payload.eventName,
    payload.event,
  ) || "UserPromptSubmit";
}

async function main() {
  const payload = parseJson(await readStdin());
  const eventName = hookEventName(payload);
  const marker = findMarker(payload);
  if (!marker) return;

  marker.data.lastBridgeEvent = eventName;
  if (eventName === "PostCompact") {
    marker.data.postCompactAt = new Date().toISOString();
    writeMarker(marker);
    return;
  }

  if (marker.data.deliveryCount && marker.data.deliveryCount > 0) {
    return;
  }

  marker.data.deliveredAt = new Date().toISOString();
  marker.data.deliveryCount = Number(marker.data.deliveryCount || 0) + 1;
  writeMarker(marker);

  process.stdout.write(`${JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: buildRestoreContext(marker),
    },
  })}\n`);
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = {
  buildRestoreContext,
  findMarker,
  hookEventName,
  parseJson,
};
