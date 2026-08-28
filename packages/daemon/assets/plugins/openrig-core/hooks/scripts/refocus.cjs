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

const DEFAULT_THRESHOLD = 2_600_000;
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);

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
      timeout: 2_000,
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

function renderTrace() {
  const script = path.resolve(__dirname, "../../skills/refocusing/scripts/trace-to-root.py");
  const args = [
    script,
    "--trees", process.env.OPENRIG_REFOCUS_TREES || "both",
    "--depth", process.env.OPENRIG_REFOCUS_DEPTH || "light",
  ];
  if (process.env.OPENRIG_REFOCUS_TOPOLOGY_NODE) {
    args.push("--topology-start", process.env.OPENRIG_REFOCUS_TOPOLOGY_NODE);
  }
  if (process.env.OPENRIG_REFOCUS_WORK_NODE) {
    args.push("--work-start", process.env.OPENRIG_REFOCUS_WORK_NODE);
  }
  const result = spawnSync(process.env.PYTHON || "python3", args, {
    encoding: "utf8",
    env: process.env,
    timeout: 2_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!result.error && result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  const reason = result.error?.message || result.stderr?.trim() || `trace exited ${result.status ?? "without a status"}`;
  return `TRACE GAP — ${String(reason).replace(/\s+/g, " ").trim()}`;
}

(async () => {
  if (!enabled(process.env.OPENRIG_REFOCUS_ENABLED)) process.exit(0);

  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}") || {}; } catch {}
  const event = input.hook_event_name || "UserPromptSubmit";
  const harness = runtime();

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
    // Shrink clears pending and resets the baseline BEFORE due computation. The
    // reset itself emits no refocus, and a stale pending can never ride through a
    // reset into a delivery. Advisory once per reset episode: the reset moment is
    // the dedupe (afterwards lastBytes === size), and the marker records in state.
    delete state.pendingOn;
    delete state.pendingAt;
    state.lastReset = { at: new Date().toISOString(), fromBytes: Number(state.lastBytes || 0), toBytes: size };
    state.lastBytes = size;
    persist();
    process.stderr.write(`refocus: transcript shrank for ${seat} — baseline reset, pending cleared\n`);
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
    if (event === "PostCompact" || !state.pendingOn) state.pendingOn = event;
    state.pendingAt ||= new Date().toISOString();
    persist();
    process.exit(0);
  }

  // Run the public trace before resolving a context ref. Besides keeping the
  // content ladder untouched, this makes `rig context get` the last resolver
  // call and preserves the existing observable ref contract.
  const trace = renderTrace();
  const configured = readConfiguredContent(home);
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
  process.stdout.write(output, () => {
    if (size > 0) state.lastBytes = size;
    state.firedAt = new Date().toISOString();
    state.firedOn = event;
    delete state.pendingOn;
    delete state.pendingAt;
    persist();
  });
})();
