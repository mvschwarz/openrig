// #1077 — a resumed Claude seat whose session id changes. OpenRig launched the seat with
// `--resume T1`, Claude continued as T2 and its SessionStart hook recorded T2. The proof accepts T1
// in argv only when the first current-generation hook after that launch said `source: resume`.
// Every other hook (a /clear, startup or compaction, no source, a stale generation, and anything
// after the first) keeps today's refusal.

import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { CLAUDE_RESUME_ROTATION_COLUMNS, SessionRegistry, claudeResumeRotation } from "../src/domain/session-registry.js";
import { verifyClaudePaneProcess, observeClaudeDelivery, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const require = createRequire(import.meta.url);
const relay = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") as {
  buildSessionIdentityPayload(payload: Record<string, unknown>, env: Record<string, string>): Record<string, unknown> | null;
};

const T1 = "00000000-0000-4000-8000-000000001077";
const T2 = "00000000-0000-4000-8000-000000001078";
const T3 = "00000000-0000-4000-8000-000000001079";

const launchedClaude = { pid: 4242, startedAt: "Fri Oct  9 01:00:00 2026" };

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function seat(opts: { armed?: boolean; launchWrite?: boolean; launchObserved?: typeof launchedClaude | null } = {}) {
  const db = createDb(); databases.push(db);
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), registry = new SessionRegistry(db);
  const rig = rigRepo.createRig("rotation");
  const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
  const session = registry.registerSession(node.id, "dev-impl@rotation");
  // OpenRig arms the launch before starting `claude --resume T1` (startup-orchestrator, legacy restore).
  if (opts.armed !== false) registry.recordResumeLaunch(session.id, T1);
  // The launch path's own record of the process it started on T1 (null: it could not observe one).
  const launchObserved = opts.launchObserved === undefined ? launchedClaude : opts.launchObserved;
  if (opts.armed !== false && launchObserved) registry.recordResumeLaunchProcess(session.id, T1, launchObserved);
  // The launch path may write T1 afterwards (provenance scrape); the hook can also land first.
  if (opts.launchWrite !== false) registry.updateResumeToken(session.id, "claude_id", T1, "scrape");
  const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
  const row = () => db.prepare(
    "SELECT resume_token, resume_provenance, resume_launch_token, resume_rotated_from FROM sessions WHERE id = ?",
  ).get(session.id) as { resume_token: string; resume_provenance: string; resume_launch_token: string | null; resume_rotated_from: string | null };
  // By default the hook comes from the process OpenRig launched, whose command carried the marker.
  const hook = (token: string, source: string | null, currentGeneration = true, resumeLaunch: string | null = T1, launchedProcess = true) =>
    registry.recordHookSessionIdentity(session.id, "claude_id", token,
      { source, currentGeneration, resumeLaunch, launchedProcess: launchedProcess ? launchedClaude : null });
  const rotation = () => claudeResumeRotation(db.prepare(
    `SELECT ${CLAUDE_RESUME_ROTATION_COLUMNS} FROM sessions WHERE id = ?`,
  ).get(session.id) as Parameters<typeof claudeResumeRotation>[0]);
  const rotatedFrom = () => rotation()?.token ?? null;
  return { db, registry, session, node, generation, row, hook, rotation, rotatedFrom };
}

