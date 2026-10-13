import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveWorkCandidates, frontmatterIntent, type WorkCandidateLookups } from "../src/domain/current-work.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTransitionsQitemIdOrderSchema } from "../src/db/migrations/098_queue_transitions_qitem_id_order.js";
import { QueueTransitionLog } from "../src/domain/queue-transition-log.js";

// OPR.0.7.0.12 — refocus knows the seat's work. The candidates sit beside the strict
// derivation (current-work.test.ts keeps its own contract); the trace renders them only in
// --packet mode, and the hook passes them only with OPENRIG_REFOCUS_WORK_PACKET on.
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, "../assets/plugins/openrig-core");
const HOOK = resolve(PLUGIN, "hooks/scripts/refocus.cjs");
const TRACE = resolve(PLUGIN, "skills/refocusing/scripts/trace-to-root.py");

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const nothingElse: WorkCandidateLookups = { getRow: () => null, continuationOf: () => null };

function world() {
  root = mkdtempSync(join(tmpdir(), "refocus-work-packet-"));
  const workspace = join(root, "workspace");
  const missions = join(workspace, "missions");
  const topology = join(root, "topology");
  const seat = join(topology, "rigs/demo/seats/builder");
  const slice = join(missions, "release-a/slices/12-refocus");
  const bin = join(root, "bin");
  for (const dir of [slice, join(missions, "release-b"), join(missions, "release-a-old"), seat, bin]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(workspace, "SPEC.md"), "---\nintent: Build useful things\n---\n# Project\n", "utf8");
  writeFileSync(join(missions, "release-a/SPEC.md"), "---\nintent: \"Ship A\"\n---\n# A\n", "utf8");
  writeFileSync(join(missions, "release-b/SPEC.md"), "---\nintent: Ship B\n---\n# B\n", "utf8");
  writeFileSync(join(slice, "SPEC.md"), "---\nintent: Refocus knows the work\n---\n# 12\n", "utf8");
  writeFileSync(join(topology, "rigs/demo/LEARNED.md"), "# Demo rig\nrig practice\n", "utf8");
  writeFileSync(join(seat, "LEARNED.md"),
    "# Builder\nintro\n\n## MY JOB HERE\nLead T2 and own its packets.\n\n## STANDING DUTIES\n- keep rows honest\n\n## Other\nnot duties\n", "utf8");
  const rig = join(bin, "rig");
  const calls = join(root, "rig-calls.log");
  writeFileSync(rig, `#!/bin/sh
printf '%s\\n' "$*" >> "$RIG_CALL_LOG"
if [ "$1 $2" = "queue whoami" ]; then
  case " $* " in *" --work-candidates "*) if [ -n "$RIG_REJECT_CANDIDATES" ]; then echo "error: unknown option '--work-candidates'" >&2; exit 1; fi;; esac
  printf '%s' "$RIG_QUEUE_WHOAMI_STDOUT"; exit 0
fi
if [ "$1 $2" = "whoami --json" ]; then printf '{"identity":{"rigName":"demo","sessionName":"builder@demo"}}\\n'; exit 0; fi
if [ "$1 $2" = "config --json" ]; then printf '{}'; exit 0; fi
if [ "$1 $2" = "scope resolve-notes" ]; then
  if [ -r "$3/NOTES.md" ]; then printf '{"ok":true,"resolution":{"path":"%s","name":"NOTES.md"}}\\n' "$3/NOTES.md"; exit 0; fi
  printf '{"ok":true,"resolution":null}\\n'; exit 0
fi
exit 1
`, "utf8");
  chmodSync(rig, 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH || ""}`,
    OPENRIG_TOPOLOGY_ROOT: topology,
    OPENRIG_WORKSPACE_ROOT: workspace,
    OPENRIG_REFOCUS_WORK_NODE: undefined,
    OPENRIG_REFOCUS_TOPOLOGY_NODE: undefined,
    OPENRIG_REFOCUS_NOTES_MAX_AGE_DAYS: undefined,
    RIG_CALL_LOG: calls,
  };
  const trace = (args: string[], evidence?: unknown, extra: NodeJS.ProcessEnv = {}) => spawnSync("python3", [TRACE, ...args], {
    encoding: "utf8", env: { ...env, ...extra }, input: evidence === undefined ? "" : JSON.stringify(evidence),
  });
  return { root, workspace, missions, topology, seat, slice, bin, env, trace,
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : "") };
}

describe("deriveWorkCandidates — labelled evidence beside the strict derivation", () => {
  it("offers a mission-tagged, slice-less row as a direct candidate with its source and intent (W2)", () => {
    const w = world();
    const out = deriveWorkCandidates([{ qitemId: "q-1", state: "in-progress", tags: ["mission:release-a"] }], w.missions, nothingElse);
    expect(out.candidates).toEqual([{
      kind: "tag", qitemId: "q-1", mission: "release-a", slice: null,
      workNodePath: join(w.missions, "release-a"), intent: "Ship A",
      source: "tag mission:release-a on row q-1", unresolved: null,
    }]);
    expect(out.unknown).toEqual([]);
  });

  it("names a tag that does not resolve on this host and never substitutes a similar directory", () => {
    const w = world();
    const out = deriveWorkCandidates([{ qitemId: "q-1", state: "in-progress", tags: ["mission:release"] }], w.missions, nothingElse);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({ mission: "release", workNodePath: null,
      unresolved: "mission release resolves to 0 directories on this host" });
  });

  it("offers an untagged handoff's ancestor mission as a labelled candidate, never adopted (W3)", () => {
    const w = world();
    const ancestor = { qitemId: "q-0", state: "done", tags: ["mission:release-a"], body: "original brief" };
    const out = deriveWorkCandidates(
      [{ qitemId: "q-1", state: "in-progress", tags: ["team:t2"], body: "follow-up", handedOffFrom: "q-0", chainOfRecord: ["q-0"] }],
      w.missions, { getRow: (id) => (id === "q-0" ? ancestor : null), continuationOf: () => null });
    expect(out.candidates).toEqual([expect.objectContaining({ kind: "ancestry", mission: "release-a",
      source: "handoff ancestor q-0 carries mission:release-a; row q-1 itself is untagged" })]);
  });

  it("assumes no mission for a retargeted handoff or a remote ancestor (W3 contrast)", () => {
    const w = world();
    const ancestor = { qitemId: "q-0", state: "done", tags: ["mission:release-a"], body: "original brief" };
    const lookups: WorkCandidateLookups = { getRow: (id) => (id === "q-0" ? ancestor : null), continuationOf: () => null };
    const out = deriveWorkCandidates([
      { qitemId: "q-1", state: "in-progress", tags: [], body: "a new job", handedOffFrom: "q-0", chainOfRecord: ["q-0"] },
      { qitemId: "q-2", state: "in-progress", tags: [], body: "x", handedOffFrom: "q-remote", chainOfRecord: ["q-remote"] },
    ], w.missions, lookups);
    expect(out.candidates).toEqual([]);
    expect(out.unknown.map((row) => row.reason)).toEqual([
      "retargeted handoff from q-0 (new body, no tags); no mission assumed",
      "handoff ancestor q-remote is not on this host (remote or removed); no mission assumed",
    ]);
  });

  it("exposes two missions in flight without choosing one (W4)", () => {
    const w = world();
    const out = deriveWorkCandidates([
      { qitemId: "q-1", state: "in-progress", tags: ["mission:release-a", "slice:12-refocus"] },
      { qitemId: "q-2", state: "in-progress", tags: ["mission:release-b"] },
    ], w.missions, nothingElse);
    expect(out.candidates.map((c) => [c.mission, c.slice, c.intent])).toEqual([
      ["release-a", "12-refocus", "Refocus knows the work"],
      ["release-b", null, "Ship B"],
    ]);
  });

  it("keeps held and next work apart from candidates, with the blocker and continuation (W5)", () => {
    const w = world();
    const out = deriveWorkCandidates([
      { qitemId: "q-held", state: "blocked", summary: "parked", tags: ["mission:release-a"], blockedOn: "q-gate" },
      { qitemId: "q-next", state: "pending", summary: "later", tags: ["mission:release-b"] },
    ], w.missions, { getRow: () => null, continuationOf: (id) => (id === "q-held" ? "resume the build" : null) });
    expect(out.candidates).toEqual([]);
    expect(out.held).toEqual([{ qitemId: "q-held", summary: "parked", blockedOn: "q-gate", continuation: "resume the build" }]);
    expect(out.next).toEqual([{ qitemId: "q-next", summary: "later", missions: ["release-b"] }]);
  });

  it("never treats a mission named only in body text as evidence", () => {
    const w = world();
    const out = deriveWorkCandidates([{ qitemId: "q-1", state: "in-progress", tags: [], body: "mission:release-a please" }],
      w.missions, nothingElse);
    expect(out.candidates).toEqual([]);
    expect(out.unknown).toEqual([{ qitemId: "q-1", summary: null, reason: "no mission tag and no handoff ancestry" }]);
    // Only directories with a SPEC.md count as missions a seat can name.
    expect(out.missionsOnHost).toEqual(["release-a", "release-b"]);
  });
});

describe("currentParkContinuation — the held row's recorded plan, bounded", () => {
  function log(states: Array<[string, string]>) {
    const db = createDb();
    migrate(db, [queueTransitionsSchema, queueTransitionsQitemIdOrderSchema]);
    const transitions = new QueueTransitionLog(db);
    for (const [state, transitionNote] of states) transitions.append({ qitemId: "q-1", state, transitionNote, actorSession: "seat@rig" } as never);
    return transitions;
  }

  it("reads the park's continuation past the daemon's later blocked-state transitions", () => {
    // The shape observed on a real ovh07 row: the park, then the daemon's own episode note.
    expect(log([
      ["in-progress", "claimed"],
      ["blocked", "continuation: resume the build"],
      ["blocked", "parked-owner episode closed: seat@rig (seat resumed)"],
    ]).currentParkContinuation("q-1")).toBe("resume the build");
  });

  it("never resurfaces an earlier park's plan, and says nothing for a row that is not parked", () => {
    expect(log([
      ["blocked", "continuation: old plan"],
      ["in-progress", "unparked"],
      ["blocked", "parked on q-gate"],
    ]).currentParkContinuation("q-1")).toBeNull();
    expect(log([
      ["blocked", "continuation: old plan"],
      ["in-progress", "unparked"],
    ]).currentParkContinuation("q-1")).toBeNull();
  });

  it("matches the continuation marker exactly, not case-insensitively (N3)", () => {
    expect(log([
      ["in-progress", "claimed"],
      ["blocked", "continuation: real plan"],
      ["blocked", "Continuation: unrelated prose"],
    ]).currentParkContinuation("q-1")).toBe("real plan");
  });

  it("reads newest-first through the (qitem_id, transition_id) index without sorting the history (F2)", () => {
    const db = createDb();
    migrate(db, [queueTransitionsSchema, queueTransitionsQitemIdOrderSchema]);
    // The exact statement currentParkContinuation prepares.
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT state, transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC")
      .all("q-1") as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
    expect(plan).toContain("idx_queue_transitions_qitem_id_order");
    expect(plan).not.toMatch(/TEMP B-TREE/i);
  });

  it("does not depend on the length of the row's earlier history", () => {
    const history: Array<[string, string]> = [];
    for (let i = 0; i < 2000; i++) history.push([i % 2 ? "in-progress" : "blocked", i % 2 ? "unparked" : `continuation: old ${i}`]);
    history.push(["in-progress", "claimed"], ["blocked", "continuation: current plan"], ["blocked", "episode note"]);
    expect(log(history).currentParkContinuation("q-1")).toBe("current plan");
  });
});

describe("frontmatterIntent — folded and literal intents", () => {
  it("joins a folded or literal block scalar instead of returning its indicator", () => {
    expect(frontmatterIntent("---\nid: x\nintent: >-\n  Ship the\n  alpha thing\nstage: wip\n---\n# A\n")).toBe("Ship the alpha thing");
    expect(frontmatterIntent("---\nintent: |\n  one\n  two\n---\n")).toBe("one two");
    expect(frontmatterIntent("---\nintent: \"quoted: yes\"\n---\n")).toBe("quoted: yes");
    expect(frontmatterIntent("---\nintent: plain words\n---\n")).toBe("plain words");
    expect(frontmatterIntent("# no frontmatter\nintent: nope\n")).toBeNull();
  });
});

describe("trace-to-root --packet — the work packet as text", () => {
  it("shows one direct candidate as the work, labelled with its source, without a root fallback (W2)", () => {
    const w = world();
    const evidence = deriveWorkCandidates([{ qitemId: "q-1", state: "in-progress", tags: ["mission:release-a"] }], w.missions, nothingElse);
    const result = w.trace(["--trees", "work", "--packet", "--work-candidates", "-"], evidence);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("WORK FROM QUEUE EVIDENCE — tag mission:release-a on row q-1");
    expect(result.stdout).toContain("no slice named");
    expect(result.stdout).toContain("intent: Ship A");
    expect(result.stdout).not.toContain("FALLBACK");
    expect(result.stdout).not.toContain("ORIENTATION");
  });

  it("asks a message-only seat to name its mission, and the named route then yields its intent as text (W1)", () => {
    const w = world();
    const evidence = deriveWorkCandidates([], w.missions, nothingElse);
    const ask = w.trace(["--trees", "work", "--packet", "--work-candidates", "-"], evidence);
    expect(ask.status, ask.stderr).toBe(0);
    expect(ask.stdout).toContain("No in-progress queue row names your work");
    expect(ask.stdout).toContain("if you have no current work, say so");
    expect(ask.stdout).toContain("Missions on this host: release-a, release-b");
    expect(ask.stdout).toContain("## ORIENTATION — the project-level chain, not your work");
    // The ask alone is not the outcome: following its route must put the intent in front of the agent.
    const route = ask.stdout.split("\n").find((line) => line.includes("--work-start"))!.trim();
    expect(route).toContain(`--trees work --packet --work-start ${w.missions}/<mission>`);
    writeFileSync(join(w.missions, "release-b/NOTES.md"), "## Current state\nB notes now\n", "utf8");
    writeFileSync(join(w.missions, "release-b/PROGRESS.md"), "## Current state\nB progress now\n", "utf8");
    // Exactly the offered route, with the agent's answer substituted for <mission>.
    const named = w.trace(["--trees", "work", "--packet", "--work-start", join(w.missions, "release-b")]);
    expect(named.stdout).toContain("intent: Ship B");
    expect(named.stdout).toContain("NOTES · NOTES.md\nCurrent state\nB notes now");
    expect(named.stdout).toContain("PROGRESS · PROGRESS.md\nCurrent state\nB progress now");
  });

  it("lists every candidate's one-line intent and asks instead of pre-selecting one (W4)", () => {
    const w = world();
    const evidence = deriveWorkCandidates([
      { qitemId: "q-1", state: "in-progress", tags: ["mission:release-a"] },
      { qitemId: "q-2", state: "in-progress", tags: ["mission:release-b"] },
    ], w.missions, nothingElse);
    const result = w.trace(["--trees", "work", "--packet", "--work-candidates", "-"], evidence);
    expect(result.stdout).toContain("2 candidates are in flight");
    expect(result.stdout).toContain("- release-a — Ship A — source: tag mission:release-a on row q-1");
    expect(result.stdout).toContain("- release-b — Ship B — source: tag mission:release-b on row q-2");
    expect(result.stdout).not.toContain("WORK FROM QUEUE EVIDENCE");
  });

  it("shows blocked work as held with its blocker, never as next (W5)", () => {
    const w = world();
    const evidence = deriveWorkCandidates([
      { qitemId: "q-held", state: "blocked", summary: "parked", tags: [], blockedOn: "q-gate" },
      { qitemId: "q-next", state: "pending", summary: "later", tags: [] },
    ], w.missions, { getRow: () => null, continuationOf: () => "resume the build" });
    const out = w.trace(["--trees", "work", "--packet", "--work-candidates", "-"], evidence).stdout;
    const held = out.indexOf("HELD WORK (blocked; this is not next):");
    const next = out.indexOf("POSSIBLE NEXT WORK (pending; no order implied):");
    expect(held).toBeGreaterThan(-1);
    expect(out.slice(held, next)).toContain("- q-held — parked — blocked on q-gate — continuation: resume the build");
    expect(out.slice(next)).toContain("- q-next — later");
    expect(out.slice(next)).not.toContain("q-held");
  });

  it("names which of the held and next lists was cut, and keeps the older combined notice", () => {
    const w = world();
    const evidence = deriveWorkCandidates([
      { qitemId: "q-held", state: "blocked", summary: "parked", tags: [], blockedOn: "q-gate" },
      { qitemId: "q-next", state: "pending", summary: "later", tags: [] },
    ], w.missions, nothingElse);
    const trace = (flags: Record<string, boolean>) =>
      w.trace(["--trees", "work", "--packet", "--work-candidates", "-"], { ...evidence, ...flags }).stdout;
    const nextCut = trace({ heldTruncated: false, nextTruncated: true, heldAndNextTruncated: true });
    expect(nextCut).toContain("(the next list was cut; `rig queue list --owned --state pending` has the rest)");
    expect(nextCut).not.toContain("held list was cut");
    expect(nextCut).not.toContain("held and next lists were cut");
    const heldCut = trace({ heldTruncated: true, nextTruncated: false, heldAndNextTruncated: true });
    expect(heldCut).toContain("(the held list was cut; `rig queue list --owned --state blocked` has the rest)");
    expect(heldCut).not.toContain("next list was cut");
    expect(trace({ heldTruncated: false, nextTruncated: false, heldAndNextTruncated: false })).not.toContain("was cut");
    // A daemon from before the per-list flags sends only the combined one.
    expect(trace({ heldAndNextTruncated: true })).toContain("(held and next lists were cut; `rig queue list` has the rest)");
  });

  it("carries the seat's job and duties as text, or says the section was not found (W6)", () => {
    const w = world();
    const withSections = w.trace(["--trees", "topology", "--packet", "--topology-start", w.seat]).stdout;
    expect(withSections).toContain("MY JOB HERE\nLead T2 and own its packets.");
    expect(withSections).toContain("STANDING DUTIES\n- keep rows honest");
    expect(withSections).not.toContain("not duties");
    writeFileSync(join(w.seat, "LEARNED.md"), "# Builder\nfree-form practice notes\n", "utf8");
    const without = w.trace(["--trees", "topology", "--packet", "--topology-start", w.seat]).stdout;
    expect(without).toContain(`SECTION NOT FOUND — no "MY JOB HERE" or "STANDING DUTIES" heading in ${join(w.seat, "LEARNED.md")}`);
    expect(without).toContain("free-form practice notes");
  });

  it("carries the notes' current state as text, and names old notes with age, source and threshold (W6, W7)", () => {
    const w = world();
    writeFileSync(join(w.missions, "release-a/NOTES.md"),
      "---\nupdated: 2020-01-01\n---\n# Notes\nhistory\n\n## Current state\nAll green.\n\n## Log\nold entries\n", "utf8");
    writeFileSync(join(w.slice, "NOTES.md"), "# Slice notes\nno conventional section here\n", "utf8");
    const out = w.trace(["--trees", "work", "--packet", "--work-start", w.slice]).stdout;
    expect(out).toContain("NOTES · NOTES.md\nCurrent state\nAll green.");
    expect(out).not.toContain("old entries");
    expect(out).toMatch(new RegExp(`OLD NOTES — ${join(w.missions, "release-a/NOTES.md")}, \\d+ days old, source updated, threshold 14 days`));
    expect(out).toContain(`SECTION NOT FOUND — no "CURRENT STATE" heading in ${join(w.slice, "NOTES.md")}`);
    // A fresh file earns no cue; the threshold is configurable.
    expect(out.match(/OLD NOTES/g)).toHaveLength(1);
    const strict = w.trace(["--trees", "work", "--packet", "--work-start", w.slice], undefined,
      { OPENRIG_REFOCUS_NOTES_MAX_AGE_DAYS: "100000" }).stdout;
    expect(strict).not.toContain("OLD NOTES");
  });

  it("carries PROGRESS.md's current state as text where the SDLC convention keeps it", () => {
    const w = world();
    writeFileSync(join(w.slice, "PROGRESS.md"), "# Progress\n\n## Current state\nBuilding the packet.\n\n## Outcomes\n- earlier\n", "utf8");
    const out = w.trace(["--trees", "work", "--packet", "--work-start", w.slice]).stdout;
    expect(out).toContain("PROGRESS · PROGRESS.md\nCurrent state\nBuilding the packet.");
    expect(out).not.toContain("- earlier");
    // A node without PROGRESS.md is not reported as a gap.
    expect(out.match(/PROGRESS ·/g)).toHaveLength(1);
    const plain = w.trace(["--trees", "work", "--work-start", w.slice]).stdout;
    expect(plain).not.toContain("PROGRESS ·");
  });

  it("keeps the packet's text on the cwd path and at full depth (F1)", () => {
    const w = world();
    writeFileSync(join(w.slice, "NOTES.md"), "---\nupdated: 2020-01-01\n---\n## Current state\nSlice notes now\n", "utf8");
    writeFileSync(join(w.slice, "PROGRESS.md"), "## Current state\nSlice progress now\n", "utf8");
    const fromCwd = spawnSync("python3", [TRACE, "--trees", "work", "--packet"], { encoding: "utf8", env: w.env, cwd: w.slice }).stdout;
    expect(fromCwd).toContain("NOTES · NOTES.md\nCurrent state\nSlice notes now");
    expect(fromCwd).toContain("PROGRESS · PROGRESS.md\nCurrent state\nSlice progress now");
    const full = w.trace(["--trees", "work", "--packet", "--depth", "full", "--work-start", w.slice]).stdout;
    expect(full).toContain("PROGRESS · PROGRESS.md\n## Current state\nSlice progress now");
    expect(full).toMatch(/OLD NOTES — .*NOTES\.md, \d+ days old, source updated, threshold 14 days/);
    // Without --packet, both paths keep today's output.
    const plainCwd = spawnSync("python3", [TRACE, "--trees", "work"], { encoding: "utf8", env: w.env, cwd: w.slice }).stdout;
    expect(plainCwd).toMatch(/NOTES · NOTES\.md · \d+ bytes · /);
    expect(plainCwd).not.toContain("PROGRESS ·");
    const plainFull = w.trace(["--trees", "work", "--depth", "full", "--work-start", w.slice]).stdout;
    expect(plainFull).not.toContain("PROGRESS ·");
    expect(plainFull).not.toContain("OLD NOTES");
  });

  it("names each duty section that is missing even when another matched (O1)", () => {
    const w = world();
    writeFileSync(join(w.seat, "LEARNED.md"), "# Builder\n\n## MY JOB HERE\nLead T2.\n\n## Duties\n- keep rows honest\n", "utf8");
    const out = w.trace(["--trees", "topology", "--packet", "--topology-start", w.seat]).stdout;
    expect(out).toContain("MY JOB HERE\nLead T2.");
    expect(out).toContain(`SECTION NOT FOUND — no "STANDING DUTIES" heading in ${join(w.seat, "LEARNED.md")}`);
    expect(out).toContain("- keep rows honest");
  });

  it("prints a folded mission intent as text in the candidate list (F3)", () => {
    const w = world();
    writeFileSync(join(w.missions, "release-b/SPEC.md"), "---\nintent: >-\n  Ship B,\n  folded\n---\n# B\n", "utf8");
    const evidence = deriveWorkCandidates([
      { qitemId: "q-1", state: "in-progress", tags: ["mission:release-a"] },
      { qitemId: "q-2", state: "in-progress", tags: ["mission:release-b"] },
    ], w.missions, nothingElse);
    const out = w.trace(["--trees", "work", "--packet", "--work-candidates", "-"], evidence).stdout;
    expect(out).toContain("- release-b — Ship B, folded — source: tag mission:release-b on row q-2");
    expect(out).not.toContain(">-");
  });

  it("keeps today's pointer rendering when --packet is off", () => {
    const w = world();
    writeFileSync(join(w.slice, "NOTES.md"), "## Current state\nAll green.\n", "utf8");
    const out = w.trace(["--trees", "work", "--work-start", w.slice]).stdout;
    expect(out).toMatch(/NOTES · NOTES\.md · \d+ bytes · /);
    expect(out).not.toContain("All green.");
  });
});

describe("refocus hook — OPENRIG_REFOCUS_WORK_PACKET switch", () => {
  function fire(w: ReturnType<typeof world>, extra: NodeJS.ProcessEnv) {
    const home = join(w.root, "home");
    mkdirSync(home, { recursive: true });
    const argvLog = join(w.root, "python-argv.log");
    const stdinLog = join(w.root, "python-stdin.log");
    const python = join(w.bin, "python-shim");
    writeFileSync(python, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${argvLog}"\ncat > "${stdinLog}"\nprintf 'TRACE OK'\n`, "utf8");
    chmodSync(python, 0o755);
    const whoami = {
      currentWork: { mission: "release-a", slice: "12-refocus", workNodePath: w.slice, basis: "one typed" },
      currentWorkBasis: "one typed",
      role: { state: "not-declared", files: [] },
      workCandidates: deriveWorkCandidates([{ qitemId: "q-1", state: "in-progress", tags: ["mission:release-a"] }], w.missions, nothingElse),
    };
    const result = spawnSync(process.execPath, [HOOK, "--runtime", "claude"], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "packet-fixture", transcript_path: "" }),
      encoding: "utf8",
      env: { ...w.env, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: "builder@demo", OPENRIG_REFOCUS_NOW: "1",
        OPENRIG_REFOCUS_TREES: "work", OPENRIG_REFOCUS_CONTENT_REF: "", OPENRIG_REFOCUS_CONTENT_FILE: "",
        PYTHON: python, RIG_QUEUE_WHOAMI_STDOUT: JSON.stringify(whoami), ...extra },
    });
    expect(result.status, result.stderr).toBe(0);
    return {
      argv: existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "",
      stdin: existsSync(stdinLog) ? readFileSync(stdinLog, "utf8") : "",
    };
  }

  it("is off by default: no candidates are requested and the trace argv is unchanged", () => {
    const w = world();
    const { argv, stdin } = fire(w, { OPENRIG_REFOCUS_WORK_PACKET: undefined });
    expect(w.calls()).toContain("queue whoami --json\n");
    expect(w.calls()).not.toContain("--work-candidates");
    expect(argv).toContain(`--work-start ${w.slice}`);
    expect(argv).not.toContain("--packet");
    expect(stdin).toBe("");
  });

  it("when on, passes the daemon's candidates to the trace instead of the strict node", () => {
    const w = world();
    const { argv, stdin } = fire(w, { OPENRIG_REFOCUS_WORK_PACKET: "1" });
    expect(w.calls()).toContain("queue whoami --json --work-candidates");
    expect(argv).toContain("--packet");
    expect(argv).toContain("--work-candidates -");
    expect(argv).not.toContain("--work-start");
    expect(JSON.parse(stdin).candidates[0].mission).toBe("release-a");
  });

  it("when on with an older rig CLI that rejects the flag, falls back to the plain whoami (N2)", () => {
    const w = world();
    // An older CLI's plain answer has no workCandidates field.
    const older = JSON.stringify({ currentWork: { mission: "release-a", slice: "12-refocus", workNodePath: w.slice, basis: "one typed" },
      currentWorkBasis: "one typed", role: { state: "not-declared", files: [] } });
    const { argv, stdin } = fire(w, { OPENRIG_REFOCUS_WORK_PACKET: "1", RIG_REJECT_CANDIDATES: "1", RIG_QUEUE_WHOAMI_STDOUT: older });
    expect(w.calls()).toContain("queue whoami --json --work-candidates\nqueue whoami --json\n");
    // The strict answer still arrives, so the trace gets the work node rather than an UNKNOWN.
    expect(argv).toContain(`--work-start ${w.slice}`);
    expect(argv).not.toContain("--work-unknown");
    expect(stdin).toBe("");
  });

  it("when on, an explicit work node still wins and the evidence adds only held and next work", () => {
    const w = world();
    const { argv } = fire(w, { OPENRIG_REFOCUS_WORK_PACKET: "1", OPENRIG_REFOCUS_WORK_NODE: w.slice });
    expect(argv).toContain(`--work-start ${w.slice} --work-candidates -`);
  });
});
