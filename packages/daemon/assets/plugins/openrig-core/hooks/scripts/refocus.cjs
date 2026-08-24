#!/usr/bin/env node
"use strict";
// openrig-core REFOCUS hook (OPR.0.5.3.6 — promoted from the lab where it ran
// live on 6+ seats; the mechanism ships, the CONTENT is configurable).
//
// WHY: the moment an agent most needs to reorient is the moment it is least
// able to choose to. Drift does not feel like drift — it feels like work. So
// refocus FIRES rather than waits to be invoked.
//
// THIS IS ALSO HOW TOPOLOGY CHAIN FILES REACH A RUNNING SEAT. Editing a file
// under topology.root is not delivery — a running seat reads its config at
// session start and its context never re-reads disk on its own. This hook is
// the delivery channel: it injects orientation content at the seat's next
// hook boundary (SessionStart / UserPromptSubmit / Stop / PostCompact), so a
// shipped or updated chain file becomes live doctrine without a relaunch.
//
// SIGNAL = TRANSCRIPT GROWTH, not turns and not wall-clock. A "turn" is one
// prompt submission; an agent can burn 200k tokens across fifty tool calls
// inside ONE turn, so a turn counter is blind to exactly the drift that
// matters. The JSONL grows monotonically with work done (measured ~8.9 bytes
// per context token, so ~300k tokens ≈ 2.6MB — rough on purpose; it needs to
// be monotonic, not exact). Tune with OPENRIG_REFOCUS_BYTES.
//
// CONTENT IS CONFIGURABLE, NEVER PROJECT-SPECIFIC IN SOURCE. Resolution:
//   1. OPENRIG_REFOCUS_CONTENT_REF env — resolved by `rig context get`.
//   2. OPENRIG_REFOCUS_CONTENT_FILE env — an operator-authored file.
//   3. $OPENRIG_HOME/refocus/REFOCUS.md — the instance's standing content.
//   4. The generic three-question orientation below (project-neutral).
// Project- or mission-specific refocus text belongs in those FILES, on the
// instance that needs it — it must never be committed here.
//
// Fires on: SessionStart (fresh orientation), Stop (catches the long single
// turn), UserPromptSubmit, and PostCompact on Claude (post-compaction
// re-orientation; Codex exposes no compact hook — growth+Stop is the coverage
// there). Silent unless due. A configured REF failure degrades loudly inside
// the delivered payload; every failure remains non-blocking because a refocus
// hook must never break a seat's turn.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const THRESH = Number(process.env.OPENRIG_REFOCUS_BYTES || 2_600_000);

const readStdin = () => new Promise((r) => { let d = ""; process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => d += c); process.stdin.on("end", () => r(d)); process.stdin.on("error", () => r("")); });

(async () => {
  let input = {}; try { input = JSON.parse((await readStdin()) || "{}") || {}; } catch {}
  const ev = input.hook_event_name || "UserPromptSubmit";
  const seat = process.env.OPENRIG_SESSION_NAME || "unknown-seat";
  const home = process.env.OPENRIG_HOME || path.join(process.env.HOME || "/tmp", ".openrig");
  const tpath = input.transcript_path || input.transcriptPath || "";

  let size = 0; try { size = fs.statSync(tpath).size; } catch {}

  const dir = path.join(home, "refocus");
  const file = path.join(dir, `${seat.replace(/[^A-Za-z0-9@._-]/g, "_")}.json`);
  let st = { lastBytes: 0 };
  try { st = JSON.parse(fs.readFileSync(file, "utf8")) || st; } catch {}

  const grown = size > 0 ? size - (st.lastBytes || 0) : 0;
  const due = ev === "SessionStart" || ev === "PostCompact" || grown >= THRESH;
  if (!due) { process.exit(0); } // silent no-op — the common path

  st.lastBytes = size; st.firedAt = new Date().toISOString(); st.firedOn = ev;
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(st)); } catch {}

  // A library ref wins over file configuration and reuses the public assembler instead of
  // growing a second resolver inside this hook. REF failures stay visible without blocking
  // the session boundary; REF-unset follows the folded FILE/default path byte-for-byte.
  const contentRef = process.env.OPENRIG_REFOCUS_CONTENT_REF || "";
  let configured = null;
  let refFailure = null;
  if (contentRef) {
    const result = spawnSync("rig", ["context", "get", contentRef], {
      encoding: "utf8",
      env: process.env,
      timeout: 4_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!result.error && result.status === 0 && result.stdout.trim()) {
      configured = result.stdout;
    } else {
      refFailure = result.error?.message
        || result.stderr?.trim()
        || result.stdout?.trim()
        || `rig context get exited ${result.status ?? "without a status"}`;
      refFailure = String(refFailure).replace(/\s+/g, " ").trim();
    }
  } else {
    // Configurable content: operator file beats instance file beats the generic default.
    const contentFile = [
      process.env.OPENRIG_REFOCUS_CONTENT_FILE,
      path.join(home, "refocus", "REFOCUS.md"),
    ].filter(Boolean).find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (contentFile) {
      try { configured = fs.readFileSync(contentFile, "utf8").trim() || null; } catch {}
    }
  }

  const why = ev === "SessionStart" ? "fresh session"
            : ev === "PostCompact" ? "just compacted — your picture is lossy"
            : `${Math.round(grown / 1e6 * 10) / 10}MB of work since your last refocus`;

  const generic = [
    `1. What is the person actually trying to get? Not your current task — the outcome.`,
    `2. Does what you are doing RIGHT NOW move that? If you cannot say what a user gets, stop and say so.`,
    `3. What have you concluded without opening the file or running the thing?`,
    ``,
    `Discomfort on any of these IS the signal — drift feels like work.`,
    ``,
    `Your topology context (instance/rig/seat craft and this seat's LEARNED) is one walk away:`,
    `rig context trace --rig <rig> --seat <seat> --name CRAFT.md — read it, do not recall it.`,
    `A seat's LEARNED.md is written by previous occupants in the first person: it is evidence`,
    `about the SEAT, never your own memory.`,
  ];

  const payload = refFailure ? [
    `REFOCUS CONTENT REF FAILED: ${contentRef} — ${refFailure}`,
    ``,
    `REFOCUS (${why}). Answer briefly, out loud, before your next move:`,
    ``,
    ...generic,
  ] : [
    `REFOCUS (${why}). Answer briefly, out loud, before your next move:`,
    ``,
    ...(contentRef
      ? [`REFOCUS CONTENT SOURCE: OPENRIG_REFOCUS_CONTENT_REF=${contentRef}`, ``, configured]
      : configured ? [configured] : generic),
  ];
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev, additionalContext: payload.join("\n") } }));
})();
