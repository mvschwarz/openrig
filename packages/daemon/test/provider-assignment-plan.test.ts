import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { providerRoutes } from "../src/routes/provider.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { ProviderAccountRefsRepository } from "../src/domain/provider/provider-account-refs.js";
import { ProviderAccountAssignmentsRepository } from "../src/domain/provider/provider-account-assignments.js";
import type { SeatRestart } from "../src/domain/provider/provider-service.js";
import { applyAssignment } from "../src/domain/provider/assignment-apply.js";

// The account-home dry run computes paths under OPENRIG_HOME: a scratch path, never the real one. Set before any import.
const scratchHome = vi.hoisted(() => (process.env.OPENRIG_HOME = `${process.env.TMPDIR ?? "/tmp"}/assignment-plan-openrig-${process.pid}`));

// #3625 slice 2: the daemon gathers each seat's facts for the plan, refuses an unknown label or rig and a reference that
// no longer checks out, and changes nothing.

const CONTENT = "synthetic-content-never-echoed";
let dir: string;
let codexHome: string;
let db: Database.Database;

function seat(rig: string, id: string, runtime: string, session: string, status = "running", bound = false) {
  db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES (?, ?)").run(`rig-${rig}`, rig);
  db.prepare("INSERT OR IGNORE INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run(`pod-${rig}`, `rig-${rig}`, "dev", "Dev");
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES (?, ?, ?, ?, ?, ?)").run(id, `rig-${rig}`, `dev.${id}`, runtime, "/w", `pod-${rig}`);
  if (!bound) {
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)").run(`sess-${id}`, id, session, status, "ready");
    return;
  }
  // A seat that could switch: one running session, bound to the single pane %0 the tmux stand-in reports.
  const registry = new SessionRegistry(db);
  registry.updateStatus(registry.registerSession(id, session).id, "running");
  registry.updateBinding(id, { tmuxSession: session, tmuxPane: "%0" });
}

function privateFile(name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, CONTENT, { mode: 0o600 });
  return p;
}

function service(platform: NodeJS.Platform = "linux") {
  return new ProviderServiceImpl({
    db, listRigs: () => (db.prepare("SELECT id FROM rigs ORDER BY id").all() as Array<{ id: string }>),
    env: { HOME: dir, CODEX_HOME: codexHome }, platform,
    claudePrecedence: async () => ({ conflicts: [], checked: ["the pane environment"], notChecked: [] }),
  });
}

