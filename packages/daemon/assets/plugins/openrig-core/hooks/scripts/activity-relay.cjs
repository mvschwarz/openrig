#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// OpenRig activity-relay hook script.
// Reads a hook event payload from stdin, normalizes it, and POSTs to the
// OpenRig daemon's /api/activity/hooks endpoint for real-time UI seat-status.
// Best-effort only: 1.5s timeout, errors swallowed, never blocks the agent loop.
//
// Required environment (injected by the OpenRig daemon when launching the agent):
//   OPENRIG_SESSION_NAME or RIGGED_SESSION_NAME  - tmux session id
//   OPENRIG_NODE_ID      or RIGGED_NODE_ID       - node id in the rig topology
//   OPENRIG_RUNTIME      or RIGGED_RUNTIME       - "claude-code" | "codex" | etc.
//   OPENRIG_URL          or RIGGED_URL           - daemon base URL
//   OPENRIG_ACTIVITY_HOOK_TOKEN or RIGGED_ACTIVITY_HOOK_TOKEN - bearer auth

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

// The route this run reports by, so the daemon can count one event once per route: "plugin" for the plugin's hook
// (started with --from-plugin), "managed" for the settings or managed hook copy.
function buildOpenRigPayload(providerPayload, env = process.env, now = () => new Date(), argv = process.argv) {
  const sessionName = firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME);
  const nodeId = firstString(env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID);
  const runtime = firstString(env.OPENRIG_RUNTIME, env.RIGGED_RUNTIME);
  const generation = firstString(env.OPENRIG_OCCUPANT_GENERATION, env.RIGGED_OCCUPANT_GENERATION);
  const hookEvent = firstString(
    providerPayload.hookEvent,
    providerPayload.hookEventName,
    providerPayload.hook_event_name,
    providerPayload.event,
    providerPayload.eventName
  );

  if ((!sessionName && !nodeId) || !runtime || !hookEvent) return null;

  const subtype = firstString(
    providerPayload.subtype,
    providerPayload.notification_type,
    providerPayload.notificationType,
    providerPayload.tool_name,
    providerPayload.toolName,
    providerPayload.source,
    providerPayload.matcher
  );

  return {
    sessionName,
    nodeId,
    runtime,
    generation,
    hookEvent,
    subtype,
    turnId: firstString(providerPayload.turn_id, providerPayload.turnId),
    occurredAt: now().toISOString(),
    relayRoute: argv.includes("--from-plugin") ? "plugin" : "managed",
  };
}

// OPR.0.4.3.28 B1+B3 — resolve the ingest base URL + token without depending on
// the operator seeding OPENRIG_URL/OPENRIG_ACTIVITY_HOOK_TOKEN into the shell:
//   1. env OPENRIG_URL / token (unchanged fast path).
//   2. B1: synthesize the base URL from OPENRIG_HOST + OPENRIG_PORT (both present
//      in a launched seat's env) when the URL is absent.
//   3. B3: file-discovery — read {baseUrl, token} from
//      OPENRIG_HOME/activity-endpoint.json (default ~/.openrig) for reconcile /
//      restored seats whose frozen process env lacks the activity vars. The
//      daemon writes this file at startup. Identity (session/node/runtime) still
//      comes from env, which previously-launched-then-reconciled seats inherit
//      from the tmux session env.
function resolveEndpoint(env = process.env) {
  let baseUrl = firstString(env.OPENRIG_URL, env.RIGGED_URL);
  let token = firstString(env.OPENRIG_ACTIVITY_HOOK_TOKEN, env.RIGGED_ACTIVITY_HOOK_TOKEN);

  if (!baseUrl) {
    const port = firstString(env.OPENRIG_PORT, env.RIGGED_PORT);
    if (port) {
      const host = firstString(env.OPENRIG_HOST, env.RIGGED_HOST) || "127.0.0.1";
      baseUrl = `http://${host}:${port}`;
    }
  }

  if (!baseUrl || !token) {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const os = require("node:os");
      const home = firstString(env.OPENRIG_HOME, env.RIGGED_HOME) || path.join(os.homedir(), ".openrig");
      const parsed = JSON.parse(fs.readFileSync(path.join(home, "activity-endpoint.json"), "utf8"));
      if (!baseUrl && typeof parsed.baseUrl === "string" && parsed.baseUrl.length > 0) baseUrl = parsed.baseUrl;
      if (!token && typeof parsed.token === "string" && parsed.token.length > 0) token = parsed.token;
    } catch {
      // absent/malformed — the caller no-ops safely below.
    }
  }

  return { baseUrl, token };
}

