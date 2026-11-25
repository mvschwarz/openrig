import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { refocusTestPython, writeRefocusNpmFixture, writeRefocusCaptureProbe } from "./helpers/refocus-native-fixtures.js";
import { fileURLToPath } from "node:url";
import { deriveCurrentWork, deriveWorkCandidates, frontmatterIntent, type WorkCandidateLookups } from "../src/domain/current-work.js";
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
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "refocus-work-packet-")));
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
  case " $* " in *" --held-work "*) if [ -n "$RIG_REJECT_HELD_WORK" ]; then echo "error: unknown option '--held-work'" >&2; exit 1; fi;; esac
  printf '%s' "$RIG_QUEUE_WHOAMI_STDOUT"; exit 0
fi
if [ "$1 $2" = "whoami --json" ]; then printf '{"identity":{"rigName":"demo","sessionName":"builder@demo"}}\\n'; exit 0; fi
if [ "$1 $2" = "config --json" ]; then printf '{}'; exit 0; fi
if [ "$1 $2 $3" = "scope mission show" ]; then
  case "$4" in */release-a) if [ -n "$RIG_PARENT_REPLY" ]; then printf '%s' "$RIG_PARENT_REPLY"; else printf '{"mission":{"parentChain":[],"parentGap":null}}'; fi;; *) printf '{"mission":{"parentChain":[],"parentGap":null}}';; esac; exit 0
fi
if [ "$1 $2" = "scope resolve-notes" ]; then
  if [ -r "$3/NOTES.md" ]; then printf '{"ok":true,"resolution":{"path":"%s","name":"NOTES.md"}}\\n' "$3/NOTES.md"; exit 0; fi
  printf '{"ok":true,"resolution":null}\\n'; exit 0
fi
exit 1
`, "utf8");
  chmodSync(rig, 0o755);
  if (process.platform === "win32") writeRefocusNpmFixture(bin, `