describe("the first hook after OpenRig's --resume launch", () => {
  // dev-review's reproduction against 21c55946: with the first post lost and the claim removed, a
  // replacement's own hook counts as first. Only the launch path's record of its process tells them apart.
  it.each([
    ["the launch observed another process (a replacement sent the hook)", { pid: 4243, startedAt: launchedClaude.startedAt }],
    ["the launch observed a reused pid with another start time", { pid: launchedClaude.pid, startedAt: "Fri Oct  9 00:59:00 2026" }],
    ["the launch could not observe its process", null],
  ] as const)("no rotation when %s", (_label, launchObserved) => {
    const s = seat({ launchObserved });
    expect(s.hook(T2, "resume")).toBe(true);
    expect(s.rotation()).toBeNull();
    expect(s.registry.claudeResumeRotatedFrom(s.session.id, T1)).toBe(false);
  });

  it("an early hook counts once the launch records the same process, and re-arming drops it", () => {
    const s = seat({ launchObserved: null });
    expect(s.hook(T2, "resume")).toBe(true);
    expect(s.rotation()).toBeNull();
    s.registry.recordResumeLaunchProcess(s.session.id, T1, launchedClaude);
    expect(s.rotation()).toEqual({ token: T1, process: launchedClaude });
    s.registry.recordResumeLaunch(s.session.id, T2);
    expect(s.rotation()).toBeNull();
  });

  it.each([true, false])("a resume into a new id names the launch token (launch wrote T1 first: %s)", (launchWrite) => {
    const s = seat({ launchWrite });
    expect(s.hook(T2, "resume")).toBe(true);
    expect(s.row()).toEqual({ resume_token: T2, resume_provenance: "hook", resume_launch_token: null, resume_rotated_from: T1 });
    expect(s.rotatedFrom()).toBe(T1);
    // The rotation keeps the process that qualified it; a later token change drops both.
    expect(s.rotation()?.process).toEqual(launchedClaude);
    expect(s.registry.claudeResumeRotatedFrom(s.session.id, T1)).toBe(true);
    s.registry.updateResumeToken(s.session.id, "claude_id", T3, "operator");
    expect(s.db.prepare("SELECT resume_rotated_from, resume_rotated_process FROM sessions WHERE id = ?").get(s.session.id))
      .toEqual({ resume_rotated_from: null, resume_rotated_process: null });
  });

  it.each(["clear", "startup", "compact", null])("source %s consumes the launch and names nothing", (source) => {
    const s = seat();
    s.hook(T2, source);
    expect(s.row()).toMatchObject({ resume_token: T2, resume_launch_token: null, resume_rotated_from: null });
    // A resume after that (in-process /resume, a child `claude -p --resume`) has no launch to name.
    s.hook(T3, "resume");
    expect(s.rotatedFrom()).toBeNull();
  });

  it("a resume that kept the id consumes the launch; a later in-process /resume names nothing", () => {
    const s = seat();
    s.hook(T1, "resume");
    expect(s.row()).toMatchObject({ resume_token: T1, resume_launch_token: null, resume_rotated_from: null });
    s.hook(T2, "resume");
    expect(s.rotatedFrom()).toBeNull();
  });

  it.each([
    ["a Claude started by hand in the pane (no marker), or a relay that predates it", null],
    ["a marker naming another launch", T3],
  ] as const)("%s consumes the launch and names nothing", (_label, marker) => {
    const s = seat();
    s.hook(T2, "resume", true, marker);
    expect(s.row()).toMatchObject({ resume_token: T2, resume_launch_token: null, resume_rotated_from: null });
    s.hook(T3, "resume");
    expect(s.rotatedFrom()).toBeNull();
  });

  it("a hook not observed to come from the launched process (a child claude -p inheriting the marker) names nothing", () => {
    const s = seat();
    s.hook(T2, "resume", true, T1, false);
    expect(s.row()).toMatchObject({ resume_token: T2, resume_launch_token: null, resume_rotated_from: null });
  });

  it("a stale-generation hook neither qualifies nor consumes the launch", () => {
    const s = seat();
    s.hook(T3, "resume", false);
    expect(s.row()).toMatchObject({ resume_launch_token: T1, resume_rotated_from: null });
    s.hook(T2, "resume");
    expect(s.rotatedFrom()).toBe(T1);
  });

  it("a hook the provenance rank refuses still consumes the launch and records nothing", () => {
    const s = seat();
    s.registry.updateResumeToken(s.session.id, "claude_id", T1, "operator");
    expect(s.hook(T2, "resume")).toBe(false);
    expect(s.row()).toMatchObject({ resume_token: T1, resume_launch_token: null, resume_rotated_from: null });
  });

  it("without an armed launch (fresh, or a process OpenRig did not launch) nothing qualifies", () => {
    const fresh = seat({ armed: false });
    fresh.hook(T2, "resume");
    expect(fresh.rotatedFrom()).toBeNull();
    const freshFallback = seat();
    freshFallback.registry.recordResumeLaunch(freshFallback.session.id, null);
    freshFallback.hook(T2, "resume");
    expect(freshFallback.rotatedFrom()).toBeNull();
  });
});

describe("after a recorded rotation", () => {
  const rotated = () => {
    const s = seat();
    s.hook(T2, "resume");
    return s;
  };

  it.each([
    ["an in-process /resume", "resume"],
    ["a child claude -p --resume sharing the seat's environment", "resume"],
    ["a /clear", "clear"],
  ] as const)("%s drops it and names nothing new", (_label, source) => {
    const s = rotated();
    s.hook(T3, source);
    expect(s.row()).toMatchObject({ resume_token: T3, resume_rotated_from: null });
    expect(s.rotatedFrom()).toBeNull();
  });

  it("a later hook for the same id (a compaction) keeps it", () => {
    const s = rotated();
    s.hook(T2, "compact");
    expect(s.rotatedFrom()).toBe(T1);
  });

  it("an operator token, or any other write that changes the token, drops it", () => {
    const s = rotated();
    s.registry.updateResumeToken(s.session.id, "claude_id", T3, "operator");
    expect(s.row()).toMatchObject({ resume_token: T3, resume_provenance: "operator", resume_rotated_from: null });
    expect(s.rotatedFrom()).toBeNull();
  });

  it("an equal-value refresh or a later launch-path write of T1 keeps it", () => {
    const s = rotated();
    s.registry.updateResumeToken(s.session.id, "claude_id", T2, "hook");
    s.registry.updateResumeToken(s.session.id, "claude_id", T1, "scrape");
    s.registry.recordResumeAttempt(s.session.id, "claude_id", T1);
    expect(s.rotatedFrom()).toBe(T1);
  });
});

