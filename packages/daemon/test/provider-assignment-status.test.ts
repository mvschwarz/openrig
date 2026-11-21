import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { readClaudeSeatTokenRef } from "../src/domain/claude-seat-token.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { ProviderAccountRefsRepository } from "../src/domain/provider/provider-account-refs.js";
import { ProviderAccountAssignmentsRepository } from "../src/domain/provider/provider-account-assignments.js";
import { isSeat } from "../src/domain/provider/usage-across-hosts.js";
import type { AssignmentApplyRequest, ClaudeSeatRelaunch } from "../src/domain/provider/provider-service.js";
import type { SeatAssignment } from "../src/domain/provider/provider-types.js";

// #3625 slice 4: status reads each seat against its rig's assignment, from what applies stored, with the plan's own
// definition of a seat that follows an assignment. Nothing is written.

const CONTENT = "synthetic-content-never-echoed";
let dir: string;
let db: Database.Database;
let svc: ProviderServiceImpl;

function seat(id: string, rig = "fleet", runtime = "claude-code") {
  db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES (?, ?)").run(`rig-${rig}`, rig);
  db.prepare("INSERT OR IGNORE INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run(`pod-${rig}`, `rig-${rig}`, "dev", "Dev");
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES (?, ?, ?, ?, ?, ?)").run(id, `rig-${rig}`, `dev.${id}`, runtime, "/w", `pod-${rig}`);
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)").run(`sess-${id}`, id, `${id}@${rig}`, "stopped", "ready");
}

const ownToken = (id: string, label: string) =>
  db.prepare("UPDATE nodes SET claude_token_ref = ? WHERE id = ?").run(JSON.stringify({ label, tokenFile: path.join(dir, label) }), id);

/** Claude's relaunch for stopped seats: the token reference is read and written for real; nothing is relaunched. */
function stoppedClaude(): ClaudeSeatRelaunch {
  const repo = new RigRepository(db);
  return {
    seat: (s) => {
      const row = db.prepare(`SELECT n.id, n.rig_id, r.name, n.logical_id FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
        WHERE s.session_name = ? AND n.runtime = 'claude-code'`).get(s) as { id: string; rig_id: string; name: string; logical_id: string } | undefined;
      return row ? { nodeId: row.id, rigId: row.rig_id, rigName: row.name, logicalId: row.logical_id, running: false, pane: null } : null;
    },
    tokenRef: (nodeId) => readClaudeSeatTokenRef(db, nodeId),
    setTokenRef: (nodeId, ref) => repo.setNodeClaudeTokenRef(nodeId, ref),
    snapshot: () => { throw new Error("a stopped seat takes no snapshot"); },
    nextLaunch: () => ({ snapshotId: "snap-1", resumes: true, automatic: false, conversation: "conv-1" }),
    exclusive: async (_nodeId, fn) => fn(),
    relaunchInPane: async () => { throw new Error("a stopped seat isn't relaunched"); },
  };
}

async function apply(label: string, claude = stoppedClaude()) {
  const planned = await svc.assignmentPlan({ rig: "fleet", provider: "claude", label, includeOverrides: false, daemon: "host-a" }, undefined, claude);
  if (!planned.ok) throw new Error(planned.message);
  const request: AssignmentApplyRequest = { rig: "fleet", provider: "claude", label, includeOverrides: false, daemon: "host-a", digest: planned.plan.digest, requestedBy: "lead@fleet" };
  const applied = await svc.applyAssignment(request, { claudeSeat: claude });
  if (!applied.ok) throw new Error(applied.message);
  return applied.report;
}

async function statusOf(): Promise<Record<string, SeatAssignment | undefined>> {
  const model = await svc.getReadModel();
  return Object.fromEntries(model.bindings.map((b) => [b.seatSession, b.assignment]));
}

