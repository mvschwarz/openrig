"use strict";

// Codex's hook trust identity, and whether Codex would run the daemon's own managed activity relay for an event.
//
// The daemon writes one managed block of four inline relay hooks into the Codex config.toml it uses
// (codex-runtime-adapter.ts, upsertCodexActivityHooks). The openrig-core plugin carries the same relay for Codex. When a
// seat loads both, the plugin's run stays quiet only if this file finds evidence that Codex would run the managed handler
// for the same event. Anything it can't establish reports, so an event is reported at worst twice, never not at all.
//
// The trust recipe reproduces Codex's (codex-rs hooks/src/engine/discovery.rs hook_hash at rust-v0.163.0): the
// normalized identity { event_name: <snake_case label>, matcher?, hooks: [<normalized handler>] }, with absent fields
// dropped, keys sorted recursively, compact JSON, then "sha256:" + hex. Nothing here writes a hash: it only compares.
// It needs no packages, because it also runs from Codex's installed copy of the plugin.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EVENT_LABELS = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "stop",
  PermissionRequest: "permission_request",
};
const MANAGED_BEGIN = "# BEGIN OPENRIG MANAGED ACTIVITY HOOKS";
const MANAGED_END = "# END OPENRIG MANAGED ACTIVITY HOOKS";
// The timeout the daemon writes for each managed relay hook.
const MANAGED_TIMEOUT_SEC = 5;

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

function codexConfigPath(env) {
  const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
  return path.join(home, "config.toml");
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The managed stanza for `event`, as the daemon writes it: exactly `node "<absolute relay>"`, timeout 5, no matcher. */
function managedStanza(block, event) {
  const pattern = new RegExp(
    `^\\[\\[hooks\\.${event}\\]\\]\\n\\[\\[hooks\\.${event}\\.hooks\\]\\]\\ntype = "command"\\n`
      + `command = '(node "([^"'\\n]+)")'\\ntimeout = ${MANAGED_TIMEOUT_SEC}$`,
    "m",
  );
  const found = pattern.exec(block);
  if (!found || !path.isAbsolute(found[2])) return null;
  return { command: found[1], relay: found[2] };
}

/** The `[hooks.state."<key>"]` table's enabled and trusted_hash, or null when the key appears in any other form. */
function hookState(content, key) {
  const quoted = JSON.stringify(key);
  const header = `[hooks.state.${quoted}]`;
  const lines = content.split("\n");
  const at = lines.findIndex((line) => line.trim() === header);
  // The key anywhere else (an inline table, a dotted key, a second header) is a form this reader doesn't evaluate.
  const mentions = content.split(quoted).length - 1;
  if (at === -1) return mentions === 0 ? { enabled: undefined, trustedHash: undefined } : null;
  if (mentions !== 1) return null;
  const state = { enabled: undefined, trustedHash: undefined };
  for (const line of lines.slice(at + 1)) {
    const text = line.trim();
    if (text.startsWith("[")) break;
    let m;
    if ((m = /^enabled\s*=\s*(true|false)\s*(#.*)?$/.exec(text))) state.enabled = m[1] === "true";
    else if ((m = /^trusted_hash\s*=\s*"(sha256:[0-9a-f]{64})"\s*(#.*)?$/.exec(text))) state.trustedHash = m[1];
    else if (text !== "" && !text.startsWith("#")) return null;
  }
  return state;
}

/**
 * Whether Codex would run the daemon's managed relay for `event` in this session, with the reason. True only when every
 * condition holds: the managed block has this event's stanza, naming a relay that `isThisScript` accepts; no other hook
 * group for the event precedes it in the file (so its trust key is <config>:<label>:0:0); its state is not disabled; its
 * stored trusted_hash equals Codex's hash of that exact handler; and the bare `node` it runs resolves on this PATH.
 */
function managedRelayWouldRun(event, env, deps) {
  const label = EVENT_LABELS[event];
  if (!label) return { runs: false, reason: "not a managed relay event" };
  const configPath = codexConfigPath(env);
  let content;
  try { content = fs.readFileSync(configPath, "utf8"); } catch { return { runs: false, reason: "no readable Codex config" }; }
  const begin = content.indexOf(MANAGED_BEGIN);
  const end = content.indexOf(MANAGED_END);
  if (begin === -1 || end < begin || content.indexOf(MANAGED_BEGIN, begin + 1) !== -1) {
    return { runs: false, reason: "no single managed relay block" };
  }
  const block = content.slice(begin, end);
  const stanza = managedStanza(block, event);
  if (!stanza) return { runs: false, reason: "no managed stanza for this event in the daemon's form" };
  // Any other mention of the event outside the block could be a hook group that shifts the managed one's position.
  const outside = content.slice(0, begin) + content.slice(end);
  if (new RegExp(`\\b${escapeRegExp(event)}\\b`).test(outside)) return { runs: false, reason: "another hook group may precede it" };
  if (!deps.isThisScript(stanza.relay)) return { runs: false, reason: "the managed relay is a different script" };
  let keySource = configPath;
  try { keySource = fs.realpathSync.native(configPath); } catch { /* the plain path, as the daemon falls back to */ }
  const { key, hash } = computeCodexHookTrust(event, { keySource, command: stanza.command, timeoutSec: MANAGED_TIMEOUT_SEC });
  const state = hookState(content, key);
  if (!state) return { runs: false, reason: "its hook state is in a form this check doesn't read" };
  if (state.enabled === false) return { runs: false, reason: "disabled" };
  if (state.trustedHash === undefined) return { runs: false, reason: "untrusted" };
  if (state.trustedHash !== hash) return { runs: false, reason: "modified since it was trusted" };
  if (!deps.interpreterAvailable("node", env)) return { runs: false, reason: "node does not resolve on this PATH" };
  return { runs: true, reason: "enabled and trusted" };
}

module.exports = { EVENT_LABELS, codexHookHash, computeCodexHookTrust, managedRelayWouldRun, MANAGED_BEGIN, MANAGED_END };