describe("the relay forwards the evidence", () => {
  it("sends SessionStart's source, the occupant generation and the launch marker with the session id", () => {
    const payload = relay.buildSessionIdentityPayload(
      { hook_event_name: "SessionStart", session_id: T2, source: "resume" },
      { OPENRIG_SESSION_NAME: "dev-impl@rotation", OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "gen-1",
        OPENRIG_RESUME_LAUNCH: T1 },
    );
    expect(payload).toMatchObject({ eventFamily: "session_identity", sessionId: T2, source: "resume", generation: "gen-1", resumeLaunch: T1,
      hookPid: process.pid });
  });

  it("claims the launch's first SessionStart once, on disk, per launch token and generation", () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-relay-claim-"));
    try {
      expect(relay.claimFirstLaunchHook(T1, "gen-1", dir)).toBe(true);
      // A later hook of the same launch (in-process /resume, a child) finds it claimed.
      expect(relay.claimFirstLaunchHook(T1, "gen-1", dir)).toBe(false);
      expect(relay.claimFirstLaunchHook(T1, "gen-2", dir)).toBe(true);
      expect(relay.claimFirstLaunchHook(null, "gen-1", dir)).toBe(false);
      expect(relay.claimFirstLaunchHook(T1, null, dir)).toBe(false);
      // An unwritable record never reads as first.
      expect(relay.claimFirstLaunchHook(T2, "gen-1", join(dir, "missing\0dir"))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("sends nulls when the runtime or launch did not provide them", () => {
    const payload = relay.buildSessionIdentityPayload(
      { hook_event_name: "SessionStart", session_id: T2 },
      { OPENRIG_SESSION_NAME: "dev-impl@rotation", OPENRIG_RUNTIME: "claude-code" },
    );
    expect(payload).toMatchObject({ sessionId: T2, source: null, generation: null, resumeLaunch: null });
  });
});

describe("the identity proof", () => {
  const startedAt = "Fri Oct  9 01:00:00 2026";
  const rows = (argvToken: string): NativeProcessRow[] => [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command: `claude --resume ${argvToken}`, startedAt },
  ];
  const tmux = { getPanePid: async () => 100 };
  // The rotation names the process that qualified it: 101 at its start time.
  const proof = (argvToken: string, rotatedFrom: string | null, qualified = { pid: 101, startedAt }) => ({
    target: "%1", tmux, listProcesses: async () => rows(argvToken), expectedToken: T2,
    rotation: rotatedFrom ? { token: rotatedFrom, process: qualified } : null,
  });

  it("accepts the launch token a resume replaced", async () => {
    expect(await verifyClaudePaneProcess(proof(T1, T1))).not.toBeNull();
    expect(await observeClaudeDelivery(proof(T1, T1))).toMatchObject({ state: "verified" });
  });

  it("still accepts the stored token itself", async () => {
    expect(await verifyClaudePaneProcess(proof(T2, T1))).not.toBeNull();
  });

  it("refuses the launch token without a recorded resume (the /clear case)", async () => {
    expect(await verifyClaudePaneProcess(proof(T1, null))).toBeNull();
    expect(await observeClaudeDelivery(proof(T1, null))).toMatchObject({ state: "unknown" });
  });

  it.each([
    ["another pid", { pid: 202, startedAt }],
    ["a reused pid with another start time", { pid: 101, startedAt: "Fri Oct  9 02:00:00 2026" }],
  ])("refuses the launch token in a process other than the qualified one (%s)", async (_label, qualified) => {
    expect(await verifyClaudePaneProcess(proof(T1, T1, qualified))).toBeNull();
    expect(await observeClaudeDelivery(proof(T1, T1, qualified))).toMatchObject({ state: "unknown" });
    // The stored token itself never depended on the rotation's process.
    expect(await verifyClaudePaneProcess(proof(T2, T1, qualified))).not.toBeNull();
  });

  it("refuses a third token even with a recorded resume", async () => {
    expect(await verifyClaudePaneProcess(proof(T3, T1))).toBeNull();
    expect(await observeClaudeDelivery(proof(T3, T1))).toMatchObject({ state: "unknown" });
  });
});