async function planEffects(label: string): Promise<Record<string, string>> {
  const planned = await svc.assignmentPlan({ rig: "fleet", provider: "claude", label, includeOverrides: false, daemon: "host-a" }, undefined, stoppedClaude());
  if (!planned.ok) throw new Error(planned.message);
  return Object.fromEntries(planned.plan.rows.map((r) => [r.seat, r.effect]));
}

function everything(): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assignment-status-"));
  db = createFullTestDb();
  svc = new ProviderServiceImpl({ db, listRigs: () => db.prepare("SELECT id FROM rigs ORDER BY id").all() as Array<{ id: string }>,
    env: { HOME: dir }, platform: "linux", now: () => "2026-11-21T08:00:00.000Z",
    claudePrecedence: async () => ({ conflicts: [], checked: ["the pane environment"], notChecked: [] }) });
  const refs = new ProviderAccountRefsRepository(db);
  for (const label of ["max-1", "max-2", "max-3"]) {
    fs.writeFileSync(path.join(dir, label), CONTENT, { mode: 0o600 });
    refs.add({ provider: "claude", label, tokenFile: path.join(dir, label) });
  }
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("status: each seat against its rig's assignment", () => {
  it("reads the four states from what applies stored, and writes nothing", async () => {
    seat("a"); seat("b"); seat("own"); seat("x", "other"); seat("cx", "fleet", "terminal");
    ownToken("own", "max-1");
    // Before any apply: no assignment anywhere; another runtime carries none.
    expect(await statusOf()).toEqual({
      "a@fleet": { provider: "claude", state: "no_assignment", intended: null, applied: null },
      "b@fleet": { provider: "claude", state: "no_assignment", intended: null, applied: null },
      "own@fleet": { provider: "claude", state: "no_assignment", intended: null, applied: null },
      "x@other": { provider: "claude", state: "no_assignment", intended: null, applied: null },
      "cx@fleet": undefined,
    });
    await apply("max-2");
    // c joins after the apply: the rig's assignment exists, and the seat has no result.
    seat("c");
    // b's token is changed by hand after the apply.
    ownToken("b", "max-3");
    const before = everything();
    // total_changes counts every row a statement touched, so even a write that leaves a value as it was shows.
    const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const touched = changes();
    const status = await statusOf();
    expect(everything()).toBe(before);
    expect(changes()).toBe(touched);
    const intended = { label: "max-2", reference: `the token file ${path.join(dir, "max-2")}`, requestedBy: "lead@fleet", at: "2026-11-21T08:00:00.000Z" };
    expect(status["a@fleet"]).toEqual({ provider: "claude", state: "follows", intended,
      applied: { kind: "switched", label: "max-2", detail: expect.any(String), at: "2026-11-21T08:00:00.000Z" } });
    expect(status["b@fleet"]).toMatchObject({ state: "override", intended, applied: { kind: "switched" },
      override: `its own token file ${path.join(dir, "max-3")} ("max-3")` });
    // Kept by the apply as the seat's own choice: an override, with the apply's result beside it.
    expect(status["own@fleet"]).toMatchObject({ state: "override", applied: { kind: "unchanged", detail: expect.stringMatching(/^kept \(seat override\)/) } });
    expect(status["c@fleet"]).toEqual({ provider: "claude", state: "not_applied", intended, applied: null });
    expect(status["x@other"]).toEqual({ provider: "claude", state: "no_assignment", intended: null, applied: null });
    expect(JSON.stringify(status)).not.toContain(CONTENT);
  });

  it("uses the plan's definition of following: where the plan sees nothing to do, status says follows, and an override is one in both", async () => {
    seat("a"); seat("b"); seat("own");
    ownToken("own", "max-1");
    await apply("max-2");
    ownToken("b", "max-3");
    // Against the same account, the plan and status agree seat by seat.
    expect(await planEffects("max-2")).toEqual({ "a@fleet": "unchanged", "b@fleet": "kept_override", "own@fleet": "kept_override" });
    const status = await statusOf();
    expect([status["a@fleet"]!.state, status["b@fleet"]!.state, status["own@fleet"]!.state]).toEqual(["follows", "override", "override"]);
    // A seat that follows an earlier assignment isn't an override of the next one: the plan moves it, and after that apply
    // it follows the new one. b already chose max-3 itself, so it's on it either way.
    expect((await planEffects("max-3"))["a@fleet"]).toBe("change");
    await apply("max-3");
    expect(await statusOf()).toMatchObject({ "a@fleet": { state: "follows", intended: { label: "max-3" } }, "b@fleet": { state: "follows" } });
  });

  it("a Claude seat's own token is named as its choice ahead of its config dir, in the plan and status alike; the dir only when it has no token", async () => {
    seat("tok"); seat("dir");
    for (const id of ["tok", "dir"]) db.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run(path.join(dir, `config-${id}`), id);
    ownToken("tok", "max-1");
    const planned = await svc.assignmentPlan({ rig: "fleet", provider: "claude", label: "max-2", includeOverrides: false, daemon: "host-a" }, undefined, stoppedClaude());
    expect(planned.ok && planned.plan.rows.map((r) => [r.seat, r.override])).toEqual([
      ["dir@fleet", `its account home ${path.join(dir, "config-dir")}`],
      ["tok@fleet", `its own token file ${path.join(dir, "max-1")} ("max-1")`],
    ]);
    new ProviderAccountAssignmentsRepository(db).setIntent({ rigId: "rig-fleet", provider: "claude", label: "max-2", reference: "r", requestedBy: null, at: "t" });
    const status = await statusOf();
    expect([status["tok@fleet"]!.override, status["dir@fleet"]!.override]).toEqual([`its own token file ${path.join(dir, "max-1")} ("max-1")`, `its account home ${path.join(dir, "config-dir")}`]);
    // Its token already being the assigned account makes it follow, whatever its config dir.
    ownToken("tok", "max-2");
    expect((await statusOf())["tok@fleet"]).toMatchObject({ state: "follows" });
  });

  it("a seat whose last result didn't move it isn't on the assignment yet; its result and recovery show beside it", async () => {
    seat("a");
    await apply("max-2");
    // A later apply's result for the seat, failed before effect, with the assignment moved on to max-3.
    new ProviderAccountAssignmentsRepository(db).setIntent({ rigId: "rig-fleet", provider: "claude", label: "max-3", reference: "the token file max-3", requestedBy: "lead@fleet", at: "t2" });
    new ProviderAccountAssignmentsRepository(db).saveResult({ rigId: "rig-fleet", provider: "claude", nodeId: "a", seat: "a@fleet", label: "max-3",
      kind: "unknown", detail: "the relaunch didn't report a resumed conversation", recovery: "rig launch fleet dev.a --snapshot-id s1", activity: "idle", at: "t2" });
    expect((await statusOf())["a@fleet"]).toEqual({ provider: "claude", state: "not_applied",
      intended: { label: "max-3", reference: "the token file max-3", requestedBy: "lead@fleet", at: "t2" },
      applied: { kind: "unknown", label: "max-3", detail: "the relaunch didn't report a resumed conversation", at: "t2", recovery: "rig launch fleet dev.a --snapshot-id s1" } });
  });
});