const fs=require('fs'),args=process.argv.slice(2),env=process.env;
fs.appendFileSync(env.RIG_CALL_LOG,args.join(' ')+'\\n');
const verb=args.slice(0,2).join(' ');
if(verb==='queue whoami'){if(args.includes('--work-candidates')&&env.RIG_REJECT_CANDIDATES){process.stderr.write("error: unknown option '--work-candidates'");process.exit(1);}process.stdout.write(env.RIG_QUEUE_WHOAMI_STDOUT||'');process.exit(0);}
if(verb==='whoami --json'){console.log(JSON.stringify({identity:{rigName:'demo',sessionName:'builder@demo'}}));process.exit(0);}
if(verb==='config --json'){console.log('{}');process.exit(0);}
if(args.slice(0,3).join(' ')==='scope mission show'){process.stdout.write(require('path').basename(args[3])==='release-a'&&env.RIG_PARENT_REPLY?env.RIG_PARENT_REPLY:JSON.stringify({mission:{parentChain:[],parentGap:null}}));process.exit(0);}
if(verb==='scope resolve-notes'){const p=require('path').join(args[2],'NOTES.md');console.log(JSON.stringify({ok:true,resolution:fs.existsSync(p)?{path:p,name:'NOTES.md'}:null}));process.exit(0);}
process.exit(1);
`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [bin, process.env.PATH || ""].join(delimiter),
    ...(process.platform === "win32" ? { OPENRIG_NODE: process.execPath, PYTHON: refocusTestPython(), PYTHONIOENCODING: "utf-8" } : {}),
    OPENRIG_TOPOLOGY_ROOT: topology,
    OPENRIG_WORKSPACE_ROOT: workspace,
    OPENRIG_REFOCUS_WORK_NODE: undefined,
    OPENRIG_REFOCUS_TOPOLOGY_NODE: undefined,
    OPENRIG_REFOCUS_NOTES_MAX_AGE_DAYS: undefined,
    RIG_CALL_LOG: calls,
  };
  const trace = (args: string[], evidence?: unknown, extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(refocusTestPython(), [TRACE, ...args], {
    encoding: "utf8", env: { ...env, ...extra }, input: evidence === undefined ? "" : JSON.stringify(evidence),
    });
    return { ...result, stdout: result.stdout?.replace(/\r\n/g, "\n") };
  };
  return { root, workspace, missions, topology, seat, slice, bin, env, trace,
    calls: () => (existsSync(calls) ? readFileSync(calls, "utf8") : "") };
}

describe("deriveWorkCandidates — labelled evidence beside the strict derivation", () => {
  it("offers a mission-tagged, slice-less row as a direct candidate with its source and intent (W2)", () => {
    const w = world();
    const out = deriveWorkCandidates([{ qitemId: "q-1", state: "in-progress", tags: ["mission:release-a"] }], w.missions, nothingElse);
    expect(out.candidates).toEqual([{
      kind: "tag", qitemId: "q-1", projects: [], mission: "release-a", slice: null,
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
    expect(out.held).toEqual([{ qitemId: "q-held", summary: "parked", blockedOn: "q-gate", continuation: "resume the build",
      missions: ["release-a"], slice: null, missionPath: join(w.missions, "release-a"), slicePath: null, unresolved: null, missionsRootFallback: null }]);
    expect(out.next).toEqual([{ qitemId: "q-next", summary: "later",
      missions: ["release-b"], slice: null, missionPath: join(w.missions, "release-b"), slicePath: null, unresolved: null, missionsRootFallback: null }]);
  });

  it("gives each held and pending row its own resolved scope, and its first body line when it has no summary", () => {
    const w = world();
    const out = deriveWorkCandidates([
      { qitemId: "q-held", state: "blocked", summary: "", body: "\n---\n## Fix the parked build\nmore detail", tags: ["mission:release-a"], blockedOn: "q-gate" },
      { qitemId: "q-slice", state: "pending", summary: null, tags: ["mission:release-a", "slice:12-refocus"] },
      { qitemId: "q-gone", state: "pending", summary: "s", tags: ["mission:release", "slice:12-refocus"] },
      { qitemId: "q-typo", state: "pending", summary: "s", tags: ["mission:release-a", "slice:99-none"] },
      { qitemId: "q-two", state: "pending", summary: "s", tags: ["mission:release-a", "mission:release-b"] },
      { qitemId: "q-done", state: "done", summary: "finished", tags: ["mission:release-b"] },
    ], w.missions, nothingElse);
    const missionA = join(w.missions, "release-a");
    expect(out.held).toEqual([{ qitemId: "q-held", summary: "Fix the parked build", blockedOn: "q-gate", continuation: null,
      missions: ["release-a"], slice: null, missionPath: missionA, slicePath: null, unresolved: null, missionsRootFallback: null }]);
    expect(out.next).toEqual([
      { qitemId: "q-slice", summary: null, missions: ["release-a"], slice: "12-refocus", missionPath: missionA, slicePath: w.slice, unresolved: null, missionsRootFallback: null },
      { qitemId: "q-gone", summary: "s", missions: ["release"], slice: "12-refocus", missionPath: null, slicePath: null,
        unresolved: "mission release resolves to 0 directories on this host", missionsRootFallback: null },
      { qitemId: "q-typo", summary: "s", missions: ["release-a"], slice: "99-none", missionPath: missionA, slicePath: null,
        unresolved: "slice 99-none resolves to 0 directories under release-a", missionsRootFallback: null },
      { qitemId: "q-two", summary: "s", missions: ["release-a", "release-b"], slice: null, missionPath: null, slicePath: null,
        unresolved: "2 mission tags; none is resolved on its own", missionsRootFallback: null },
    ]);
    // Completed work is never held or next, and nothing here is current work.
    expect(JSON.stringify(out)).not.toContain("q-done");
    expect(out.candidates).toEqual([]);
  });

  it("resolves a held row through its own project's missions root, so one mission name in two projects is two directories", () => {
    const w = world();
    const other = join(w.root, "other/missions/release-a");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "SPEC.md"), "---\nintent: Another project's A\n---\n", "utf8");
    const byProject = (row: { tags?: string[] | null }) =>
      ((row.tags ?? []).includes("project:other") ? join(w.root, "other/missions") : w.missions);
    const out = deriveWorkCandidates([
      { qitemId: "q-1", state: "blocked", tags: ["project:main", "mission:release-a"] },
      { qitemId: "q-2", state: "pending", tags: ["project:other", "mission:release-a"] },
    ], byProject, nothingElse, w.missions);
    expect(out.held[0]!.missionPath).toBe(join(w.missions, "release-a"));
    expect(out.next[0]!.missionPath).toBe(other);
  });

  it("keeps why a row's tags were resolved under the configured root instead of its project's, even when they resolved", () => {
    const w = world();
    const reason = "project:ghost is not in the project catalogue; used configured root";
    const fallbackForGhost = (row: { tags?: string[] | null }) =>
      ((row.tags ?? []).includes("project:ghost") ? { root: w.missions, reason, ambiguous: true } : { root: w.missions });
    const out = deriveWorkCandidates([
      { qitemId: "q-found", state: "blocked", tags: ["project:ghost", "mission:release-a", "slice:12-refocus"] },
      { qitemId: "q-missing", state: "pending", tags: ["project:ghost", "mission:release"] },
      { qitemId: "q-own", state: "pending", tags: ["mission:release-a"] },
    ], fallbackForGhost, nothingElse, w.missions);
    expect(out.held[0]).toMatchObject({ missionPath: join(w.missions, "release-a"), slicePath: w.slice, unresolved: null, missionsRootFallback: reason });
    expect(out.next[0]).toMatchObject({ missionPath: null, unresolved: "mission release resolves to 0 directories on this host", missionsRootFallback: reason });
    // A stand-in that is the only root (no catalogue configured) carries its reason for the basis, but no fallback.
    const onlyRoot = deriveWorkCandidates([{ qitemId: "q-solo", state: "blocked", tags: ["project:solo", "mission:release-a"] }],
      () => ({ root: w.missions, reason: "project:solo could not be used because the workspace catalog is not configured; used configured root" }),
      nothingElse, w.missions);
    expect(onlyRoot.held[0]).toMatchObject({ missionPath: join(w.missions, "release-a"), unresolved: null, missionsRootFallback: null });
    expect(out.next[1]).toMatchObject({ missionPath: join(w.missions, "release-a"), unresolved: null, missionsRootFallback: null });
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

  it("reads the same intent from a CRLF SPEC.md as from its LF twin", () => {
    for (const lf of [
      "---\nid: x\nintent: >-\n  Ship the\n  alpha thing\nstage: wip\n---\n# A\n",
      "---\nintent: |\n  one\n  two\n---\n",
      "---\nintent: \"quoted: yes\"\n---\n",
      "---\nintent: plain words\n---\n",
    ]) {
      const expected = frontmatterIntent(lf);
      expect(expected).not.toBeNull();
      expect(frontmatterIntent(lf.replace(/\n/g, "\r\n"))).toBe(expected);
    }
  });
});

describe("trace-to-root --packet — the work packet as text", () => {
  it("keeps the age cue for old progress without a current-state section", () => {
    const w = world();
    writeFileSync(join(w.slice, "PROGRESS.md"), "---\nupdated: 2020-01-02\n---\n# Progress\n\n## Notes\n\nOld work\n", "utf8");
    const result = w.trace(["--trees", "work", "--packet", "--work-start", w.slice]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("OLD NOTES");
    expect(result.stdout).not.toContain("CURRENT STATE —");
  });

  it.each([
    '"progress_rail": readme-only\n"current_state_updated": "2020-01-02T03:04:05.000Z"',
    '{progress_rail: readme-only, current_state_updated: "2020-01-02T03:04:05.000Z"}',
  ])("parses quoted and flow YAML metadata: %s", (frontmatter) => {
    const w = world();
    writeFileSync(join(w.slice, "SPEC.md"), `---\n${frontmatter}\n---\n# Slice\n\n## Current state ##\n\nReady\n`, "utf8");
    const result = w.trace(["--trees", "work", "--packet", "--work-start", w.slice]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout, result.stdout).toContain("PROGRESS · SPEC.md");
    expect(result.stdout).toContain("CURRENT STATE — written 2020-01-02T03:04:05.000Z");
    expect(result.stdout).toContain("Ready");
  });

  it("reports the current-state timestamp instead of the file modification time", () => {
    const w = world();
    writeFileSync(join(w.slice, "PROGRESS.md"), '---\ncurrent_state_updated: "2020-01-02T03:04:05.000Z"\n---\n# Progress\n\n## Current state\n\nWaiting\n', "utf8");
    const result = w.trace(["--trees", "work", "--packet", "--work-start", w.slice]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("CURRENT STATE — written 2020-01-02T03:04:05.000Z");
    expect(result.stdout).toContain("Waiting");
  });
  it("includes a readme-only rail in the work packet", () => {
    const w = world();
    writeFileSync(join(w.slice, "SPEC.md"), '---\nintent: Work\nprogress_rail: readme-only\ncurrent_state_updated: "2020-01-02T03:04:05.000Z"\n---\n# Slice\n\n## Current state\n\nReady\n', "utf8");
    const result = w.trace(["--trees", "work", "--packet", "--work-start", w.slice]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("PROGRESS · SPEC.md");
    expect(result.stdout).toContain("CURRENT STATE — written 2020-01-02T03:04:05.000Z");
    expect(result.stdout).toContain("Ready");
  });
  it("traces the logical parent intent, not just filesystem ancestors", () => {
    const w = world();
    writeFileSync(join(w.missions, "release-a", "mission.yaml"), "metadata:\n  parent: M.2\n");
    const reply = JSON.stringify({ mission: { parentChain: [{ id: "M.2", path: join(w.missions, "release-b"), kind: "mission", intent: "Ship B" }], parentGap: null } });
    const result = w.trace(["--trees", "work", "--packet", "--work-start", w.slice], undefined, { RIG_PARENT_REPLY: reply });
    expect(result.stdout).toContain("PARENT · M.2");
    expect(result.stdout).toContain("intent: Ship B");
  });
  it("selects the project workspace for a nested missions root", () => {
    const w = world();
    const nested = join(w.workspace, "internal", "nested");
    const child = join(nested, "release-a");
    const parent = join(nested, "release-b");
    mkdirSync(child, { recursive: true }); mkdirSync(parent, { recursive: true });
    writeFileSync(join(w.workspace, "project.yaml"), "missions:\n  root: internal/nested\n");
    writeFileSync(join(child, "SPEC.md"), "---\nintent: Child\n---\n");
    writeFileSync(join(child, "mission.yaml"), "metadata:\n  parent: M.2\n");
    const reply = JSON.stringify({ mission: { parentChain: [{ id: "M.2", path: parent, kind: "mission", intent: "Parent" }], parentGap: null } });
    const result = w.trace(["--trees", "work", "--packet", "--work-start", child], undefined, { RIG_PARENT_REPLY: reply });
    expect(result.stdout).toContain("PARENT · M.2");
    expect(w.calls()).toContain(`--workspace ${w.workspace} --json`);
  });
  it("does not select a project above the selected work root", () => {
    const w = world();
    writeFileSync(join(w.root, "project.yaml"), "missions:\n  root: outside\n");
    writeFileSync(join(w.missions, "release-a", "mission.yaml"), "metadata:\n  parent: M.2\n");
    const reply = JSON.stringify({ mission: { parentChain: [{ id: "M.2", path: join(w.missions, "release-b"), kind: "mission", intent: "Parent" }], parentGap: null } });
    const result = w.trace(["--trees", "work", "--packet", "--work-start", join(w.missions, "release-a")], undefined, { RIG_PARENT_REPLY: reply });
    expect(result.stdout).toContain("PARENT · M.2");
    expect(w.calls()).toContain(`--workspace ${w.missions} --json`);
    expect(w.calls()).not.toContain(`--workspace ${w.root} --json`);
  });
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
    expect(nextCut).toContain("(the next list was cut: 1 of more than 1 shown; `rig queue list --owned --state pending` has the rest)");
    expect(nextCut).not.toContain("held list was cut");
    expect(nextCut).not.toContain("held and next lists were cut");
    const heldCut = trace({ heldTruncated: true, nextTruncated: false, heldAndNextTruncated: true });
    expect(heldCut).toContain("(the held list was cut: 1 of more than 1 shown; `rig queue list --owned --state blocked` has the rest)");
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
    const notesPath = join(w.missions, "release-a/NOTES.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(out).toMatch(new RegExp(`OLD NOTES — ${notesPath}, \\d+ days old, source updated, threshold 14 days`));
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
    const fromCwd = spawnSync(refocusTestPython(), [TRACE, "--trees", "work", "--packet"], { encoding: "utf8", env: w.env, cwd: w.slice }).stdout.replace(/\r\n/g, "\n");
    expect(fromCwd).toContain("NOTES · NOTES.md\nCurrent state\nSlice notes now");
    expect(fromCwd).toContain("PROGRESS · PROGRESS.md\nCurrent state\nSlice progress now");
    const full = w.trace(["--trees", "work", "--packet", "--depth", "full", "--work-start", w.slice]).stdout;
    expect(full).toContain("PROGRESS · PROGRESS.md\n## Current state\nSlice progress now");
    expect(full).toMatch(/OLD NOTES — .*NOTES\.md, \d+ days old, source updated, threshold 14 days/);
    // Without --packet, both paths keep today's output.
    const plainCwd = spawnSync(refocusTestPython(), [TRACE, "--trees", "work"], { encoding: "utf8", env: w.env, cwd: w.slice }).stdout.replace(/\r\n/g, "\n");
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

  it("bounds each held and next row to one line with a pointer, and shows at most 20 held and 10 next with the full count", () => {
    const w = world();
    const long = (word: string, n: number) => `${word} `.repeat(n).trim();
    const rows = [
      ...Array.from({ length: 23 }, (_, i) => ({ qitemId: `q-held-${i}`, state: "blocked", tags: [], blockedOn: "q-gate",
        summary: i === 0 ? `first line\n${long("summary", 100)}` : `held ${i}` })),
      ...Array.from({ length: 12 }, (_, i) => ({ qitemId: `q-next-${i}`, state: "pending", tags: [], summary: `next ${i}` })),
    ];
    const evidence = deriveWorkCandidates(rows, w.missions,
      { getRow: () => null, continuationOf: (id) => (id === "q-held-0" ? long("continue", 300) : null) });
    const out = w.trace(["--trees", "work", "--packet", "--work-candidates", "-"],
      { ...evidence, heldTruncated: false, nextTruncated: false, heldAndNextTruncated: false }).stdout;
    const first = out.split("\n").find((line) => line.startsWith("- q-held-0 "))!;
    expect(first.length).toBeLessThan(500);
    expect(first).toContain("first line summary summary");
    expect(first).toContain("…");
    expect(first).toMatch(/— full row: rig queue show q-held-0$/);
    expect(out).not.toContain("continue ".repeat(100));
    expect(out).toContain("- q-held-19 — held 19");
    expect(out).not.toContain("q-held-20");
    expect(out).toContain("(the held list was cut: 20 of 23 shown; `rig queue list --owned --state blocked` has the rest)");
    expect(out).toContain("- q-next-9 — next 9");
    expect(out).not.toContain("q-next-10");
    expect(out).toContain("(the next list was cut: 10 of 12 shown; `rig queue list --owned --state pending` has the rest)");
    // A short row is unchanged: no ellipsis, no pointer.
    expect(out).toContain("- q-held-1 — held 1 — blocked on q-gate — continuation: none recorded\n");
  });

  it("cuts a long matched section body at about 1,500 characters with the --depth full pointer", () => {
    const w = world();
    const state = Array.from({ length: 200 }, (_, i) => `- state line ${i}`).join("\n");
    writeFileSync(join(w.slice, "NOTES.md"), `## Current state\n${state}\n\n## Log\nold\n`, "utf8");
    writeFileSync(join(w.slice, "PROGRESS.md"), `## Current state\n${state}\n`, "utf8");
    writeFileSync(join(w.seat, "LEARNED.md"), `# Builder\n\n## MY JOB HERE\n${state}\n\n## STANDING DUTIES\n- keep rows honest\n`, "utf8");
    const work = w.trace(["--trees", "work", "--packet", "--work-start", w.slice]).stdout;
    for (const label of ["NOTES · NOTES.md", "PROGRESS · PROGRESS.md"]) {
      const body = work.slice(work.indexOf(label)).split("\n\n")[0]!;
      expect(body.length).toBeLessThan(1_700);
      expect(body).toContain("- state line 0");
      expect(body).toContain("[… use --depth full for the rest]");
    }
    expect(work).not.toContain("- state line 199");
    const duties = w.trace(["--trees", "topology", "--packet", "--topology-start", w.seat]).stdout;
    expect(duties).toContain("[… use --depth full for the rest]");
    expect(duties).toContain("STANDING DUTIES\n- keep rows honest");
    expect(duties).not.toContain("- state line 199");
    // At full depth nothing is cut.
    const full = w.trace(["--trees", "work", "--packet", "--depth", "full", "--work-start", w.slice]).stdout;
    expect(full).toContain("- state line 199");
  });

  it("keeps today's pointer rendering when --packet is off", () => {
    const w = world();
    writeFileSync(join(w.slice, "NOTES.md"), "## Current state\nAll green.\n", "utf8");
    const out = w.trace(["--trees", "work", "--work-start", w.slice]).stdout;
    expect(out).toMatch(/NOTES · NOTES\.md · \d+ bytes · /);
    expect(out).not.toContain("All green.");
  });
});

describe("trace-to-root with nothing in progress — held and pending work as context, never current work", () => {
  const NO_BATON = deriveCurrentWork([], "/missions").currentWorkBasis;
  type Row = Parameters<typeof deriveWorkCandidates>[0][number];
  /** What the plain whoami answer carries as heldAndPendingWork, built by the same derivation. */
  const heldWork = (w: ReturnType<typeof world>, rows: Row[], extra: object = {},
    resolver: Parameters<typeof deriveWorkCandidates>[1] = w.missions) => {
    const { held, next } = deriveWorkCandidates(rows, resolver, nothingElse, null);
    return { missionsRoot: w.missions, held, next, heldTruncated: false, nextTruncated: false, ...extra };
  };
  // The hook always passes --check; none of these is a failure.
  const plain = (w: ReturnType<typeof world>, held: unknown, args: string[] = []) =>
    w.trace(["--trees", "work", "--check", "--unresolved-work-advisory", "--work-basis", NO_BATON, "--held-work", "-", ...args], held);
  const packet = (w: ReturnType<typeof world>, rows: Row[]) =>
    w.trace(["--trees", "work", "--check", "--packet", "--work-candidates", "-"], { ...deriveWorkCandidates(rows, w.missions, nothingElse),
      heldTruncated: false, nextTruncated: false, heldAndNextTruncated: false });
  const parked = (tags: string[], qitemId = "q-held"): Row => ({ qitemId, state: "blocked", summary: "parked", tags, blockedOn: "q-gate" });
  const pending = (tags: string[], qitemId = "q-next"): Row => ({ qitemId, state: "pending", summary: "later", tags });
  const CONTEXT = "CONTEXT FROM HELD AND PENDING WORK — nothing is in progress";
  /** The command a listed choice prints for reading its folder, run as the agent's own call. */
  const route = (folder: string, workRoot?: string) =>
    `python3 ${TRACE} --trees work --packet${workRoot ? ` --work-root ${workRoot}` : ""} --work-start ${folder}`;

  it("traces the one slice a held row resolves to, labelled as context with the row listed as held (held-only)", () => {
    const w = world();
    const result = plain(w, heldWork(w, [parked(["mission:release-a", "slice:12-refocus"])]));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`## WORK TRACE\n${CONTEXT}, and every held and pending row (1 held, 0 pending) resolves to this slice. `
      + "It is context, not your current work: using it does not resume a task.");
    expect(result.stdout).toContain(`start: ${w.slice}`);
    expect(result.stdout).toContain("intent: Ship A");
    expect(result.stdout).toContain("intent: Refocus knows the work");
    expect(result.stdout).toContain("HELD WORK (blocked; this is not next):\n- q-held — parked — blocked on q-gate — continuation: none recorded [mission: release-a / slice: 12-refocus]");
    expect(result.stdout).not.toContain("FALLBACK");
    expect(result.stdout).not.toContain("WORK FROM QUEUE EVIDENCE");
  });

  it("traces the mission a pending row names (pending-only)", () => {
    const w = world();
    const result = plain(w, heldWork(w, [pending(["mission:release-b"])]));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("(0 held, 1 pending) resolves to this mission (no slice named)");
    expect(result.stdout).toContain(`start: ${join(w.missions, "release-b")}`);
    expect(result.stdout).toContain("intent: Ship B");
    expect(result.stdout).toContain("POSSIBLE NEXT WORK (pending; no order implied):\n- q-next — later [mission: release-b]");
    expect(result.stdout).not.toContain("FALLBACK");
  });

  it("reaches the mission for a held row with a mission tag and no slice", () => {
    const w = world();
    const result = plain(w, heldWork(w, [parked(["mission:release-a"])]));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("(1 held, 0 pending) resolves to this mission (no slice named)");
    expect(result.stdout).toContain(`start: ${join(w.missions, "release-a")}`);
    expect(result.stdout).toContain("intent: Ship A");
    expect(result.stdout).not.toContain("Refocus knows the work");
  });

  it("stops at the mission when the rows share it but name different slices", () => {
    const w = world();
    mkdirSync(join(w.missions, "release-a/slices/13-other"), { recursive: true });
    writeFileSync(join(w.missions, "release-a/slices/13-other/SPEC.md"), "---\nintent: Other slice\n---\n", "utf8");
    const result = plain(w, heldWork(w, [parked(["mission:release-a", "slice:12-refocus"]), pending(["mission:release-a", "slice:13-other"])]));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("(1 held, 1 pending) resolves to this mission (not every row resolves to one slice, so it stops at the mission)");
    expect(result.stdout).toContain(`start: ${join(w.missions, "release-a")}\n`);
    expect(result.stdout).not.toContain("Refocus knows the work");
    expect(result.stdout).not.toContain("Other slice");
    // A slice that does not resolve stops there too, and its row says why.
    const typo = plain(w, heldWork(w, [parked(["mission:release-a", "slice:12-refocus"]), pending(["mission:release-a", "slice:99-none"])]));
    expect(typo.stdout).toContain("resolves to this mission (not every row resolves to one slice, so it stops at the mission)");
    expect(typo.stdout).toContain("- q-next — later [mission: release-a / slice: 99-none] — UNRESOLVED ON THIS HOST: slice 99-none resolves to 0 directories under release-a");
    expect(typo.stdout).not.toContain("Refocus knows the work");
  });

  it("lists conflicting missions, each with the command that reads it, and keeps the broad orientation", () => {
    const w = world();
    const result = plain(w, heldWork(w, [parked(["mission:release-a", "slice:12-refocus"]), pending(["mission:release-b"])]));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("## WORK — name it\nNo in-progress queue row names your work.");
    expect(result.stdout).toContain("does not settle one mission (the rows name different missions). Choosing one does not resume a task. "
      + `The missions it names, each with the command that reads it:\n- release-a / 12-refocus — ${w.slice}\n  ${route(w.slice)}\n`
      + `- release-b — ${join(w.missions, "release-b")}\n  ${route(join(w.missions, "release-b"))}\n`);
    // Every choice has its own command, so the generic <mission> route is not printed.
    expect(result.stdout).not.toContain("<mission>");
    expect(result.stdout).toContain(`FALLBACK — no current typed baton (${NO_BATON})`);
    expect(result.stdout).not.toContain(CONTEXT);
    expect(result.stdout).not.toContain("intent: Ship A");
  });

  it("quotes the script's own path in each choice's command, so an install folder with a space stays one argument", () => {
    const w = world();
    const copy = join(w.root, "tools with space", "trace-to-root.py");
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(TRACE, copy);
    const result = spawnSync(process.env.OPENRIG_TEST_PYTHON || "python3",
      [copy, "--trees", "work", "--check", "--unresolved-work-advisory", "--work-basis", NO_BATON, "--held-work", "-"],
      { encoding: "utf8", env: w.env, input: JSON.stringify(heldWork(w, [parked(["mission:release-a", "slice:12-refocus"]), pending(["mission:release-b"])])) });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`\n  python3 '${copy}' --trees work --packet --work-start ${w.slice}\n`);
  });

  /** Runs a printed command as the agent's own call: a fresh shell with none of this run's roots. */
  const follow = (w: ReturnType<typeof world>, command: string) => spawnSync("/bin/sh", ["-c", command], { encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: w.root, OPENRIG_WORKSPACE_ROOT: w.workspace } });

  it("quotes a missions root with a space once in the generic route, so the command reads the mission the agent names", () => {
    const w = world();
    const spaced = join(w.workspace, "my missions");
    mkdirSync(join(spaced, "m1"), { recursive: true });
    writeFileSync(join(spaced, "m1/SPEC.md"), "---\nintent: a mission under a root with a space\n---\n", "utf8");
    const generic = `--work-start '${spaced}'/<mission>`;
    const followed = (stdout: string) => {
      const command = stdout.split("\n").find((line) => line.includes("<mission>"))!.trim();
      expect(command.endsWith(generic), command).toBe(true);
      return follow(w, command.replace("<mission>", "m1"));
    };
    // Packet off: a row's mission doesn't resolve, so the generic route names the configured missions root.
    const held = { ...heldWork(w, [parked(["mission:release-a"]), pending(["mission:release"], "q-gone")]), missionsRoot: spaced };
    const result = plain(w, held);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("- release — UNRESOLVED ON THIS HOST: mission release resolves to 0 directories on this host\n"
      + "Then read that mission's current intent as text:\n");
    const off = followed(result.stdout);
    expect(off.status, off.stdout + off.stderr).toBe(0);
    expect(off.stdout).toContain("intent: a mission under a root with a space");
    // The work-packet path's same route, which names the daemon's missions root, quotes it the same way.
    const packed = w.trace(["--trees", "work", "--check", "--packet", "--work-candidates", "-"],
      { candidates: [], unknown: [], held: [], next: [], missionsOnHost: ["m1"], missionsRoot: spaced });
    expect(packed.status, packed.stdout + packed.stderr).toBe(0);
    const on = followed(packed.stdout);
    expect(on.status, on.stdout + on.stderr).toBe(0);
    expect(on.stdout).toContain("intent: a mission under a root with a space");
  });

  it("bounds a long or multiline scope to one line per tag and reason, with the row's pointer, and keeps the folder's path exact", () => {
    const w = world();
    const longName = `m-${"y".repeat(200)}`;
    mkdirSync(join(w.missions, longName), { recursive: true });
    writeFileSync(join(w.missions, longName, "SPEC.md"), "---\nintent: the long-named mission\n---\n", "utf8");
    const multiline = "release-a\nINJECTED LINE FROM A TAG";
    const result = plain(w, heldWork(w, [parked([`mission:${longName}`], "q-long"), pending([`mission:${multiline}`], "q-multi")]));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const lines = result.stdout.split("\n");
    // A tag's second line never becomes a line of its own, in the rows or in the choices.
    expect(lines.filter((line) => line.startsWith("INJECTED"))).toEqual([]);
    const cutName = `m-${"y".repeat(157)}…`;
    expect(lines).toContain(`- q-long — parked — blocked on q-gate — continuation: none recorded [mission: ${cutName}] — full row: rig queue show q-long`);
    expect(lines).toContain("- q-multi — later [mission: release-a INJECTED LINE FROM A TAG] — UNRESOLVED ON THIS HOST: "
      + "mission release-a INJECTED LINE FROM A TAG resolves to 0 directories on this host — full row: rig queue show q-multi");
    // The choice is bounded the same way; its folder and the command that reads it keep the whole path.
    const folder = join(w.missions, longName);
    expect(result.stdout).toContain(`\n- ${cutName} — ${folder} — full row: rig queue show q-long\n  ${route(folder)}\n`);
    expect(lines).toContain("- release-a INJECTED LINE FROM A TAG — UNRESOLVED ON THIS HOST: "
      + "mission release-a INJECTED LINE FROM A TAG resolves to 0 directories on this host — full row: rig queue show q-multi");
    const read = follow(w, route(folder));
    expect(read.status, read.stdout + read.stderr).toBe(0);
    expect(read.stdout).toContain("intent: the long-named mission");
    // A reason past the bound is cut too.
    const reason = `project:ghost could not be used ${"z".repeat(300)}`;
    const fallback = plain(w, heldWork(w, [parked(["project:ghost", "mission:release-a"], "q-ghost")], {},
      () => ({ root: w.missions, reason, ambiguous: true })));
    expect(fallback.stdout).toContain(`[mission: release-a] — RESOLVED ONLY THROUGH A FALLBACK MISSIONS ROOT: ${reason.slice(0, 159)}… — full row: rig queue show q-ghost`);
    expect(fallback.stdout).not.toContain("z".repeat(300));
  });

  it("gives one mission name in two project roots no shared chain", () => {
    const w = world();
    const other = join(w.root, "other/missions");
    mkdirSync(join(other, "release-a"), { recursive: true });
    writeFileSync(join(other, "release-a/SPEC.md"), "---\nintent: Another project's A\n---\n", "utf8");
    const byProject = (row: { tags?: string[] | null }) => ((row.tags ?? []).includes("project:other") ? other : w.missions);
    const result = plain(w, heldWork(w, [parked(["mission:release-a"]), pending(["project:other", "mission:release-a"])], {}, byProject));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("(the rows name different missions)");
    expect(result.stdout).toContain(`- release-a — ${join(w.missions, "release-a")}\n  ${route(join(w.missions, "release-a"))}\n`
      + `- release-a — ${join(other, "release-a")}\n  ${route(join(other, "release-a"))}\n`);
    expect(result.stdout).not.toContain(CONTEXT);
    expect(result.stdout).not.toContain("Another project's A");
  });

  it.each([
    ["a cut held list", { heldTruncated: true }, [], "the held or pending list was cut, so rows past the cut may name other work"],
    ["a cut list from a daemon before the per-list flags", { heldTruncated: undefined, nextTruncated: undefined, heldAndNextTruncated: true }, [],
      "the held or pending list was cut"],
    ["an unresolved mission", {}, [pending(["mission:release"], "q-gone")], "a row's mission did not resolve to one directory here"],
    ["a row with no mission", {}, [pending([], "q-untagged")], "a row names no mission"],
  ] as const)("keeps partial evidence partial: %s", (_label, flags, extraRows, why) => {
    const w = world();
    const result = plain(w, heldWork(w, [parked(["mission:release-a"]), ...extraRows], flags));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`does not settle one mission (${why}`);
    expect(result.stdout).toContain(`- release-a — ${join(w.missions, "release-a")}`);
    expect(result.stdout).toContain(`FALLBACK — no current typed baton (${NO_BATON})`);
    expect(result.stdout).not.toContain(CONTEXT);
    if (extraRows.some((row) => row.qitemId === "q-gone")) {
      expect(result.stdout).toContain("- release — UNRESOLVED ON THIS HOST: mission release resolves to 0 directories on this host");
    }
  });

  it("keeps a mission found only through a fallback missions root partial, and says so on the row", () => {
    const w = world();
    const reason = "project:ghost is not in the project catalogue; used configured root";
    const fallbackForGhost = (row: { tags?: string[] | null }) =>
      ((row.tags ?? []).includes("project:ghost") ? { root: w.missions, reason, ambiguous: true } : { root: w.missions });
    for (const rows of [[parked(["project:ghost", "mission:release-a"])],
      [parked(["mission:release-a"]), pending(["project:ghost", "mission:release-a"])]]) {
      const result = plain(w, heldWork(w, rows, {}, fallbackForGhost));
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("does not settle one mission (a row's mission resolved only through a fallback missions root)");
      expect(result.stdout).toContain(`[mission: release-a] — RESOLVED ONLY THROUGH A FALLBACK MISSIONS ROOT: ${reason}`);
      expect(result.stdout).toContain(`- release-a — ${join(w.missions, "release-a")} — RESOLVED ONLY THROUGH A FALLBACK MISSIONS ROOT: ${reason}`);
      expect(result.stdout).not.toContain(CONTEXT);
      expect(result.stdout).not.toContain("UNRESOLVED ON THIS HOST");
    }
    // A scope that did not resolve keeps the UNRESOLVED prefix, with the fallback named beside it.
    const missing = plain(w, heldWork(w, [parked(["project:ghost", "mission:release"])], {}, fallbackForGhost));
    expect(missing.stdout).toContain(`UNRESOLVED ON THIS HOST: mission release resolves to 0 directories on this host (through a fallback missions root: ${reason})`);
  });

  it("lets project-tagged rows share one trace when their stand-in root is the only root", () => {
    const w = world();
    const onlyRoot = () => ({ root: w.missions, reason: "project:solo could not be used because the workspace catalog is not configured; used configured root" });
    const result = plain(w, heldWork(w, [parked(["project:solo", "mission:release-a"]), pending(["project:solo", "mission:release-a"])], {}, onlyRoot));
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`${CONTEXT}, and every held and pending row (1 held, 1 pending) resolves to this mission (no slice named).`);
    expect(result.stdout).toContain("intent: Ship A");
    expect(result.stdout).not.toContain("FALLBACK MISSIONS ROOT");
  });

  it("gives a choice outside workspace.root a command that names the root holding it, and runs as the agent's own call", () => {
    const w = world();
    const projectB = join(w.root, "project-b");
    const outside = join(projectB, "missions");
    mkdirSync(join(outside, "m1"), { recursive: true });
    writeFileSync(join(projectB, "SPEC.md"), "---\nintent: ship project b\n---\n", "utf8");
    writeFileSync(join(outside, "m1/SPEC.md"), "---\nintent: mission one\n---\n", "utf8");
    const byProject = (row: { tags?: string[] | null }) => ((row.tags ?? []).includes("project:b") ? outside : w.missions);
    const rows = [parked(["mission:release-a"]), pending(["project:b", "mission:m1"])];
    const result = plain(w, heldWork(w, rows, {}, byProject), ["--work-root", projectB]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`- release-a — ${join(w.missions, "release-a")}\n  ${route(join(w.missions, "release-a"))}\n`);
    expect(result.stdout).toContain(`- m1 — ${join(outside, "m1")}\n  ${route(join(outside, "m1"), projectB)}`);
    expect(result.stdout).not.toContain("<mission>");
    // The printed command, in a fresh process with none of this run's roots, reads the mission's intent.
    const command = result.stdout.split("\n").find((line) => line.includes(`--work-start ${join(outside, "m1")}`))!.trim();
    const followed = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: w.root, OPENRIG_WORKSPACE_ROOT: w.workspace } });
    expect(followed.status, followed.stdout + followed.stderr).toBe(0);
    expect(followed.stdout).toContain("intent: mission one");
    expect(followed.stdout).not.toContain("TRACE GAP");
    // A mission without a folder has no command of its own, so the generic route comes back for it.
    const withUnresolved = plain(w, heldWork(w, [...rows, pending(["mission:release"], "q-gone")], {}, byProject), ["--work-root", projectB]);
    expect(withUnresolved.stdout).toContain(`- release — UNRESOLVED ON THIS HOST: mission release resolves to 0 directories on this host\n`
      + `Then read that mission's current intent as text:\n  python3 ${TRACE} --trees work --packet --work-start ${w.missions}/<mission>`);
    // The work-packet path prints the same per-choice command.
    const evidence = deriveWorkCandidates(rows, byProject, nothingElse, w.missions);
    const packed = w.trace(["--trees", "work", "--check", "--packet", "--work-root", projectB, "--work-candidates", "-"],
      { ...evidence, heldTruncated: false, nextTruncated: false, heldAndNextTruncated: false });
    expect(packed.status, packed.stdout + packed.stderr).toBe(0);
    expect(packed.stdout).toContain(`- m1 — ${join(outside, "m1")}\n  ${route(join(outside, "m1"), projectB)}`);
  });

  it("keeps today's fallback, byte for byte, when no held or pending row names a mission (none)", () => {
    const w = world();
    const today = w.trace(["--trees", "work", "--check", "--unresolved-work-advisory", "--work-basis", NO_BATON]);
    for (const held of [heldWork(w, []), heldWork(w, [pending([], "q-fyi")])]) {
      const result = plain(w, held);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout.split("\n\nPOSSIBLE NEXT WORK")[0]!.trimEnd()).toBe(today.stdout.trimEnd());
    }
  });

  it("shows a held row's first body line when it has no summary", () => {
    const w = world();
    const result = plain(w, heldWork(w, [{ qitemId: "q-held", state: "blocked", summary: null, body: "# Unblock the eval\nwaiting on keys",
      tags: ["mission:release-a"], blockedOn: "q-gate" }]));
    expect(result.stdout).toContain("- q-held — Unblock the eval — blocked on q-gate");
  });

  it("traces held context in a catalogued project outside workspace.root from the hook's work roots, and is a gap without them", () => {
    const w = world();
    const outside = join(w.root, "project-b/missions");
    mkdirSync(join(outside, "m1"), { recursive: true });
    writeFileSync(join(w.root, "project-b/SPEC.md"), "---\nintent: ship project b\n---\n", "utf8");
    writeFileSync(join(outside, "m1/SPEC.md"), "---\nintent: mission one\n---\n", "utf8");
    const held = heldWork(w, [parked(["mission:m1"])], {}, outside);
    const result = plain(w, held, ["--work-root", join(w.root, "project-b")]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`root: ${join(w.root, "project-b")}`);
    expect(result.stdout).toContain("intent: mission one");
    const unknownRoot = plain(w, held);
    expect(unknownRoot.status).toBe(1);
    expect(unknownRoot.stdout).toContain("TRACE GAP — start is outside configured root");
  });

  it("does the same on the work-packet path in place of the name-it ask", () => {
    const w = world();
    const one = packet(w, [parked(["mission:release-a", "slice:12-refocus"]), pending(["mission:release-a", "slice:12-refocus"])]);
    expect(one.status, one.stdout + one.stderr).toBe(0);
    expect(one.stdout).toContain(`${CONTEXT}, and every held and pending row (1 held, 1 pending) resolves to this slice.`);
    expect(one.stdout).toContain("intent: Refocus knows the work");
    expect(one.stdout).not.toContain("No in-progress queue row names your work");
    expect(one.stdout).not.toContain("ORIENTATION");
    expect(one.stdout).toContain("HELD WORK (blocked; this is not next):");
    const two = packet(w, [parked(["mission:release-a"]), pending(["mission:release-b"])]);
    expect(two.status, two.stdout + two.stderr).toBe(0);
    expect(two.stdout).toContain("No in-progress queue row names your work. If you are working from messages, name the mission they belong to; "
      + "if you have no current work, say so.\nHeld and pending work is context, not current work, and does not settle one mission");
    expect(two.stdout).toContain(`- release-b — ${join(w.missions, "release-b")}\n  ${route(join(w.missions, "release-b"))}\nMissions on this host: release-a, release-b`);
    expect(two.stdout).toContain("## ORIENTATION — the project-level chain, not your work");
    expect(two.stdout).not.toContain(CONTEXT);
    // A daemon from before resolved scope sends a pending row's mission names only: that is unknown, not unresolved.
    const older = w.trace(["--trees", "work", "--check", "--packet", "--work-candidates", "-"],
      { candidates: [], unknown: [], held: [], next: [{ qitemId: "q-next", summary: "later", missions: ["release-a"] }], missionsOnHost: ["release-a"] });
    expect(older.status, older.stdout + older.stderr).toBe(0);
    expect(older.stdout).toContain("(the daemon did not say which folders the rows' missions resolve to)");
    expect(older.stdout).toContain("- q-next — later [mission: release-a]");
    expect(older.stdout).not.toContain(CONTEXT);
  });

  it("leaves in-progress work as it is: its candidate is the work, and held rows stay held", () => {
    const w = world();
    const result = packet(w, [{ qitemId: "q-1", state: "in-progress", tags: ["mission:release-b"] }, parked(["mission:release-a"])]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("WORK FROM QUEUE EVIDENCE — tag mission:release-b on row q-1");
    expect(result.stdout).toContain("- q-held — parked — blocked on q-gate — continuation: none recorded [mission: release-a]");
    expect(result.stdout).not.toContain(CONTEXT);
    // An explicit start wins over held work too.
    const explicit = plain(w, heldWork(w, [parked(["mission:release-a"])]), ["--work-start", join(w.missions, "release-b")]);
    expect(explicit.stdout).toContain("intent: Ship B");
    expect(explicit.stdout).not.toContain(CONTEXT);
    expect(explicit.stdout).not.toContain("HELD WORK");
  });
});

