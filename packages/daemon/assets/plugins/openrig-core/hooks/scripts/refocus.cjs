#!/usr/bin/env node
"use strict";

// Refocus is deliberately a long-session feature, not startup orientation.
// Claude observes transcript growth; both runtimes observe their exact
// PostCompact event; either accepts an explicit request. Stop/PostCompact
// retain due-state; context is consumed exclusively at a UserPromptSubmit
// boundary where the harness can actually deliver additionalContext.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { recordRefocusResult } = require("./refocus-health.cjs");

const DEFAULT_THRESHOLD = 2_600_000;
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);
const CONTENT_LOOKUP_TIMEOUT_MS = 2_000;
// Normal managed restore advances on ~30 s polls with a 10 s idle wait.
// A lost daemon stage must not suppress this occupant's refocus indefinitely.
const MANAGED_RESTORE_HOLD_MS = 10 * 60_000;

function runtime() {
  const index = process.argv.indexOf("--runtime");
  return index >= 0 && process.argv[index + 1] === "codex" ? "codex" : "claude";
}

function enabled(value, fallback = true) {
  if (value === undefined || value === "") return fallback;
  return !FALSE_VALUES.has(String(value).trim().toLowerCase());
}

function threshold() {
  const value = Number(process.env.OPENRIG_REFOCUS_BYTES || DEFAULT_THRESHOLD);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_THRESHOLD;
}

const readStdin = () => new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", () => resolve(""));
});

