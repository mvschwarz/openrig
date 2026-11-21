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
        kind: "pending_successor", detail: "d", recovery: null, activity: "idle", at: "t", applied: { file: null, fileKind: null, codexHome: appliedHome, codexLogin: null } });
      const planned = await service().assignmentPlan({ rig: "fleet", provider: "codex", label: "team", includeOverrides: false, daemon: "host-a" });
      return planned.ok ? planned.plan.rows[0]!.effect : planned.message;
    };
    expect(await effectAfter(prepared)).toBe("change");
    const elsewhere = path.join(dir, "elsewhere");
    fs.mkdirSync(elsewhere);
    expect(await effectAfter(elsewhere)).toBe("kept_override");
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
      recovery: null, activity: "idle", at: "t", applied: { file: null, fileKind: null, codexHome, codexLogin: "team" } });
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
      recovery: null, activity: "idle", at: "t", applied: { file: null, fileKind: null, codexHome: path.join(dir, "elsewhere"), codexLogin: "team" } });
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
      ...(moved ? { applied: { file: null, fileKind: null, codexHome, codexLogin: "team" } } : {}) });
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
        kind: "switched", detail: "d", recovery: null, activity: "idle", at: "t", applied: { file: null, fileKind: null, codexHome: appliedHome, codexLogin: "team" } });
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
      { seat: "c1@fleet", rig: "fleet", effect: "would restart" },
      { seat: "p1@other", rig: "other", effect: "not restarted; needs rig seat restart p1@other" },
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

  it("checks the reference again: a link that now points at a non-private file is refused", async () => {
    seat("fleet", "cl", "claude-code", "cl@fleet");
    const link = path.join(dir, "token-link");
    fs.symlinkSync(privateFile("token"), link);
    expect(new ProviderAccountRefsRepository(db).add({ provider: "claude", label: "max-2", tokenFile: link }).ok).toBe(true);
    const open = path.join(dir, "open");
    fs.writeFileSync(open, CONTENT, { mode: 0o644 });
    fs.chmodSync(open, 0o644);
    fs.rmSync(link);
    fs.symlinkSync(open, link);
    const result = await service().assignmentPlan({ rig: "fleet", provider: "claude", label: "max-2", includeOverrides: false, daemon: "h" });
    expect(result).toEqual({ ok: false, code: "reference_unusable",
      message: `max-2's reference no longer checks out: the token file ${link} must be private (0600 or 0400), and it is 0644.` });
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