async function postHookPayload(payload, env = process.env) {
  const { baseUrl, token } = resolveEndpoint(env);
  if (!baseUrl || !token || !payload || typeof fetch !== "function") return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(new URL("/api/activity/hooks", baseUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Provider hooks must not block the agent loop if OpenRig is unavailable.
  } finally {
    clearTimeout(timeout);
  }
}

function buildSessionIdentityPayload(providerPayload, env = process.env, now = () => new Date()) {
  if (!providerPayload || typeof providerPayload !== "object") return null;
  const hookEvent = firstString(
    providerPayload.hookEvent, providerPayload.hookEventName,
    providerPayload.hook_event_name, providerPayload.event, providerPayload.eventName
  );
  if (!hookEvent || hookEvent.toLowerCase() !== "sessionstart") return null;

  const sessionId = firstString(providerPayload.session_id, providerPayload.sessionId);
  if (!sessionId) return null;

  const sessionName = firstString(env.OPENRIG_SESSION_NAME, env.RIGGED_SESSION_NAME);
  const nodeId = firstString(env.OPENRIG_NODE_ID, env.RIGGED_NODE_ID);
  const runtime = firstString(env.OPENRIG_RUNTIME, env.RIGGED_RUNTIME);
  const generation = firstString(env.OPENRIG_OCCUPANT_GENERATION, env.RIGGED_OCCUPANT_GENERATION);
  // How this session began (startup, resume, clear or compact). The daemon tells a resumed
  // conversation's new id from a /clear by it; it is absent from runtimes that do not report it.
  const source = firstString(providerPayload.source);
  // Set only on the command OpenRig sends to resume this seat, so the daemon can tell the process
  // it launched from another Claude sharing the seat's environment.
  const resumeLaunch = firstString(env.OPENRIG_RESUME_LAUNCH);

  if ((!sessionName && !nodeId) || !runtime) return null;

  // #1524 (a): whether the runtime sent transcript_path, and its raw value. Codex sends an explicit null for a
  // thread it never persists; the daemon tells that apart from an absent key, an empty string or a malformed value.
  const transcriptPathPresent = Object.prototype.hasOwnProperty.call(providerPayload, "transcript_path");

  return {
    eventFamily: "session_identity",
    sessionName,
    nodeId,
    runtime,
    generation,
    hookEvent,
    source,
    resumeLaunch,
    // The daemon finds the Claude that ran this hook from its parent chain.
    hookPid: process.pid,
    sessionId,
    transcriptPathPresent,
    ...(transcriptPathPresent ? { transcriptPath: providerPayload.transcript_path } : {}),
    occurredAt: now().toISOString(),
  };
}

// #1077 — whether this is the first SessionStart of the launch OpenRig armed (OPENRIG_RESUME_LAUNCH
// for this occupant generation). Recorded on local disk before anything is posted, so a first hook
// whose post never reaches the daemon still makes every later one (an in-process /resume, a child
// sharing the environment) report false. Any error reports false.
function claimFirstLaunchHook(resumeLaunch, generation, dir = path.join(os.tmpdir(), `openrig-resume-launch-${uid()}`)) {
  if (!resumeLaunch || !generation) return false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = crypto.createHash("sha256").update(`${generation}\0${resumeLaunch}`).digest("hex");
    fs.closeSync(fs.openSync(path.join(dir, key), "wx", 0o600));
    return true;
  } catch {
    return false;
  }
}

function uid() {
  try { return typeof process.getuid === "function" ? String(process.getuid()) : "user"; } catch { return "user"; }
}

// OpenRig also copies this script into a seat's own settings.local.json hooks (the claude_activity_hooks resource), so a
// seat that loads this plugin as well would post every event twice. The plugin's manifest starts the plugin's run with
// --from-plugin; that run looks at the seat's project settings.local.json and exits only when the OpenRig copy is
// registered there for this very event. The settings copy is started without that argument and always reports, and so does
// a seat whose settings have no such entry (the resource is optional) or a plugin installed on its own, so a seat reports
// each event once either way. Anything unreadable, missing or different counts as "not registered": a seat is never silent.
const SETTINGS_RELAY_TAIL = "state/claude-activity-hooks/activity-relay.cjs";