function readConfiguredContent(home) {
  const contentRef = process.env.OPENRIG_REFOCUS_CONTENT_REF || "";
  if (contentRef) {
    const result = spawnSync("rig", ["context", "get", contentRef], {
      encoding: "utf8",
      env: process.env,
      timeout: CONTENT_LOOKUP_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!result.error && result.status === 0 && result.stdout.trim()) {
      return { content: result.stdout, contentRef, failure: null };
    }
    const failure = result.error?.message
      || result.stderr?.trim()
      || result.stdout?.trim()
      || `rig context get exited ${result.status ?? "without a status"}`;
    return {
      content: null,
      contentRef,
      failure: String(failure).replace(/\s+/g, " ").trim(),
    };
  }

  const configuredFile = [
    process.env.OPENRIG_REFOCUS_CONTENT_FILE,
    path.join(home, "refocus", "REFOCUS.md"),
  ].filter(Boolean).find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  if (configuredFile) {
    try {
      const content = fs.readFileSync(configuredFile, "utf8").trim();
      if (content) return { content, contentRef: "", failure: null };
    } catch {}
  }

  const shippedDefault = path.resolve(__dirname, "../../skills/refocusing/references/refocus.md");
  try {
    const content = fs.readFileSync(shippedDefault, "utf8").trim();
    if (content) return { content, contentRef: "", failure: null };
  } catch {}

  return {
    content: [
      "1. What is the person actually trying to get? Not your current task — the outcome.",
      "2. Does what you are doing RIGHT NOW move that? If you cannot say what a user gets, stop and say so.",
      "3. What have you concluded without opening the file or running the thing?",
    ].join("\n"),
    contentRef: "",
    failure: null,
  };
}

// A live seat carries no OPENRIG_REFOCUS_WORK_NODE, so the trace used to report an
// unresolved work node while the daemon could already name the seat's typed baton. Ask it.
// The explicit variable always wins and short-circuits the call. When the daemon names no
// current work, its basis travels to the trace script, which alone decides how to render it;
// a failed or unreadable answer is passed as UNKNOWN. Never guess a work node here: a guess
// would silently re-point the whole trace.
function readQueueWhoami(timeout = 2_000) {
  const result = spawnSync("rig", ["queue", "whoami", "--json"], {
    encoding: "utf8", env: process.env, timeout, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) return { unknown: `queue whoami failed: ${result.error.message}` };
  if (result.status !== 0 || !result.stdout || !result.stdout.trim()) {
    return { unknown: `queue whoami exited ${result.status ?? "without a status"} with no answer` };
  }
  try { return { answer: JSON.parse(result.stdout) }; }
  catch { return { unknown: "queue whoami answer was not JSON" }; }
}

function deriveWorkStart(lookup) {
  if (process.env.OPENRIG_REFOCUS_WORK_NODE) return { start: process.env.OPENRIG_REFOCUS_WORK_NODE };
  const result = lookup();
  if (result.unknown) return result;
  const workNodePath = result.answer?.currentWork?.workNodePath;
  if (typeof workNodePath === "string" && workNodePath) return { start: workNodePath };
  const basis = result.answer?.currentWorkBasis;
  return typeof basis === "string" && basis ? { basis } : { unknown: "queue whoami named no current work and no basis" };
}

// One optional lookup shares the trace/config budget. Reuse even a failed work lookup;
// retrying here would spend the same budget twice and cannot make absence trustworthy.
function remainingLookupBudget() {
  const contentReserve = process.env.OPENRIG_REFOCUS_CONTENT_REF ? CONTENT_LOOKUP_TIMEOUT_MS : 0;
  return Math.floor(Math.min(2_000, 4_500 - 2_000 - contentReserve - process.uptime() * 1_000));
}

function renderRole(result) {
  const unknown = reason => `Role file: unknown (${reason})`;
  if (result.unknown) return unknown(result.unknown);
  const role = result.answer?.role;
  if (!role || !Array.isArray(role.files)) return unknown("queue whoami has no role information");
  if (role.state === "unknown") return unknown(role.reason || "role observation unavailable");
  if (role.state === "no-record" || role.state === "not-declared") return `Role file: ${role.state}`;
  if (!["present", "missing"].includes(role.state) || role.files.length === 0
    || role.files.some(file => !file || typeof file.resolvedPath !== "string"
      || !["present", "missing"].includes(file.state))) return unknown("malformed role information");
  return [
    ...role.files.map(file => file.state === "present"
      ? `Your seat's role file: ${JSON.stringify(file.resolvedPath)}. Re-read it if your role is unclear.`
      : `Role file: missing (${JSON.stringify(file.resolvedPath)})`),
    `Binding recorded at: ${role.recordedAt || "unknown"}. ${role.note || "Current bytes and successful startup are not verified."}`,
  ].join("\n");
}

// The trace script looks up each missing root with its own `rig config get`, two CLI starts
// inside its 2 s budget. One `rig config --json` read here fills only the roots the selected
// trees need and that are missing, under the config store's own env names, which the script
// already honours. An explicit nonempty value is never replaced; nothing missing skips the
// read; a failed, malformed or skipped read sets nothing, so the script's own lookup runs
// exactly as before. Only the two root fields are consumed and nothing from the config is logged.
//
// Both harnesses kill this hook at 5 s (hooks/claude.json, hooks/codex.json). The read gets only
// what is left of a 4.5 s budget, counted from process start, after reserving python's 2 s and,
// when a content ref is configured, the content lookup that runs after python; with 250 ms or
// less left it is skipped, so the read never pushes a fire main would deliver past the kill.
function traceEnv(trees) {
  const env = { ...process.env };
  const missing = [
    ["OPENRIG_TOPOLOGY_ROOT", "topology", "topology"],
    ["OPENRIG_WORKSPACE_ROOT", "workspace", "work"],
  ].filter(([name, , tree]) => (trees === "both" || trees === tree) && !env[name]);
  if (missing.length === 0) return env;
  const timeout = remainingLookupBudget();
  if (timeout <= 250) return env;
  const result = spawnSync("rig", ["config", "--json"], {
    encoding: "utf8",
    env: process.env,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return env;
  let config;
  try { config = JSON.parse(result.stdout); } catch { return env; }
  for (const [name, section] of missing) {
    const value = config?.[section]?.root;
    if (typeof value === "string" && value) env[name] = value;
  }
  return env;
}

function renderTrace() {
  const script = path.resolve(__dirname, "../../skills/refocusing/scripts/trace-to-root.py");
  const trees = process.env.OPENRIG_REFOCUS_TREES || "both";
  const args = [
    script,
    "--trees", trees,
    "--depth", process.env.OPENRIG_REFOCUS_DEPTH || "light",
    "--check",
  ];
  if (process.env.OPENRIG_REFOCUS_TOPOLOGY_NODE) {
    args.push("--topology-start", process.env.OPENRIG_REFOCUS_TOPOLOGY_NODE);
  }
  let whoami;
  const lookup = () => whoami ??= readQueueWhoami();
  const work = deriveWorkStart(lookup);
  let role = "";
  if (trees === "both" || trees === "topology") {
    if (!whoami) {
      const timeout = remainingLookupBudget();
      whoami = timeout > 250 ? readQueueWhoami(timeout) : { unknown: "no budget left" };
    }
    role = renderRole(whoami);
  }
  if (work.start) args.push("--work-start", work.start);
  else if (work.basis) args.push("--work-basis", work.basis);
  else if (work.unknown) args.push("--work-unknown", work.unknown);
  const result = spawnSync(process.env.PYTHON || "python3", args, {
    encoding: "utf8",
    env: traceEnv(trees),
    timeout: 2_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const reason = result.error?.message || result.stderr?.trim() || `trace exited ${result.status ?? "without a status"}`;
  const failed = Boolean(result.error) || result.status !== 0 || !result.stdout?.trim();
  const trace = [
    ...(failed ? [`TRACE GAP — ${String(reason).replace(/\s+/g, " ").trim()}`] : []),
    result.stdout?.trim(),
  ].filter(Boolean).join("\n");
  return {
    text: [trace, role].filter(Boolean).join("\n\n"),
    failed,
  };
}

(async () => {
  if (!enabled(process.env.OPENRIG_REFOCUS_ENABLED)) process.exit(0);

  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}") || {}; } catch {}
  const event = input.hook_event_name || "UserPromptSubmit";
  const harness = runtime();

  // The acknowledgement is never an actionable restore turn. The managed
  // marker below also holds earlier/later peer messages, not just this prompt.
  const rawPrompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  // Claude can wrap a complete submitted message as pasted content. Unwrap only
  // that envelope; a peer quoting a restore request is still an ordinary prompt.
  const prompt = harness === "claude"
    ? (rawPrompt.match(/^<pasted_content id="([^"]+)">\s*([\s\S]*)\s*<\/pasted_content id="\1">$/)?.[2]?.trim() ?? rawPrompt)
    : rawPrompt;
  if (event === "UserPromptSubmit" && prompt.startsWith("OpenRig post-compaction turn boundary.")) process.exit(0);

  // Fresh-session orientation is the default onboarding pack's job. Even a manually invoked hook must
  // no-op here, so a stale registration cannot corrupt the world install.
  if (event === "SessionStart") process.exit(0);

  const seat = process.env.OPENRIG_SESSION_NAME || "unknown-seat";
  const home = process.env.OPENRIG_HOME || path.join(process.env.HOME || "/tmp", ".openrig");
  const transcriptPath = input.transcript_path || input.transcriptPath || "";
  let size = 0;
  try { size = fs.statSync(transcriptPath).size; } catch {}

  const stateDir = path.join(home, "refocus");

  // OPR.0.5.6.25 — state keys to the OCCUPANT, not the seat. A seat-keyed file made
  // a fresh occupant inherit its predecessor's lastBytes (permanently zero growth on
  // exactly the seats that swap) and its pending delivery. Identity derives from the
  // hook family's own fields; the guarded expression never evaluates basename on an
  // absent value. The legacy `${seat}.json` is NEVER read, imported, or rewritten —
  // it stays on disk as diagnosis/migration material only.
  const sanitize = (raw) => String(raw).replace(/[^A-Za-z0-9@._-]/g, "_");
  const seatKey = sanitize(seat);
  const firstString = (...vals) => {
    for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
    return null;
  };
  const transcriptIdentity = input.transcript_path
    ? path.basename(input.transcript_path, ".jsonl")
    : input.transcriptPath
      ? path.basename(input.transcriptPath, ".jsonl")
      : null;
  const identity = firstString(input.session_id, input.sessionId, transcriptIdentity);

  // Bounded, deterministic, collision-stable key: lossy sanitization or truncation
  // appends a stable short hash of the full pre-sanitization identity, so distinct
  // identities stay distinct and every path stays inside the state directory.
  const KEY_MAX = 64;
  const keyFor = (raw) => {
    const bounded = sanitize(raw).slice(0, KEY_MAX);
    if (bounded === String(raw)) return bounded;
    const suffix = crypto.createHash("sha256").update(String(raw)).digest("hex").slice(0, 8);
    return `${bounded}__${suffix}`;
  };

  // No-identity diagnostic sentinel: an ACTIVE-EPISODE marker only — never a
  // baseline, growth claim, pending, or fire. "#" is outside the key character
  // class, so no derived identity path can ever collide with it. First missing
  // event records and surfaces once; repeats stay silent; a valid-identity event
  // clears the marker so a later distinct episode surfaces once again.
  const sentinelFile = path.join(stateDir, `${seatKey}#no-identity-sentinel.json`);
  if (identity === null) {
    let sentinel = null;
    try { sentinel = JSON.parse(fs.readFileSync(sentinelFile, "utf8")); } catch {}
    if (!sentinel || sentinel.activeEpisode !== true) {
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(sentinelFile, JSON.stringify({ activeEpisode: true, recordedAt: new Date().toISOString() }));
      } catch {}
      process.stderr.write(`refocus: no session identity and no transcript path for ${seat} — measurement unavailable this episode\n`);
    }
    process.exit(0);
  }
  try {
    const sentinel = JSON.parse(fs.readFileSync(sentinelFile, "utf8"));
    if (sentinel && sentinel.activeEpisode === true) {
      fs.writeFileSync(sentinelFile, JSON.stringify({ activeEpisode: false, clearedAt: new Date().toISOString() }));
    }
  } catch {}

  const stateFile = path.join(stateDir, `${seatKey}__${keyFor(identity)}.json`);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")) || null; } catch {}
  const persist = () => {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch {}
  };

  if (state === null) {
    // First observation for this occupant: the baseline is its OWN current size —
    // growth accumulates from here; nothing is inherited. A zero-size read means
    // the transcript is absent/unreadable, which is instrument absence, not a
    // baseline: record zero only when that is what was genuinely measured.
    state = { lastBytes: size, baselineAt: new Date().toISOString() };
    persist();
  } else if (size > 0 && size < Number(state.lastBytes || 0)) {
    // Shrink invalidates growth-based due state, not an exact PostCompact event
    // awaiting its actionable restore turn.
    if (state.pendingOn !== "PostCompact") {
      delete state.pendingOn;
      delete state.pendingAt;
    }
    state.lastReset = { at: new Date().toISOString(), fromBytes: Number(state.lastBytes || 0), toBytes: size };
    state.lastBytes = size;
    persist();
    process.stderr.write(`refocus: transcript shrank for ${seat} — baseline reset; PostCompact pending retained if present\n`);
  }

  const lastBytes = Number(state.lastBytes || 0);
  const grown = size > lastBytes ? size - lastBytes : 0;
  const onDemand = enabled(process.env.OPENRIG_REFOCUS_NOW, false);
  const thresholdDue = harness === "claude" && grown >= threshold();
  const due = onDemand
    || event === "PostCompact"
    || Boolean(state.pendingOn)
    || thresholdDue;
  if (!due) process.exit(0);

  if (event !== "UserPromptSubmit") {
    if (event === "PostCompact" && harness === "claude") {
      // PreCompact records whether THIS compact was initiated by the enforcer.
      // A manual /compact overwrites the marker with false; other occupants
      // cannot hold this session. Read the early sentinel first if it survives.
      state.managedRestorePending = false;
      for (const suffix of [".expected.json", ".json"]) {
        try {
          const marker = JSON.parse(fs.readFileSync(path.join(home, "compaction", "restore-pending", seatKey + suffix), "utf8"));
          if (marker.sessionName !== seat || (marker.sessionId ? marker.sessionId !== identity : !transcriptPath || marker.transcriptPath !== transcriptPath)) continue;
          state.managedRestorePending = marker.managedRefocusPending === true;
          break;
        } catch {}
      }
      if (state.managedRestorePending) state.managedRestorePendingAt = new Date().toISOString();
      else delete state.managedRestorePendingAt;
    }
    if (event === "PostCompact" || !state.pendingOn) state.pendingOn = event;
    state.pendingAt ||= new Date().toISOString();
    persist();
    process.exit(0);
  }

  if (harness === "claude" && state.managedRestorePending) {
    const heldFor = Date.now() - Date.parse(state.managedRestorePendingAt);
    // Missing/invalid timestamps from older state, or a clock moving backwards,
    // cannot establish a live hold. No timer or extra turn is created here.
    if (heldFor >= 0 && heldFor < MANAGED_RESTORE_HOLD_MS
      && !prompt.startsWith("Please respond to this normal user message now by restoring this Claude session after compaction.")) process.exit(0);
    delete state.managedRestorePending;
    delete state.managedRestorePendingAt;
    persist();
  }

  // Run the public trace before resolving a context ref. Besides keeping the
  // content ladder untouched, this makes `rig context get` the last resolver
  // call and preserves the existing observable ref contract.
  const rendered = renderTrace();
  const trace = rendered.text;
  const configured = readConfiguredContent(home);
  const failed = rendered.failed || Boolean(configured.failure);
  const why = onDemand
    ? "on demand"
    : state.pendingOn === "PostCompact"
      ? "just compacted — your picture is lossy"
      : `${Math.round(grown / 1e6 * 10) / 10}MB of work since your last refocus`;

  const body = configured.failure
    ? [
        `REFOCUS CONTENT REF FAILED: ${configured.contentRef} — ${configured.failure}`,
        "",
        "The configured source failed; use the shipped default below for this turn.",
        "",
        "",
      ]
    : configured.contentRef
      ? [`REFOCUS CONTENT SOURCE: OPENRIG_REFOCUS_CONTENT_REF=${configured.contentRef}`, "", configured.content]
      : [configured.content];

  // A ref failure must still carry the generic default. Avoid recursing through
  // the failed ref by reading the shipped file directly.
  if (configured.failure) {
    try {
      body[4] = fs.readFileSync(
        path.resolve(__dirname, "../../skills/refocusing/references/refocus.md"),
        "utf8",
      ).trim();
    } catch {
      body[4] = "1. What is the person actually trying to get?\n2. Does the current action move that outcome?\n3. What claim has not been checked at source?";
    }
  }

  const payload = (configured.failure
    ? [...body, "", trace]
    : [
        `REFOCUS (${why}). Answer briefly, out loud, before your next move:`,
        "",
        trace,
        "",
        ...body,
      ]).join("\n");
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: payload,
    },
  });
  process.stdout.write(output, (error) => {
    recordRefocusResult({ home, seat, identity, failed: failed || Boolean(error) });
    if (failed || error) {
      state.pendingOn ||= event;
      state.pendingAt ||= new Date().toISOString();
      persist();
      return;
    }
    if (size > 0) state.lastBytes = size;
    state.firedAt = new Date().toISOString();
    state.firedOn = event;
    delete state.pendingOn;
    delete state.pendingAt;
    persist();
  });
})();
