#!/usr/bin/env node
"use strict";

// OpenRig Claude compaction restore bridge (reader/deliverer).
//
// The per-seat pending marker is WRITTEN on PreCompact by the product-plugin
// writer skills/claude-compaction-restore/scripts/precompact-hook.mjs (which
// generates the restore packet and persists the real outputDir + operator
// message). This bridge READS that marker on SessionStart (matcher=compact)
// and UserPromptSubmit and injects ONE restore directive into Claude context
// via hookSpecificOutput.additionalContext. PostCompact is a cheap marker
// timestamp hook. OPR.0.4.1.09: resolve ONLY this seat's marker (never deliver
// another seat's restore state) and surface the per-seat restore-map pointer.

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

// A3-R3 injectable clock (slice 51-01): the marker stamps below default to real
// wall-clock, but become deterministic when the shared hermetic env-var
// OPENRIG_TEST_CLOCK_NOW is set (an ISO instant). An empty/absent var = production
// real-time (absence is the production state — the only unguarded path, on purpose).
function nowIso(env = process.env) {
  const injected = env.OPENRIG_TEST_CLOCK_NOW;
  return typeof injected === "string" && injected.trim().length > 0 ? injected : new Date().toISOString();
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
  // OPR.0.4.1.09 (never deliver wrong-seat state): resolve ONLY this seat's keyed marker.
  // The previous fallback-to-newest handed a seat with NO marker the NEWEST marker on
  // disk - which can be ANOTHER seat's (the reader-side parallel of the part-1 extra bug).
  // No seat identity -> no marker; absence -> the loud JSONL fallback the restore prompt
  // already describes, NEVER a wrong-seat guess.
  const key = sessionKey(payload, env);
  if (!key) return null;
  const marker = readMarker(path.join(markerDir(env), `${key}.json`));
  if (!marker) return null;
  // Defense-in-depth: refuse a keyed marker that DECLARES a different seat.
  const declaredName = marker.data && typeof marker.data.sessionName === "string"
    ? marker.data.sessionName.trim()
    : "";
  if (declaredName && sanitizeKey(declaredName) !== key) return null;
  return marker;
}

function writeMarker(marker) {
  fs.writeFileSync(marker.filePath, `${JSON.stringify(marker.data, null, 2)}\n`, "utf8");
}

function buildRestoreContext(marker) {
  const outputDir = firstString(marker.data.outputDir) || "/tmp/claude-compaction-restore";
  const ack = firstString(marker.data.expectedAck) || "restored from packet at <path>; resumed at step <X>";
  const postInstruction = firstString(marker.data.postCompactInstruction);
  const restoreMapPath = firstString(marker.data.restoreMapPath);
  const pieces = [
    "OpenRig compaction restore packet is available for this Claude session.",
    "This hook output is informational context, not the action request.",
    `Restore packet: ${outputDir}`,
    "OpenRig may send a later normal user message asking you to restore from this packet. Treat that later normal user message as the operator-authorized action request.",
    `After restoration, reply with: ${ack}`,
  ];
  if (restoreMapPath) {
    // OPR.0.4.1.09: the per-seat restore-map pointer the marker carries.
    pieces.push(`Per-seat restore map: ${restoreMapPath} — read it during restore.`);
  }
  if (postInstruction) {
    pieces.push(`Operator post-compaction context: ${postInstruction}`);
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
    marker.data.postCompactAt = nowIso();
    writeMarker(marker);
    return;
  }

  if (marker.data.deliveryCount && marker.data.deliveryCount > 0) {
    return;
  }

  marker.data.deliveredAt = nowIso();
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