describe("status only compares seats whose rig has an assignment", () => {
  it("a seat with a result but no assignment for its rig reads no_assignment with that result, and its homes aren't read", async () => {
    seat("a");
    new ProviderAccountAssignmentsRepository(db).saveResult({ rigId: "rig-fleet", provider: "claude", nodeId: "a", seat: "a@fleet", label: "max-2",
      kind: "failed_before_effect", detail: "not attempted", recovery: null, activity: "idle", at: "t" });
    const reads: string[] = [];
    const original = db.prepare.bind(db);
    db.prepare = ((sql: string) => { if (/claude_token_ref|account_home/.test(sql)) reads.push(sql); return original(sql); }) as typeof db.prepare;
    let status: Record<string, SeatAssignment | undefined>;
    try {
      const before = reads.length;
      status = await statusOf();
      // seatEntries reads each seat once, as before; the assignment comparison adds no read of its own.
      const perRead = reads.length - before;
      db.prepare(`INSERT INTO provider_account_assignments (rig_id, provider, label, reference, requested_by, created_at) VALUES ('rig-fleet', 'claude', 'max-2', 'r', NULL, 't')`).run();
      const withIntent = reads.length;
      await statusOf();
      expect(reads.length - withIntent).toBeGreaterThan(perRead);
    } finally { db.prepare = original; }
    expect(status!["a@fleet"]).toEqual({ provider: "claude", state: "no_assignment", intended: null,
      applied: { kind: "failed_before_effect", label: "max-2", detail: "not attempted", at: "t" } });
  });
});