describe("refocus hook — OPENRIG_REFOCUS_WORK_PACKET switch", () => {
  function fire(w: ReturnType<typeof world>, extra: NodeJS.ProcessEnv, runtime: "claude" | "codex" = "claude") {
    const home = join(w.root, "home");
    mkdirSync(home, { recursive: true });
    const argvLog = join(w.root, "python-argv.log");
    const stdinLog = join(w.root, "python-stdin.log");
    let python = join(w.bin, "python-shim");
    writeFileSync(python, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${argvLog}"\ncat > "${stdinLog}"\nprintf 'TRACE OK'\n`, "utf8");
    chmodSync(python, 0o755);
    if (process.platform === "win32") python = writeRefocusCaptureProbe(python);
    const whoami = {
      currentWork: { mission: "release-a", slice: "12-refocus", workNodePath: w.slice, basis: "one typed" },
      currentWorkBasis: "one typed",
      role: { state: "not-declared", files: [] },
      workCandidates: deriveWorkCandidates([{ qitemId: "q-1", state: "in-progress", tags: ["mission:release-a"] }], w.missions, nothingElse),
    };
    const result = spawnSync(process.execPath, [HOOK, "--runtime", runtime], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "packet-fixture", transcript_path: "" }),
      encoding: "utf8",
      env: { ...w.env, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: "builder@demo", OPENRIG_REFOCUS_NOW: "1",
        OPENRIG_REFOCUS_TREES: "work", OPENRIG_REFOCUS_CONTENT_REF: "", OPENRIG_REFOCUS_CONTENT_FILE: "",
        PYTHON: python, REFOCUS_TEST_ARGV_LOG: argvLog, REFOCUS_TEST_STDIN_LOG: stdinLog,
        RIG_QUEUE_WHOAMI_STDOUT: JSON.stringify(whoami), ...extra },
    });
    expect(result.status, result.stderr).toBe(0);
    return {
      argv: existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "",
      stdin: existsSync(stdinLog) ? readFileSync(stdinLog, "utf8") : "",
    };
  }

  // The default per runtime: on only where native delivery and the agent's next action have been checked. Neither
  // runtime is yet, so both default off; turning one on changes the hook's table and this line together.
  const DEFAULT_ON = { claude: false, codex: false } as const;

  it.each(["claude", "codex"] as const)("defaults per runtime (%s), and =0 always gives today's trace argv", (runtime) => {
    const w = world();
    const { argv, stdin } = fire(w, { OPENRIG_REFOCUS_WORK_PACKET: undefined }, runtime);
    if (DEFAULT_ON[runtime]) {
      expect(argv).toContain("--packet");
      expect(argv).toContain("--work-candidates -");
    } else {
      // With the packet off the one lookup asks for held and pending work too; the daemon adds it only with nothing in progress.
      expect(w.calls()).toContain("queue whoami --json --held-work\n");
      expect(w.calls()).not.toContain("--work-candidates");
      expect(argv).toContain(`--work-start ${w.slice}`);
      expect(argv).not.toContain("--packet");
      expect(stdin).toBe("");
    }
    for (const off of ["0", "off", "false", "no"]) {
      const v = world();
      const offRun = fire(v, { OPENRIG_REFOCUS_WORK_PACKET: off }, runtime);
      expect(v.calls()).not.toContain("--work-candidates");
      expect(offRun.argv).toBe(`${TRACE} --trees work --depth light --check --unresolved-work-advisory --work-start ${v.slice}\n`);
      expect(offRun.stdin).toBe("");
    }
  });

  it.each(["claude", "codex"] as const)("=1 turns the packet on for %s whatever its default", (runtime) => {
    const w = world();
    const { argv } = fire(w, { OPENRIG_REFOCUS_WORK_PACKET: "1" }, runtime);
    expect(w.calls()).toContain("queue whoami --json --work-candidates");
    expect(argv).toContain("--packet");
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

  it("preserves Unicode candidate evidence on the trace's stdin", () => {
    const w = world();
    writeFileSync(join(w.missions, "release-a", "SPEC.md"), "---\nintent: 保留候选归属 Ω\n---\n", "utf8");
    const { stdin } = fire(w, { OPENRIG_REFOCUS_WORK_PACKET: "1" });
    expect(JSON.parse(stdin).candidates[0]).toMatchObject({ mission: "release-a", intent: "保留候选归属 Ω" });
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

  // With nothing in progress, the plain answer carries the seat's held and pending rows; the hook hands them to the trace.
  const NO_BATON = deriveCurrentWork([], "/missions").currentWorkBasis;
  const noBaton = (w: ReturnType<typeof world>) => {
    const { held, next } = deriveWorkCandidates([{ qitemId: "q-held", state: "blocked", summary: "parked", tags: ["mission:release-a"] }],
      w.missions, nothingElse, null);
    const heldAndPendingWork = { missionsRoot: w.missions, held, next, heldTruncated: false, nextTruncated: false };
    return { heldAndPendingWork, answer: { currentWork: null, currentWorkBasis: NO_BATON, role: { state: "not-declared", files: [] }, heldAndPendingWork } };
  };

  it.each(["claude", "codex"] as const)("with the packet off (%s), asks for held and pending work on its one lookup and passes it", (runtime) => {
    const w = world();
    const { heldAndPendingWork, answer } = noBaton(w);
    const { argv, stdin } = fire(w, { OPENRIG_REFOCUS_WORK_PACKET: undefined, RIG_QUEUE_WHOAMI_STDOUT: JSON.stringify(answer) }, runtime);
    expect(w.calls().split("\n").filter((call) => call.startsWith("queue "))).toEqual(["queue whoami --json --held-work"]);
    expect(argv).toBe(`${TRACE} --trees work --depth light --check --unresolved-work-advisory --work-basis ${NO_BATON} --held-work -\n`);
    expect(JSON.parse(stdin)).toEqual(heldAndPendingWork);
  });

  // That CLI predates both flags, so the plain retry asks for nothing more, and its answer carries no held work.
  it.each([
    ["on", "--work-candidates", "1", "RIG_REJECT_CANDIDATES"],
    ["off", "--held-work", "0", "RIG_REJECT_HELD_WORK"],
  ] as const)("with the packet %s and an older rig CLI that rejects %s, asks again plainly and passes the basis alone", (_label, flag, packet, reject) => {
    const w = world();
    const older = JSON.stringify({ currentWork: null, currentWorkBasis: NO_BATON, role: { state: "not-declared", files: [] } });
    const { argv, stdin } = fire(w, { OPENRIG_REFOCUS_WORK_PACKET: packet, [reject]: "1", RIG_QUEUE_WHOAMI_STDOUT: older });
    expect(w.calls().split("\n").filter((call) => call.startsWith("queue "))).toEqual([`queue whoami --json ${flag}`, "queue whoami --json"]);
    expect(argv.endsWith(`--work-basis ${NO_BATON}\n`), argv).toBe(true);
    expect(stdin).toBe("");
  });

  it("never passes held work beside a current work node, an explicit start, or a topology-only trace, and asks for it only where it could", () => {
    const passes = (w: ReturnType<typeof world>, extra: NodeJS.ProcessEnv, ending: string) => {
      const { argv, stdin } = fire(w, { OPENRIG_REFOCUS_WORK_PACKET: "0", RIG_QUEUE_WHOAMI_STDOUT: JSON.stringify(noBaton(w).answer), ...extra });
      expect(argv.endsWith(`--unresolved-work-advisory ${ending}\n`), argv).toBe(true);
      expect(stdin).toBe("");
      return w.calls().split("\n").filter((call) => call.startsWith("queue "));
    };
    const settled = world();
    const current = { mission: "release-a", slice: "12-refocus", workNodePath: settled.slice, basis: "one typed" };
    // Before the answer, the hook can't know work is in progress, so it asks; the daemon then adds nothing.
    expect(passes(settled, { RIG_QUEUE_WHOAMI_STDOUT: JSON.stringify({ ...noBaton(settled).answer, currentWork: current }) },
      `--work-start ${settled.slice}`)).toEqual(["queue whoami --json --held-work"]);
    // An explicit work node needs no lookup for the work, and a topology-only trace takes no held work: neither asks.
    const explicit = world();
    expect(passes(explicit, { OPENRIG_REFOCUS_WORK_NODE: explicit.slice }, `--work-start ${explicit.slice}`)).toEqual([]);
    const withRole = world();
    expect(passes(withRole, { OPENRIG_REFOCUS_WORK_NODE: withRole.slice, OPENRIG_REFOCUS_TREES: "both" }, `--work-start ${withRole.slice}`))
      .toEqual(["queue whoami --json"]);
    expect(passes(world(), { OPENRIG_REFOCUS_TREES: "topology" }, `--work-basis ${NO_BATON}`)).toEqual(["queue whoami --json"]);
  });
});