// Every table's rows, to compare before and after a plan.
function everything(): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assignment-plan-"));
  codexHome = path.join(dir, "codex");
  fs.mkdirSync(path.join(codexHome, "auth-profiles"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(codexHome, "auth-profiles", "team.json"), CONTENT, { mode: 0o600 });
  db = createFullTestDb();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the daemon's assignment plan", () => {
  it("a Codex seat an apply moved to an account home follows it under either spelling of that home; another home is its own", async () => {
    new ProviderAccountRefsRepository(db).add({ provider: "codex", label: "team", codexHome, login: "team" });
    seat("fleet", "c1", "codex", "c1@fleet");
    const prepared = path.join(dir, "prepared");
    fs.mkdirSync(prepared);
    fs.symlinkSync(prepared, path.join(dir, "prepared-link"));
    // The seat's account home is written through a symlink; the apply recorded the resolved path.
    db.prepare("UPDATE nodes SET account_home = ? WHERE id = 'c1'").run(path.join(dir, "prepared-link"));
    const effectAfter = async (appliedHome: string) => {
      new ProviderAccountAssignmentsRepository(db).saveResult({ rigId: "rig-fleet", provider: "codex", nodeId: "c1", seat: "c1@fleet", label: "prep",
        kind: "pending_successor", detail: "d", recovery: null, activity: "idle", at: "t", applied: { account: { kind: "codex_saved_login", file: null, codexHome, login: "team" }, file: null, fileKind: null, codexHome: appliedHome, codexLogin: null } });
      const planned = await service().assignmentPlan({ rig: "fleet", provider: "codex", label: "team", includeOverrides: false, daemon: "host-a" });
      return planned.ok ? planned.plan.rows[0]!.effect : planned.message;
    };
    expect(await effectAfter(prepared)).toBe("change");
    const elsewhere = path.join(dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    expect(await effectAfter(elsewhere)).toBe("kept_override");
  });

  it("a seat already on the target's saved login, brought in with --include-overrides on a move to a prepared home, records the login it has and follows the next assignment", async () => {
    const refs = new ProviderAccountRefsRepository(db);
    fs.writeFileSync(path.join(codexHome, "auth-profiles", "next.json"), CONTENT, { mode: 0o600 });
    expect(refs.add({ provider: "codex", label: "team", codexHome, login: "team" }).ok).toBe(true);
    expect(refs.add({ provider: "codex", label: "next", codexHome, login: "next" }).ok).toBe(true);
    seat("fleet", "c1", "codex", "c1@fleet");
    // The seat registry gives c1 the saved login "team" in the daemon's Codex home: its own choice, and the target's login.
    fs.writeFileSync(path.join(codexHome, "auth-seat-registry.tsv"), "seat\trig\truntime\tcwd\tauth_profile\tupdated_ts\nc1@fleet\tfleet\tcodex\t/w\tteam\t2026-11-21T06:00:00Z\n", { mode: 0o600 });
    const prepared = path.join(dir, "prepared");
    fs.mkdirSync(prepared);
    const svc = service();
    const request = { rig: "fleet", provider: "codex" as const, label: "team", includeOverrides: true, accountHome: prepared, daemon: "host-a" };
    const planned = await svc.assignmentPlan(request);
    if (!planned.ok) throw new Error(planned.message);
    // It isn't moved to the prepared home: it's already on the account.
    expect(planned.plan.rows.map((r) => [r.seat, r.effect])).toEqual([["c1@fleet", "unchanged"]]);
    const applied = await svc.applyAssignment({ ...request, digest: planned.plan.digest, requestedBy: null }, {});
    expect(applied.ok && applied.report.results.map((r) => [r.seat, r.kind])).toEqual([["c1@fleet", "unchanged"]]);
    // It records the reference it has, the saved login in the home that login is saved in, not the prepared home.
    expect(new ProviderAccountAssignmentsRepository(db).results("rig-fleet", "codex")[0]!.applied).toMatchObject({ codexHome, codexLogin: "team" });
    // So it follows the rig's assignment: the next one moves it, rather than keeping it as its own choice.
    const next = await svc.assignmentPlan({ rig: "fleet", provider: "codex", label: "next", includeOverrides: false, daemon: "host-a" });
    expect(next.ok ? next.plan.rows.map((r) => [r.seat, r.effect]) : next.message).toEqual([["c1@fleet", "change"]]);
  });

  it("a Codex seat an apply moved to a prepared home is on the account only as that apply left it: its home's login wasn't checked", async () => {
    new ProviderAccountRefsRepository(db).add({ provider: "codex", label: "team", codexHome, login: "team" });
    seat("fleet", "c1", "codex", "c1@fleet");
    const prepared = path.join(dir, "prepared");
    fs.mkdirSync(prepared);
    db.prepare("UPDATE nodes SET account_home = ? WHERE id = 'c1'").run(prepared);
    const assignments = new ProviderAccountAssignmentsRepository(db);
    assignments.setIntent({ rigId: "rig-fleet", provider: "codex", label: "team", reference: "r", requestedBy: null, at: "t" });
    assignments.saveResult({ rigId: "rig-fleet", provider: "codex", nodeId: "c1", seat: "c1@fleet", label: "team", kind: "pending_successor", detail: "d",
      recovery: null, activity: "idle", at: "t", applied: { account: { kind: "codex_saved_login", file: null, codexHome, login: "team" }, file: null, fileKind: null, codexHome: prepared, codexLogin: null } });
    const planned = await service().assignmentPlan({ rig: "fleet", provider: "codex", label: "team", includeOverrides: false, daemon: "host-a" });
    expect(planned.ok && planned.plan.rows.map((r) => [r.effect, r.asApplied])).toEqual([["unchanged", true]]);
    const model = await service().getReadModel();
    expect(model.bindings.find((b) => b.seatSession === "c1@fleet")!.assignment).toMatchObject({ state: "follows", asApplied: true });
  });

  it("a Codex seat with no saved login of its own, whose home an apply switched to this login, is unchanged: a re-apply restarts nothing", async () => {
    new ProviderAccountRefsRepository(db).add({ provider: "codex", label: "team", codexHome, login: "team" });
    seat("fleet", "c1", "codex", "c1@fleet");
    const assignments = new ProviderAccountAssignmentsRepository(db);
    const planFor = async (label = "team") => {
      const planned = await service().assignmentPlan({ rig: "fleet", provider: "codex", label, includeOverrides: false, daemon: "host-a" });
      if (!planned.ok) throw new Error(planned.message);
      return planned.plan;
    };
    // Before any apply, its home would switch.
    expect((await planFor()).rows.map((r) => r.effect)).toEqual(["change"]);
    // What an in-place apply saves: the home and the login it activated there.
    assignments.saveResult({ rigId: "rig-fleet", provider: "codex", nodeId: "c1", seat: "c1@fleet", label: "team", kind: "switched", detail: "d",
      recovery: null, activity: "idle", at: "t", applied: { account: { kind: "codex_saved_login", file: null, codexHome, login: "team" }, file: null, fileKind: null, codexHome, codexLogin: "team" } });
    const again = await planFor();
    // Its configuration names no login and the home's active login isn't read: it's unchanged only as the apply left it.
    expect(again.rows.map((r) => [r.effect, r.asApplied])).toEqual([["unchanged", true]]);
    expect(again.codexHomes).toEqual([]);
    // Moving it to a prepared home is another move: --account-home plans it as a change.
    const prepared = await service().assignmentPlan({ rig: "fleet", provider: "codex", label: "team", includeOverrides: false, daemon: "host-a", accountHome: path.join(dir, "prepared") });
    expect(prepared.ok && prepared.plan.rows.map((r) => r.effect)).toEqual(["change"]);
    // The rig's assignment is that login: status says the seat follows it, as the apply left its home.
    assignments.setIntent({ rigId: "rig-fleet", provider: "codex", label: "team", reference: "r", requestedBy: null, at: "t" });
    const model = await service().getReadModel();
    expect(model.bindings.find((b) => b.seatSession === "c1@fleet")!.assignment).toMatchObject({ state: "follows", asApplied: true });
    // A result that switched another home isn't this seat's: its own home would switch.
    assignments.saveResult({ rigId: "rig-fleet", provider: "codex", nodeId: "c1", seat: "c1@fleet", label: "team", kind: "switched", detail: "d",
      recovery: null, activity: "idle", at: "t", applied: { account: { kind: "codex_saved_login", file: null, codexHome, login: "team" }, file: null, fileKind: null, codexHome: path.join(dir, "elsewhere"), codexLogin: "team" } });
    expect((await planFor()).rows.map((r) => r.effect)).toEqual(["change"]);
  });

  it("a Codex seat on its home's login stays on the apply that switched it after later results that moved nothing", async () => {
    new ProviderAccountRefsRepository(db).add({ provider: "codex", label: "team", codexHome, login: "team" });
    seat("fleet", "c1", "codex", "c1@fleet");
    const assignments = new ProviderAccountAssignmentsRepository(db);
    assignments.setIntent({ rigId: "rig-fleet", provider: "codex", label: "team", reference: "r", requestedBy: null, at: "t" });
    const standing = async () => {
      const planned = await service().assignmentPlan({ rig: "fleet", provider: "codex", label: "team", includeOverrides: false, daemon: "host-a" });
      if (!planned.ok) throw new Error(planned.message);
      const model = await service().getReadModel();
      return [planned.plan.rows[0]!.effect, model.bindings.find((b) => b.seatSession === "c1@fleet")!.assignment!.state];
    };
    const save = (label: string, kind: "switched" | "unchanged" | "failed_before_effect", moved: boolean) => assignments.saveResult({ rigId: "rig-fleet",
      provider: "codex", nodeId: "c1", seat: "c1@fleet", label, kind, detail: "d", recovery: null, activity: "idle", at: "t",
      ...(moved ? { applied: { account: { kind: "codex_saved_login", file: null, codexHome, login: "team" }, file: null, fileKind: null, codexHome, codexLogin: "team" } } : {}) });
    save("team", "switched", true);
    expect(await standing()).toEqual(["unchanged", "follows"]);
    // A re-apply of team leaves it unchanged, which moves nothing: it still follows team, and the next re-apply restarts nothing.
    save("team", "unchanged", false);
    expect(await standing()).toEqual(["unchanged", "follows"]);
    // An apply of another account that failed for this seat moved nothing either.
    save("other", "failed_before_effect", false);
    expect(await standing()).toEqual(["unchanged", "follows"]);
  });

  it("a Codex seat follows an earlier assignment only when its saved login is that name in that home", async () => {
    const refs = new ProviderAccountRefsRepository(db);
    fs.writeFileSync(path.join(codexHome, "auth-profiles", "next.json"), CONTENT, { mode: 0o600 });
    refs.add({ provider: "codex", label: "next", codexHome, login: "next" });
    seat("fleet", "c1", "codex", "c1@fleet");
    // The seat registry gives c1 the saved login "team" in its Codex home.
    fs.writeFileSync(path.join(codexHome, "auth-seat-registry.tsv"), "seat\trig\truntime\tcwd\tauth_profile\tupdated_ts\nc1@fleet\tfleet\tcodex\t/w\tteam\t2026-11-21T06:00:00Z\n", { mode: 0o600 });
    const effectAfter = async (appliedHome: string) => {
      new ProviderAccountAssignmentsRepository(db).saveResult({ rigId: "rig-fleet", provider: "codex", nodeId: "c1", seat: "c1@fleet", label: "team",
        kind: "switched", detail: "d", recovery: null, activity: "idle", at: "t", applied: { account: { kind: "codex_saved_login", file: null, codexHome, login: "team" }, file: null, fileKind: null, codexHome: appliedHome, codexLogin: "team" } });
      const planned = await service().assignmentPlan({ rig: "fleet", provider: "codex", label: "next", includeOverrides: false, daemon: "host-a" });
      return planned.ok ? planned.plan.rows[0]!.effect : planned.message;
    };
    // An apply gave it "team" in this home: it follows the assignment, so the next one moves it.
    expect(await effectAfter(codexHome)).toBe("change");
    // An apply gave "team" in another home: the seat's "team" here is its own choice, kept as an override.
    const elsewhere = path.join(dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    expect(await effectAfter(elsewhere)).toBe("kept_override");
  });

  it("two rigs share a name and a Codex home: the plan and apply restart only the chosen rig's seats; the other rig's seat is an outside peer", async () => {
    const refs = new ProviderAccountRefsRepository(db);
    expect(refs.add({ provider: "codex", label: "team", codexHome, login: "team" }).ok).toBe(true);
    // Both rigs are named fleet and run on the daemon's Codex home, with different members.
    for (const [rigId, ids] of [["rig-a", ["a1", "a2"]], ["rig-b", ["b1"]]] as const) {
      db.prepare("INSERT INTO rigs (id, name) VALUES (?, 'fleet')").run(rigId);
      db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, 'dev', 'Dev')").run(`pod-${rigId}`, rigId);
      for (const id of ids) {
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES (?, ?, ?, 'codex', '/w', ?)").run(id, rigId, `dev.${id}`, `pod-${rigId}`);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, 'running', 'ready')").run(`sess-${id}`, id, `${id}@fleet`);
      }
    }
    const plan = vi.fn<SeatRestart["plan"]>(async () => ({ ok: true, codexHome, activity: { state: "idle" }, peers: [] }) as never);
    const planned = await service().assignmentPlan({ rig: "rig-a", provider: "codex", label: "team", includeOverrides: false, daemon: "host-a" }, { plan, run: vi.fn() });
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.plan.rows.map((r) => [r.seat, r.effect, r.precheck?.safe])).toEqual([["a1@fleet", "change", true], ["a2@fleet", "change", true]]);
    expect(planned.plan.codexHomes).toEqual([{ home: codexHome, seats: [
      { seat: "a1@fleet", rig: "fleet", rigId: "rig-a", effect: "would restart" },
      { seat: "a2@fleet", rig: "fleet", rigId: "rig-a", effect: "would restart" },
      { seat: "b1@fleet", rig: "fleet", rigId: "rig-b", effect: "not restarted; needs rig seat restart b1@fleet" },
    ] }]);

    // The apply of that plan: one switch of the home, the chosen rig's other seat restarts on it, and the other rig's seat
    // is reported with its restart command, never restarted.
    const switchSeat = vi.fn(async () => ({ outcome: "succeeded" as const, message: "switched" }));
    const restartPeer = vi.fn(async () => ({ ok: true as const, outcome: "restarted_account_unverified", message: "restarted" }));
    const report = await applyAssignment(planned.plan, refs.get("codex", "team")!, { switchSeat, restartPeer, activityOf: () => "idle", save: () => {}, now: () => "t" });
    expect(report.results.map((r) => [r.seat, r.kind])).toEqual([["a1@fleet", "switched"], ["a2@fleet", "switched"]]);
    expect(switchSeat.mock.calls.map(([s]) => s)).toEqual(["a1@fleet"]);
    expect(restartPeer.mock.calls.map(([s]) => s)).toEqual(["a2@fleet"]);
    expect(report.otherRigPeers).toEqual([{ seat: "b1@fleet", rig: "fleet", home: codexHome, command: "rig seat restart b1@fleet --keep-conversation" }]);
  });

  it("two rigs with the same name and member on one Codex home: that session name's seat isn't read, switched, moved or restarted", async () => {
    const refs = new ProviderAccountRefsRepository(db);
    expect(refs.add({ provider: "codex", label: "team", codexHome, login: "team" }).ok).toBe(true);
    // Rig A has a1, a2 and a3; rig B, also named fleet, has an a2 too: two seats are a2@fleet.
    for (const [rigId, node, session] of [["rig-a", "a1", "a1@fleet"], ["rig-a", "a2", "a2@fleet"], ["rig-a", "a3", "a3@fleet"], ["rig-b", "x2", "a2@fleet"]] as const) {
      db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES (?, 'fleet')").run(rigId);
      db.prepare("INSERT OR IGNORE INTO pods (id, rig_id, namespace, label) VALUES (?, ?, 'dev', 'Dev')").run(`pod-${rigId}`, rigId);
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES (?, ?, ?, 'codex', '/w', ?)").run(node, rigId, `dev.${session.split("@")[0]}`, `pod-${rigId}`);
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, 'running', 'ready')").run(`sess-${node}`, node, session);
    }
    const seatActivity = vi.fn((_s: string) => ({ state: "running" }) as never);
    const svc = new ProviderServiceImpl({ db, listRigs: () => (db.prepare("SELECT id FROM rigs ORDER BY id").all() as Array<{ id: string }>),
      env: { HOME: dir, CODEX_HOME: codexHome }, platform: "linux", seatActivity,
      claudePrecedence: async () => ({ conflicts: [], checked: ["the pane environment"], notChecked: [] }) });
    const restartPlan = vi.fn<SeatRestart["plan"]>(async () => ({ ok: true, codexHome, activity: { state: "idle" }, peers: [] }) as never);
    const planned = await svc.assignmentPlan({ rig: "rig-a", provider: "codex", label: "team", includeOverrides: false, daemon: "host-a" }, { plan: restartPlan, run: vi.fn() });
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.plan.rows.map((r) => [r.seat, r.effect, r.activity, r.precheck?.reasons])).toEqual([
      ["a1@fleet", "change", "running", []], ["a2@fleet", "change", "unknown", ["seat_name_shared"]], ["a3@fleet", "change", "running", []]]);
    // Nothing read that seat by its name: not its activity, not the restart's plan.
    expect(seatActivity.mock.calls.map(([s]) => s)).not.toContain("a2@fleet");
    expect(restartPlan.mock.calls.map(([s]) => s)).toEqual(["a1@fleet", "a3@fleet"]);

    // The apply: a1 switches the home, a3 restarts on it, and a2@fleet is neither switched nor restarted. Its home changed
    // under it, so it's unknown, with its restart command.
    const switchSeat = vi.fn(async () => ({ outcome: "succeeded" as const, message: "switched" }));
    const restartPeer = vi.fn(async () => ({ ok: true as const, outcome: "restarted_account_unverified", message: "restarted" }));
    const report = await applyAssignment(planned.plan, refs.get("codex", "team")!, { switchSeat, restartPeer, activityOf: () => "idle", save: () => {}, now: () => "t" });
    expect(report.results.map((r) => [r.seat, r.kind])).toEqual([["a1@fleet", "switched"], ["a2@fleet", "unknown"], ["a3@fleet", "switched"]]);
    expect([switchSeat.mock.calls.map(([s]) => s), restartPeer.mock.calls.map(([s]) => s)]).toEqual([["a1@fleet"], ["a3@fleet"]]);
    // No restart command is given by that name, for this rig's seat or the other rig's: it could reach the other seat.
    const a2 = report.results.find((r) => r.seat === "a2@fleet")!;
    expect([a2.recovery, a2.detail]).toEqual([undefined, expect.stringContaining("It has no restart command: a restart reaches a seat by its session name, and that name no longer reaches this seat alone.")]);
    expect(planned.plan.codexHomes[0]!.seats.find((s) => s.rigId === "rig-b")!.effect).toBe("not restarted; another seat has its session name, so a restart by that name could reach that one instead");
    expect(report.otherRigPeers).toEqual([{ seat: "a2@fleet", rig: "fleet", home: codexHome,
      why: "It has no restart command: a restart reaches a seat by its session name, and that name no longer reaches this seat alone" }]);

    // With --account-home, the successor's dry run isn't asked about it either, and its move is never attempted.
    const prepared = path.join(dir, "prepared");
    fs.mkdirSync(prepared);
    const dryRun = vi.fn(async (_seat: string, _home: string) => ({ safe: true }) as const);
    const moving = await svc.assignmentPlan({ rig: "rig-a", provider: "codex", label: "team", includeOverrides: false, accountHome: prepared, daemon: "host-a" }, undefined, undefined, dryRun);
    if (!moving.ok) throw new Error(moving.message);
    expect(dryRun.mock.calls.map(([s]) => s)).toEqual(["a1@fleet", "a3@fleet"]);
    const successor = vi.fn(async () => ({ ok: true as const, changed: true }));
    const moved = await applyAssignment(moving.plan, refs.get("codex", "team")!, { switchSeat, restartPeer, successor, activityOf: () => "idle", save: () => {}, now: () => "t" });
    expect(moved.results.map((r) => [r.seat, r.kind])).toEqual([["a1@fleet", "pending_successor"], ["a2@fleet", "failed_before_effect"], ["a3@fleet", "pending_successor"]]);
    expect(successor.mock.calls.map(([s]) => s)).toEqual(["a1@fleet", "a3@fleet"]);
  });

  it("a Codex seat whose session name an archived rig's newer Claude seat has is refused by name: the precheck and switch would reach that seat first", async () => {
    const refs = new ProviderAccountRefsRepository(db);
    expect(refs.add({ provider: "codex", label: "team", codexHome, login: "team" }).ok).toBe(true);
    for (const [rigId, node, runtime, session] of [["rig-a", "k1", "codex", "sess-1"], ["rig-old", "c2", "claude-code", "sess-2"]] as const) {
      db.prepare("INSERT INTO rigs (id, name) VALUES (?, 'fleet')").run(rigId);
      db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, 'dev', 'Dev')").run(`pod-${rigId}`, rigId);
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES (?, ?, 'dev.a', ?, '/w', ?)").run(node, rigId, runtime, `pod-${rigId}`);
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, 'a@fleet', 'running', 'ready')").run(session, node);
    }
    new RigRepository(db).archiveRig("rig-old");
    // The Claude relaunch's lookup, as the route has it: the newest session row with the name, any rig, a Claude seat only.
    const claudeSeat = { seat: (s: string) => {
      const row = db.prepare(`SELECT n.id, n.rig_id, n.runtime, r.name FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
        WHERE s.session_name = ? ORDER BY s.id DESC LIMIT 1`).get(s) as { id: string; rig_id: string; runtime: string; name: string } | undefined;
      return row?.runtime === "claude-code" ? { nodeId: row.id, rigId: row.rig_id, rigName: row.name, logicalId: "dev.a", running: true, pane: null } : null;
    } } as never;
    const svc = new ProviderServiceImpl({ db, listRigs: () => new RigRepository(db).listRigs(), env: { HOME: dir, CODEX_HOME: codexHome }, platform: "linux",
      claudePrecedence: async () => ({ conflicts: [], checked: ["the pane environment"], notChecked: [] }) });
    const restartPlan = vi.fn<SeatRestart["plan"]>(async () => ({ ok: true, codexHome, activity: { state: "idle" }, peers: [] }) as never);
    const planned = await svc.assignmentPlan({ rig: "fleet", provider: "codex", label: "team", includeOverrides: false, daemon: "host-a" }, { plan: restartPlan, run: vi.fn() }, claudeSeat);
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.plan.rows.map((r) => [r.seat, r.precheck?.reasons])).toEqual([["a@fleet", ["seat_name_shared"]]]);
    expect(planned.plan.rows[0]!.precheck!.message).toContain("a@fleet reaches the seat in rig rig-old (archived), not this one");
    expect(restartPlan).not.toHaveBeenCalled();

    // A move to a prepared home goes through the successor, whose dry run and run use the seat-ref resolver: it skips the
    // archived rig, so the name reaches k1 and the move is checked and runs.
    const prepared = path.join(dir, "prepared");
    const successorCheck = vi.fn(async () => ({ safe: true, reasons: [], message: "would move" }));
    const successor = vi.fn(async () => ({ ok: true as const, changed: true }));
    const request = { rig: "fleet", provider: "codex" as const, label: "team", includeOverrides: false, accountHome: prepared, daemon: "host-a" };
    const moving = await svc.assignmentPlan(request, undefined, claudeSeat, successorCheck);
    if (!moving.ok) throw new Error(moving.message);
    expect(moving.plan.rows.map((r) => [r.seat, r.precheck?.safe])).toEqual([["a@fleet", true]]);
    expect(successorCheck).toHaveBeenCalledWith("a@fleet", prepared);
    const moved = await svc.applyAssignment({ ...request, digest: moving.plan.digest, requestedBy: null }, { claudeSeat, successorCheck, successor });
    if (!moved.ok) throw new Error(moved.message);
    expect(successor).toHaveBeenCalledWith("a@fleet", prepared);
    expect(moved.report.results.map((r) => [r.seat, r.kind])).toEqual([["a@fleet", "pending_successor"]]);
  });

  it("a seat restarted on a switched home is checked with the restart's own lookup when it runs; its plan stays Claude-first, as its precheck is", async () => {
    const refs = new ProviderAccountRefsRepository(db);
    expect(refs.add({ provider: "codex", label: "team", codexHome, login: "team" }).ok).toBe(true);
    seat("fleet", "k1", "codex", "a@fleet");
    seat("fleet", "k2", "codex", "b@fleet");
    // The Claude relaunch's lookup, as the route has it: the newest session row with the name, any rig, a Claude seat only.
    const claudeSeat = { seat: (s: string) => {
      const row = db.prepare(`SELECT n.id, n.rig_id, n.runtime, r.name FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
        WHERE s.session_name = ? ORDER BY s.id DESC LIMIT 1`).get(s) as { id: string; rig_id: string; runtime: string; name: string } | undefined;
      return row?.runtime === "claude-code" ? { nodeId: row.id, rigId: row.rig_id, rigName: row.name, logicalId: "dev.k2", running: true, pane: null } : null;
    } } as never;
    // An archived rig, also named fleet, whose Claude seat has b@fleet's name, registered while the apply runs (as a@fleet
    // restarts), after the plan's checks.
    const registerArchived = () => {
      db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-old', 'fleet')").run();
      db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES ('pod-old', 'rig-old', 'dev', 'Dev')").run();
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES ('c2', 'rig-old', 'dev.k2', 'claude-code', '/w', 'pod-old')").run();
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('sess-z', 'c2', 'b@fleet', 'running', 'ready')").run();
      new RigRepository(db).archiveRig("rig-old");
    };
    const run = vi.fn<SeatRestart["run"]>(async (s) => {
      if (s === "a@fleet") registerArchived();
      return { ok: true, codexHome, outcome: "restarted_account_unverified", message: "restarted", activity: { state: "idle" }, peers: [] } as never;
    });
    const seatRestart = { plan: vi.fn<SeatRestart["plan"]>(async () => ({ ok: true, codexHome, activity: { state: "idle" }, peers: [] }) as never), run };
    const svc = new ProviderServiceImpl({ db, listRigs: () => new RigRepository(db).listRigs(), env: { HOME: dir, CODEX_HOME: codexHome }, platform: "linux",
      codexLogins: { list: () => ["team", "next"], save: () => ({ ok: false, reason: "not_configured" }), activate: () => ({ ok: true }) },
      claudePrecedence: async () => ({ conflicts: [], checked: ["the pane environment"], notChecked: [] }) });
    const request = { rig: "fleet", provider: "codex" as const, label: "team", includeOverrides: false, daemon: "host-a" };
    const planned = await svc.assignmentPlan(request, seatRestart, claudeSeat);
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.plan.rows.map((r) => [r.seat, r.precheck?.safe])).toEqual([["a@fleet", true], ["b@fleet", true]]);
    const applied = await svc.applyAssignment({ ...request, digest: planned.plan.digest, requestedBy: null }, { seatRestart, claudeSeat });
    if (!applied.ok) throw new Error(applied.message);
    // a@fleet switched the home; b@fleet is restarted on it through the seat-ref resolver, which skips the archived rig.
    expect(run.mock.calls.map(([s]) => s)).toEqual(["a@fleet", "b@fleet"]);
    // The next plan checks b@fleet with its precheck, which asks the Claude lookup first: that finds the archived Claude
    // seat, so the row is refused by name rather than given that seat's verdict.
    fs.writeFileSync(path.join(codexHome, "auth-profiles", "next.json"), CONTENT, { mode: 0o600 });
    expect(refs.add({ provider: "codex", label: "next", codexHome, login: "next" }).ok).toBe(true);
    const again = await svc.assignmentPlan({ ...request, label: "next" }, seatRestart, claudeSeat);
    if (!again.ok) throw new Error(again.message);
    const b = again.plan.rows.find((r) => r.seat === "b@fleet")!;
    expect(b.precheck?.reasons).toEqual(["seat_name_shared"]);
    expect(b.precheck?.message).toContain("b@fleet reaches the seat in rig rig-old (archived), not this one");
  });

  // Found in review of #3679: a seat's result row references its node, so an apply whose seat was removed while it ran
  // threw on saving that row, after other seats had changed, and reported nothing.
  it("a seat removed while the apply runs is still reported, with no command; the apply finishes and saves the other seats' results", async () => {
    const refs = new ProviderAccountRefsRepository(db);
    expect(refs.add({ provider: "codex", label: "team", codexHome, login: "team" }).ok).toBe(true);
    seat("fleet", "k1", "codex", "a@fleet");
    seat("fleet", "k2", "codex", "b@fleet");
    const nodeOf = (s: string) => (db.prepare("SELECT node_id FROM sessions WHERE session_name = ?").get(s) as { node_id: string }).node_id;
    const removed = nodeOf("a@fleet");
    // a@fleet's removal holds its lease first: the pinned restart then finds no seat, as restartInPlace reports it.
    const run = vi.fn<SeatRestart["run"]>(async (s) => {
      if (s !== "a@fleet") return { ok: true, codexHome, outcome: "restarted_account_unverified", message: "restarted", activity: { state: "idle" }, peers: [] } as never;
      new RigRepository(db).deleteNode(removed);
      return { ok: false, code: "seat_name_shared", message: '"a@fleet" no longer names the seat this restart was for, or any seat; nothing was restarted.' } as never;
    });
    const seatRestart = { plan: vi.fn<SeatRestart["plan"]>(async () => ({ ok: true, codexHome, activity: { state: "idle" }, peers: [] }) as never), run };
    const svc = new ProviderServiceImpl({ db, listRigs: () => new RigRepository(db).listRigs(), env: { HOME: dir, CODEX_HOME: codexHome }, platform: "linux",
      codexLogins: { list: () => ["team"], save: () => ({ ok: false, reason: "not_configured" }), activate: () => ({ ok: true }) },
      claudePrecedence: async () => ({ conflicts: [], checked: ["the pane environment"], notChecked: [] }) });
    const request = { rig: "fleet", provider: "codex" as const, label: "team", includeOverrides: false, daemon: "host-a" };
    const planned = await svc.assignmentPlan(request, seatRestart);
    if (!planned.ok) throw new Error(planned.message);
    const applied = await svc.applyAssignment({ ...request, digest: planned.plan.digest, requestedBy: null }, { seatRestart });
    if (!applied.ok) throw new Error(applied.message);
    // a@fleet left the home unknown, so b@fleet is skipped with its own restart step (its name still reaches it alone).
    expect(run.mock.calls.map(([s]) => s)).toEqual(["a@fleet"]);
    const [a, b] = applied.report.results;
    expect(a).toMatchObject({ seat: "a@fleet", kind: "unknown" });
    expect(a!.recovery).toBeUndefined();
    expect(a!.detail).toContain('"a@fleet" no longer names the seat this restart was for, or any seat; nothing was restarted.');
    expect(a!.detail).toContain("It has no restart command: a restart reaches a seat by its session name, and that name no longer reaches this seat alone.");
    expect(a!.detail).not.toContain("rig seat restart");
    expect(b).toMatchObject({ seat: "b@fleet", kind: "unknown", recovery: "rig seat restart b@fleet --keep-conversation" });
    const assignments = new ProviderAccountAssignmentsRepository(db);
    const rigId = (db.prepare("SELECT rig_id FROM nodes WHERE id = ?").get(nodeOf("b@fleet")) as { rig_id: string }).rig_id;
    expect(assignments.results(rigId, "codex").map((r) => [r.seat, r.kind])).toEqual([["b@fleet", b!.kind]]);
  });

  it("an outside peer whose session name a seat in a third rig has, on another home, gets no restart command", async () => {
    const refs = new ProviderAccountRefsRepository(db);
    expect(refs.add({ provider: "codex", label: "team", codexHome, login: "team" }).ok).toBe(true);
    const otherHome = path.join(dir, "other-home");
    fs.mkdirSync(otherHome);
    // rig-a is the one assigned. Two other rigs are both named other, each with a member p: one on this Codex home, one on
    // another home. `rig seat restart p@other` reaches neither alone.
    for (const [rigId, name, node, session] of [["rig-a", "fleet", "c1", "c1@fleet"], ["rig-o1", "other", "p1", "p@other"], ["rig-o2", "other", "p2", "p@other"]] as const) {
      db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(rigId, name);
      db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, 'dev', 'Dev')").run(`pod-${rigId}`, rigId);
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES (?, ?, ?, 'codex', '/w', ?)").run(node, rigId, `dev.${session.split("@")[0]}`, `pod-${rigId}`);
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, 'running', 'ready')").run(`sess-${node}`, node, session);
    }
    db.prepare("UPDATE nodes SET account_home = ? WHERE id = 'p2'").run(otherHome);
    const restartPlan = vi.fn<SeatRestart["plan"]>(async () => ({ ok: true, codexHome, activity: { state: "idle" }, peers: [] }) as never);
    const planned = await service().assignmentPlan({ rig: "rig-a", provider: "codex", label: "team", includeOverrides: false, daemon: "host-a" }, { plan: restartPlan, run: vi.fn() });
    if (!planned.ok) throw new Error(planned.message);
    expect(planned.plan.codexHomes).toEqual([{ home: codexHome, seats: [
      { seat: "c1@fleet", rig: "fleet", rigId: "rig-a", effect: "would restart" },
      { seat: "p@other", rig: "other", rigId: "rig-o1", sharedName: true, effect: "not restarted; another seat has its session name, so a restart by that name could reach that one instead" },
    ] }]);
    const report = await applyAssignment(planned.plan, refs.get("codex", "team")!, { switchSeat: vi.fn(async () => ({ outcome: "succeeded" as const, message: "switched" })),
      restartPeer: vi.fn(), activityOf: () => "idle", save: () => {}, now: () => "t" });
    expect(report.otherRigPeers).toEqual([{ seat: "p@other", rig: "other", home: codexHome,
      why: "It has no restart command: a restart reaches a seat by its session name, and that name no longer reaches this seat alone" }]);
  });

  it("reads each seat's own token, account home and Codex home, and lists a shared home's peer in another rig", async () => {
    const refs = new ProviderAccountRefsRepository(db);
    expect(refs.add({ provider: "codex", label: "team", codexHome, login: "team" }).ok).toBe(true);
    seat("fleet", "c1", "codex", "c1@fleet");
    seat("fleet", "c2", "codex", "c2@fleet");
    seat("fleet", "cl", "claude-code", "cl@fleet");
    seat("other", "p1", "codex", "p1@other");
    db.prepare("UPDATE nodes SET account_home = ? WHERE id = 'c2'").run(path.join(dir, "own-home"));
    const plan = vi.fn<SeatRestart["plan"]>(async () => ({ ok: false, code: "settings_unverified", message: "read on Linux only" }) as never);

    const result = await service().assignmentPlan({ rig: "fleet", provider: "codex", label: "team", includeOverrides: false, daemon: "host-a" },
      { plan, run: vi.fn() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.rows.map((r) => [r.seat, r.effect])).toEqual([["c1@fleet", "change"], ["c2@fleet", "kept_override"], ["cl@fleet", "not_affected"]]);
    expect(result.plan.rows[1]!.override).toBe(`its account home ${path.join(dir, "own-home")}`);
    // The existing precheck ran for the seat that would change, and only for it.
    expect(plan.mock.calls.map(([s]) => s)).toEqual(["c1@fleet"]);
    expect(result.plan.rows[0]!.precheck).toMatchObject({ safe: false, reasons: ["seat_restart_refused"] });
    expect(result.plan.codexHomes).toEqual([{ home: codexHome, seats: [
      { seat: "c1@fleet", rig: "fleet", rigId: "rig-fleet", effect: "would restart" },
      { seat: "p1@other", rig: "other", rigId: "rig-other", effect: "not restarted; needs rig seat restart p1@other" },
    ] }]);
  });

  it("a move to a prepared home is checked by the account-home dry run it's handed, not the in-place precheck", async () => {
    new ProviderAccountRefsRepository(db).add({ provider: "codex", label: "team", codexHome, login: "team" });
    seat("fleet", "c1", "codex", "c1@fleet");
    const restartPlan = vi.fn<SeatRestart["plan"]>();
    const dryRun = vi.fn(async () => ({ safe: false as const, reasons: ["runtime_switch_unsupported"], message: "one pane only" }));
    const request = { rig: "fleet", provider: "codex" as const, label: "team", includeOverrides: false, accountHome: "/prepared", daemon: "h" };
    const result = await service("darwin").assignmentPlan(request, { plan: restartPlan, run: vi.fn() }, undefined, dryRun);
    expect(dryRun).toHaveBeenCalledWith("c1@fleet", "/prepared");
    expect(restartPlan).not.toHaveBeenCalled();
    expect(result.ok && result.plan.rows[0]!.precheck).toEqual({ safe: false, reasons: ["runtime_switch_unsupported"], message: "one pane only" });
    // Without one, the row says it wasn't checked rather than borrowing the in-place verdict.
    const unchecked = await service("darwin").assignmentPlan(request, { plan: restartPlan, run: vi.fn() });
    expect(unchecked.ok && unchecked.plan.rows[0]!.precheck).toMatchObject({ safe: false, reasons: ["successor_not_checked"] });
    expect(restartPlan).not.toHaveBeenCalled();
  });

  it("refuses an unknown label, naming the list, and an unknown rig", async () => {
    seat("fleet", "c1", "codex", "c1@fleet");
    expect(await service().assignmentPlan({ rig: "fleet", provider: "codex", label: "nope", includeOverrides: false, daemon: "h" })).toEqual({
      ok: false, code: "unknown_account", message: "There's no codex account labelled nope on this daemon (rig provider account list --provider codex lists them)." });
    new ProviderAccountRefsRepository(db).add({ provider: "codex", label: "team", codexHome, login: "team" });
    expect(await service().assignmentPlan({ rig: "elsewhere", provider: "codex", label: "team", includeOverrides: false, daemon: "h" }))
      .toMatchObject({ ok: false, code: "unknown_rig" });
  });

  it("checks the reference again: a link that now points at an empty file is refused", async () => {
    seat("fleet", "cl", "claude-code", "cl@fleet");
    const link = path.join(dir, "token-link");
    fs.symlinkSync(privateFile("token"), link);
    expect(new ProviderAccountRefsRepository(db).add({ provider: "claude", label: "max-2", tokenFile: link }).ok).toBe(true);
    const empty = path.join(dir, "empty");
    fs.writeFileSync(empty, "", { mode: 0o600 });
    fs.rmSync(link);
    fs.symlinkSync(empty, link);
    const result = await service().assignmentPlan({ rig: "fleet", provider: "claude", label: "max-2", includeOverrides: false, daemon: "h" });
    expect(result).toEqual({ ok: false, code: "reference_unusable",
      message: `max-2's reference no longer checks out: the token file ${link} is empty.` });
    expect(JSON.stringify(result)).not.toContain(CONTENT);
  });
});