describe("status for a Codex seat moved to a prepared home", () => {
  it("follows while its account home is the one this assignment's apply gave it; another assignment hasn't moved it yet", async () => {
    const codexHome = path.join(dir, "codex"), prepared = path.join(dir, "prepared");
    fs.mkdirSync(path.join(codexHome, "auth-profiles"), { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth-profiles", "team.json"), CONTENT, { mode: 0o600 });
    fs.mkdirSync(prepared);
    new ProviderAccountRefsRepository(db).add({ provider: "codex", label: "team", codexHome, login: "team" });
    seat("c1", "fleet", "codex");
    db.prepare("UPDATE nodes SET account_home = ? WHERE id = 'c1'").run(prepared);
    const repo = new ProviderAccountAssignmentsRepository(db);
    repo.setIntent({ rigId: "rig-fleet", provider: "codex", label: "team", reference: "the login team", requestedBy: null, at: "t" });
    repo.saveResult({ rigId: "rig-fleet", provider: "codex", nodeId: "c1", seat: "c1@fleet", label: "team", kind: "pending_successor", detail: "d",
      recovery: null, activity: "idle", at: "t", applied: { file: null, fileKind: null, codexHome: prepared, codexLogin: null } });
    expect((await statusOf())["c1@fleet"]).toMatchObject({ provider: "codex", state: "follows" });
    // The rig is assigned another account: the seat still follows the earlier one, so it's not an override, and not on this one.
    repo.setIntent({ rigId: "rig-fleet", provider: "codex", label: "other", reference: "the login other", requestedBy: null, at: "t2" });
    fs.writeFileSync(path.join(codexHome, "auth-profiles", "other.json"), CONTENT, { mode: 0o600 });
    new ProviderAccountRefsRepository(db).add({ provider: "codex", label: "other", codexHome, login: "other" });
    expect((await statusOf())["c1@fleet"]).toMatchObject({ state: "not_applied", intended: { label: "other" } });
    // Moved to another home by hand: its own choice.
    db.prepare("UPDATE nodes SET account_home = ? WHERE id = 'c1'").run(path.join(dir, "mine"));
    expect((await statusOf())["c1@fleet"]).toMatchObject({ state: "override", override: `its account home ${path.join(dir, "mine")}` });
  });
});

describe("status across hosts: the assignment on a host's seats", () => {
  const row = { seatSession: "a@fleet", rigName: "fleet", runtime: "claude-code", configured: { source: "claude_token", label: "max-2", note: "n" },
    allowance: { linked: false, reason: "r" } };
  it("reads a host from before assignments (no field) and one with them; a malformed one isn't read", () => {
    expect(isSeat(row)).toBe(true);
    expect(isSeat({ ...row, assignment: { provider: "claude", state: "follows", intended: { label: "max-2", reference: "ref", requestedBy: null, at: "t" },
      applied: { kind: "switched", label: "max-2", detail: "d", at: "t" } } })).toBe(true);
    expect(isSeat({ ...row, assignment: { provider: "claude", state: "running", intended: null, applied: null } })).toBe(false);
    expect(isSeat({ ...row, assignment: { provider: "claude", state: "follows" } })).toBe(false);
  });
});