// Keep this finite Node-command grammar in parity with parseManagedClaudeNodeCommand.
// Canonical POSIX quotes and literal unquoted words only; no expansion or wrappers.
function settingsRelayPath(command) {
  if (/[\r\n]/.test(command)) return null;
  const token = /'(?:[^']|'"'"')*'|[-A-Za-z0-9_./:@%+=,]+/.source;
  const m = new RegExp(`^(${token})[ \t]+(${token})$`).exec(command.trim());
  if (!m) return null;
  const decode = token => token.startsWith("'") ? token.slice(1, -1).split(`'"'"'`).join("'") : token;
  const quote = value => "'" + value.replace(/'/g, `'"'"'`) + "'";
  const executable = decode(m[1]);
  const relay = decode(m[2]);
  if (m.slice(1).some(token => token.startsWith("'") && quote(decode(token)) !== token)) return null;
  if (!path.isAbsolute(relay) || !relay.endsWith(`/${SETTINGS_RELAY_TAIL}`)) return null;
  if (executable !== "node" && (!path.isAbsolute(executable) || !/^node(?:\.exe)?$/i.test(path.basename(executable)))) return null;
  return { executable, relay };
}

function interpreterAvailable(executable, env) {
  const candidates = executable === "node"
    ? typeof env.PATH === "string" ? env.PATH.split(path.delimiter).map(dir => path.resolve(dir || ".", "node")) : []
    : [executable];
  return candidates.some(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
    catch { return false; }
  });
}

// A settings entry only silences this run if it would really report: the file it names is there and is this very script.
// A missing script, or a different one at that path (a no-op, a stale copy from an older install), reports from the plugin.
function isThisScript(file) {
  try { return Buffer.compare(fs.readFileSync(file), fs.readFileSync(__filename)) === 0; } catch { return false; }
}

function settingsRelayReports(hookEvent, providerPayload, env = process.env) {
  const projectDir = firstString(env.CLAUDE_PROJECT_DIR, providerPayload && providerPayload.cwd);
  if (!projectDir || !hookEvent) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(projectDir, ".claude", "settings.local.json"), "utf8"));
    const groups = settings && settings.hooks && settings.hooks[hookEvent];
    // A group with a matcher may not run for this event, so only an unrestricted group (no matcher, "" or "*") counts;
    // OpenRig writes its group without one. Anything else reports, at worst twice, never not at all.
    const unrestricted = (group) => group.matcher === undefined || group.matcher === "" || group.matcher === "*";
    return Array.isArray(groups) && groups.some((group) => group && unrestricted(group) && Array.isArray(group.hooks)
      && group.hooks.some((hook) => {
        const relay = hook && typeof hook.command === "string" ? settingsRelayPath(hook.command) : null;
        return relay !== null && interpreterAvailable(relay.executable, env) && isThisScript(relay.relay);
      }));
  } catch {
    return false;
  }
}

function pluginRunIsRedundant(providerPayload, argv = process.argv, env = process.env) {
  if (!argv.includes("--from-plugin")) return false;
  const hookEvent = firstString(providerPayload.hookEvent, providerPayload.hookEventName, providerPayload.hook_event_name, providerPayload.event, providerPayload.eventName);
  // Codex activity has one producer: OpenRig's managed inline hooks. The plugin supplies refocus and skills, but its
  // activity entries are no-ops. Do not infer merged native hook state here or bypass a person's inline-hook disable.
  if (firstString(env.OPENRIG_RUNTIME, env.RIGGED_RUNTIME) === "codex") return true;
  return settingsRelayReports(hookEvent, providerPayload, env);
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

async function main() {
  // Before anything is read, posted or recorded: a Claude started elsewhere inside this seat is not the seat.
  if (!runsForThisSeatsProject()) return;
  const providerPayload = parseJson(await readStdin());
  if (pluginRunIsRedundant(providerPayload)) return;
  const payload = buildOpenRigPayload(providerPayload);
  const identityPayload = buildSessionIdentityPayload(providerPayload, process.env);
  if (identityPayload && identityPayload.resumeLaunch) {
    identityPayload.resumeLaunchFirst = claimFirstLaunchHook(identityPayload.resumeLaunch, identityPayload.generation);
  }
  await postHookPayload(payload);
  if (identityPayload) {
    await postHookPayload(identityPayload);
  }
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = {
  buildOpenRigPayload,
  claimFirstLaunchHook,
  buildSessionIdentityPayload,
  parseJson,
  postHookPayload,
  resolveEndpoint,
  pluginRunIsRedundant,
  settingsRelayReports,
  settingsRelayPath,
};