describe("GET /api/provider/assignment-plan", () => {
  // A stand-in tmux that records each call and does nothing: the real restart plan and dry run run, never a live server.
  let tmuxCalls: string[] = [];
  const fakeTmux = () => new Proxy({}, { get: (_t, key) => key === "then" || key === "deliveryGuard" ? undefined
    : (..._args: unknown[]) => { tmuxCalls.push(String(key));
      return Promise.resolve(key === "listPanes" ? [{ id: "%0" }] : key === "listWindows" ? [{ id: "@0" }] : []); } });

  function app(opts: { codexAdapter?: boolean } = {}): Hono {
    const a = new Hono();
    a.use("*", async (c, next) => {
      c.set("rigRepo" as never, new RigRepository(db));
      c.set("sessionRegistry" as never, new SessionRegistry(db));
      c.set("eventBus" as never, new EventBus(db));
      c.set("discoveryRepo" as never, new DiscoveryRepository(db));
      // Only the dry run gets a Codex adapter: it checks one exists, and starts nothing in a dry run.
      if (opts.codexAdapter) c.set("runtimeAdapters" as never, { codex: { runtime: "codex" } });
      c.set("tmuxAdapter" as never, fakeTmux());
      c.set("providerService" as never, service());
      await next();
    });
    a.route("/api/provider", providerRoutes());
    return a;
  }

  it("a rig name two rigs share is 409 rig_ambiguous with both ids, and nothing changes", async () => {
    new ProviderAccountRefsRepository(db).add({ provider: "claude", label: "max-2", tokenFile: privateFile("token") });
    seat("fleet", "a", "claude-code", "a@fleet");
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-fleet-2', 'fleet')").run();
    const before = everything();
    const res = await app().request("/api/provider/assignment-plan?rig=fleet&provider=claude&account=max-2");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "rig_ambiguous", candidates: ["rig-fleet", "rig-fleet-2"] });
    expect(everything()).toBe(before);
  });

  it("answers the plan for a rig, and changes nothing: no seat, reference or other row, and no file", async () => {
    const token = privateFile("token");
    const other = privateFile("other-token");
    new ProviderAccountRefsRepository(db).add({ provider: "claude", label: "max-2", tokenFile: token });
    seat("fleet", "a", "claude-code", "a@fleet");
    seat("fleet", "b", "claude-code", "b@fleet");
    seat("fleet", "x", "codex", "x@fleet", "running", true);
    seat("fleet", "s", "claude-code", "s@fleet", "stopped");
    new ProviderAccountRefsRepository(db).add({ provider: "codex", label: "team", codexHome, login: "team" });
    db.prepare("UPDATE nodes SET claude_token_ref = ? WHERE id = 'b'").run(JSON.stringify({ label: "max-1", tokenFile: other }));
    const before = everything();
    const saved = fs.statSync(path.join(codexHome, "auth-profiles", "team.json"));
    const stat = fs.statSync(token);

    const res = await app().request("/api/provider/assignment-plan?rig=fleet&provider=claude&account=max-2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, plan: { daemon: "local", rig: "fleet", provider: "claude", account: { label: "max-2" } } });
    expect(body.plan.rows.map((r: { seat: string; effect: string }) => [r.seat, r.effect])).toEqual([
      ["a@fleet", "change"], ["b@fleet", "kept_override"], ["s@fleet", "change"], ["x@fleet", "not_affected"]]);
    // A stopped seat: its precheck reads its next launch, and the row follows what it found.
    expect(body.plan.rows[2]).toMatchObject({ precheck: { safe: false, reasons: ["conversation_not_resumable"] },
      continuity: "not resumable: the precheck found no conversation the seat's next launch would resume" });
    expect(body.plan.rows[0]).toMatchObject({ precheck: { safe: true }, continuity: "in place: the seat is relaunched in its own pane and keeps its conversation" });

    const included = await (await app().request("/api/provider/assignment-plan?rig=fleet&provider=claude&account=max-2&includeOverrides=1")).json();
    expect(included.plan.rows[1].effect).toBe("change");
    // A Codex plan, in place and to a prepared home, through the same route.
    const codex = await app().request("/api/provider/assignment-plan?rig=fleet&provider=codex&account=team");
    expect(codex.status).toBe(200);
    // The real restart plan answers (this daemon has no Codex adapter); the plan shows its verdict.
    expect((await codex.json()).plan.rows.find((r: { seat: string }) => r.seat === "x@fleet")).toMatchObject({ effect: "change",
      precheck: { safe: false, reasons: ["seat_restart_refused"] } });
    const prepared = await app({ codexAdapter: true }).request(`/api/provider/assignment-plan?rig=fleet&provider=codex&account=team&accountHome=${encodeURIComponent(dir)}`);
    expect(prepared.status).toBe(200);
    // The real account-home dry run answers, through every gate to its dry-run return, and the plan shows it safe.
    expect((await prepared.json()).plan.rows.find((r: { seat: string }) => r.seat === "x@fleet")).toMatchObject({
      precheck: { safe: true, reasons: [] }, continuity: `fresh successor with handover, on ${dir}` });
    expect(everything()).toBe(before);
    expect(fs.statSync(path.join(codexHome, "auth-profiles", "team.json")).mtimeMs).toBe(saved.mtimeMs);
    expect(fs.readdirSync(codexHome).sort()).toEqual(["auth-profiles"]);
    expect(fs.existsSync(scratchHome)).toBe(false);
    // Whatever the checks asked of tmux, it was only reading.
    expect(tmuxCalls.filter((k) => !/^(list|has|get|show|capture|display)/i.test(k))).toEqual([]);
    expect(fs.statSync(token).mtimeMs).toBe(stat.mtimeMs);
    expect(JSON.stringify(body)).not.toContain(CONTENT);
  });

  it("refuses a malformed request (400), an unknown label or rig (404) and a stale reference (409)", async () => {
    seat("fleet", "a", "claude-code", "a@fleet");
    const request = (q: string) => app().request(`/api/provider/assignment-plan?${q}`);
    expect((await request("provider=claude&account=x")).status).toBe(400);
    expect((await request("rig=fleet&provider=pi&account=x")).status).toBe(400);
    expect((await request("rig=fleet&provider=claude&account=x&accountHome=/h")).status).toBe(400);
    expect((await request("rig=fleet&provider=codex&account=x&accountHome=relative")).status).toBe(400);
    const unknown = await request("rig=fleet&provider=claude&account=x");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).message).toContain("rig provider account list --provider claude");
    const token = privateFile("token");
    new ProviderAccountRefsRepository(db).add({ provider: "claude", label: "max-2", tokenFile: token });
    expect((await request("rig=nowhere&provider=claude&account=max-2")).status).toBe(404);
    fs.rmSync(token);
    expect((await request("rig=fleet&provider=claude&account=max-2")).status).toBe(409);
  });

  it("is 503 when the service has no plan", async () => {
    const a = new Hono();
    a.use("*", async (c, next) => { c.set("providerService" as never, { getReadModel: vi.fn(), precheck: vi.fn(), switchAccount: vi.fn() }); await next(); });
    a.route("/api/provider", providerRoutes());
    expect((await a.request("/api/provider/assignment-plan?rig=r&provider=claude&account=a")).status).toBe(503);
  });
});
