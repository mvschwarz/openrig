"use strict";

// Codex's hook trust identity: the key and hash Codex records for a hook it has trusted.
//
// The recipe reproduces Codex's (codex-rs hooks/src/engine/discovery.rs hook_hash at rust-v0.163.0): the normalized
// identity { event_name: <snake_case label>, matcher?, hooks: [<normalized handler>] }, with absent fields dropped, keys
// sorted recursively, compact JSON, then "sha256:" + hex. The daemon's trust writer for its own managed activity hooks uses
// it (codex-runtime-adapter.ts, computeCodexHookTrust). It needs no packages.

const crypto = require("node:crypto");

const EVENT_LABELS = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "stop",
  PostCompact: "post_compact",
  PermissionRequest: "permission_request",
};

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** Codex's trust hash for one command handler, from every field Codex folds into it. */
function codexHookHash(eventLabel, handler) {
  const normalized = { type: "command", command: handler.command, timeout: handler.timeoutSec, async: handler.async === true };
  if (handler.statusMessage != null) normalized.statusMessage = handler.statusMessage;
  if (handler.additionalContextLimit != null) normalized.additionalContextLimit = handler.additionalContextLimit;
  const identity = { event_name: eventLabel, hooks: [normalized] };
  if (handler.matcher != null) identity.matcher = handler.matcher;
  const hex = crypto.createHash("sha256").update(JSON.stringify(sortKeys(identity)), "utf8").digest("hex");
  return `sha256:${hex}`;
}

/** Codex's persisted trust key and hash for one hook, at its position in the config layer. */
function computeCodexHookTrust(event, input) {
  const label = EVENT_LABELS[event];
  if (!label) throw new Error(`no Codex hook label for ${event}`);
  const key = `${input.keySource}:${label}:${input.groupIndex ?? 0}:${input.handlerIndex ?? 0}`;
  return { key, hash: codexHookHash(label, input) };
}

module.exports = { EVENT_LABELS, codexHookHash, computeCodexHookTrust };
