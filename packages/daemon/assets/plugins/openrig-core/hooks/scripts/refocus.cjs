#!/usr/bin/env node
"use strict";

// Refocus is deliberately a long-session feature, not startup orientation.
// Claude observes transcript growth; both runtimes observe their exact
// PostCompact event; either accepts an explicit request. Stop/PostCompact
// retain due-state; context is consumed exclusively at a UserPromptSubmit
// boundary where the harness can actually deliver additionalContext.

const fs = require("node:fs");
const path = require("node:path");
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
  const stateFile = path.join(stateDir, `${seat.replace(/[^A-Za-z0-9@._-]/g, "_")}.json`);
  let state = { lastBytes: 0 };
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")) || state; } catch {}
  const persist = () => {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch {}
  };

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
    state.lastBytes = size;
    state.firedAt = new Date().toISOString();
    state.firedOn = event;
    delete state.pendingOn;
    delete state.pendingAt;
    persist();
  });
})();
