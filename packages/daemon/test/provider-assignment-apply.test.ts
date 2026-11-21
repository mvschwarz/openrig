import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { providerRoutes } from "../src/routes/provider.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { readClaudeSeatTokenRef } from "../src/domain/claude-seat-token.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { accountRefUses, ProviderAccountRefsRepository } from "../src/domain/provider/provider-account-refs.js";
import type { AssignmentApplyRequest, ClaudeSeatRelaunch } from "../src/domain/provider/provider-service.js";
import { ProviderAccountAssignmentsRepository } from "../src/domain/provider/provider-account-assignments.js";
import { readCurrentSeatActivity } from "../src/domain/node-inventory.js";
import type { AgentActivity } from "../src/domain/types.js";
import type { StructuralObservation } from "../src/domain/seat-structural-activity-service.js";

// #3625 slice 3: the daemon applies a plan only while its digest matches, one apply per rig, stores the assignment and
// each seat's result, and reads them back: in the plan, and in which seats follow an assignment rather than override it.

const CONTENT = "synthetic-content-never-echoed";
let dir: string;
let db: Database.Database;
let svc: ProviderServiceImpl;
/** When set, a credential in the daemon's environment outranks any token file: every Claude precheck is unsafe. */
let outranked = false;

function seat(id: string, status = "stopped", rig = "fleet") {
  db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES (?, ?)").run(`rig-${rig}`, rig);
  db.prepare("INSERT OR IGNORE INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run(`pod-${rig}`, `rig-${rig}`, "dev", "Dev");
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES (?, ?, ?, ?, ?, ?)").run(id, `rig-${rig}`, `dev.${id}`, "claude-code", "/w", `pod-${rig}`);
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)").run(`sess-${id}`, id, `${id}@${rig}`, status, "ready");
}

function token(name: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, CONTENT, { mode: 0o600 });
  return p;
}

/** Claude's relaunch for stopped seats: the token reference is read and written for real; nothing is relaunched. */
function stoppedClaude(gate: Promise<void> = Promise.resolve()): ClaudeSeatRelaunch & { relaunchInPane: ReturnType<typeof vi.fn>; entered: () => boolean } {
  const repo = new RigRepository(db);
  let entered = false;
  return {
    entered: () => entered,
    seat: (s) => {
      const row = db.prepare(`SELECT n.id, n.rig_id, r.name, n.logical_id FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
        WHERE s.session_name = ? AND n.runtime = 'claude-code'`).get(s) as { id: string; rig_id: string; name: string; logical_id: string } | undefined;
      return row ? { nodeId: row.id, rigId: row.rig_id, rigName: row.name, logicalId: row.logical_id, running: false, pane: null } : null;
    },
    tokenRef: (nodeId) => readClaudeSeatTokenRef(db, nodeId),
    setTokenRef: (nodeId, ref) => repo.setNodeClaudeTokenRef(nodeId, ref),
    snapshot: () => { throw new Error("a stopped seat takes no snapshot"); },
    nextLaunch: () => ({ snapshotId: "snap-1", resumes: true, automatic: false, conversation: "conv-1" }),
    exclusive: async (_nodeId, fn) => { entered = true; await gate; return fn(); },
    relaunchInPane: vi.fn(async () => { throw new Error("a stopped seat isn't relaunched"); }),
  };
}

const request = (label: string, digest: string, over: Partial<AssignmentApplyRequest> = {}): AssignmentApplyRequest =>
  ({ rig: "fleet", provider: "claude", label, includeOverrides: false, daemon: "host-a", digest, requestedBy: "lead@fleet", ...over });

async function digestOf(label: string, claude: ClaudeSeatRelaunch): Promise<string> {
  const planned = await svc.assignmentPlan({ rig: "fleet", provider: "claude", label, includeOverrides: false, daemon: "host-a" }, undefined, claude);
  if (!planned.ok) throw new Error(planned.message);
  return planned.plan.digest;
}

function everything(): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
  return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assignment-apply-"));
  db = createFullTestDb();
  svc = new ProviderServiceImpl({ db, listRigs: () => db.prepare("SELECT id FROM rigs ORDER BY id").all() as Array<{ id: string }>,
    env: { HOME: dir }, platform: "linux", now: () => "2026-11-21T07:00:00.000Z",
    claudePrecedence: async () => ({ conflicts: outranked ? [{ name: "ANTHROPIC_API_KEY", source: "the daemon's environment", remedy: "remove it" }] : [],
      checked: ["the pane environment"], notChecked: [] }) });
  outranked = false;
  const refs = new ProviderAccountRefsRepository(db);
  for (const label of ["max-1", "max-2", "max-3"]) refs.add({ provider: "claude", label, tokenFile: token(label) });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("applying an assignment on the daemon", () => {
  it("applies the plan it was shown, stores the assignment and each result, and the plan reads them back", async () => {
    seat("a"); seat("b");
    db.prepare("UPDATE nodes SET claude_token_ref = ? WHERE id = 'b'").run(JSON.stringify({ label: "max-1", tokenFile: path.join(dir, "max-1") }));
    const claude = stoppedClaude();
    const result = await svc.applyAssignment(request("max-2", await digestOf("max-2", claude)), { claudeSeat: claude });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.results.map((r) => [r.seat, r.kind])).toEqual([["a@fleet", "switched"], ["b@fleet", "unchanged"]]);
    expect(result.report.results[1]!.detail).toBe('kept (seat override): its own token file ' + path.join(dir, "max-1") + ' ("max-1")');
    expect(readClaudeSeatTokenRef(db, "a")).toMatchObject({ label: "max-2", tokenFile: path.join(dir, "max-2") });
    expect(claude.relaunchInPane).not.toHaveBeenCalled();

    const again = await svc.assignmentPlan({ rig: "fleet", provider: "claude", label: "max-2", includeOverrides: false, daemon: "host-a" }, undefined, claude);
    expect(again.ok && again.plan.intent).toEqual({ label: "max-2", reference: `the token file ${path.join(dir, "max-2")}`, requestedBy: "lead@fleet", at: "2026-11-21T07:00:00.000Z" });
    expect(again.ok && again.plan.rows.map((r) => [r.seat, r.effect, r.lastResult?.kind])).toEqual([["a@fleet", "unchanged", "switched"], ["b@fleet", "kept_override", "unchanged"]]);
    // The label is in use now: removing it is refused, naming the rig.
    const uses = new ProviderAccountRefsRepository(db, { uses: accountRefUses(db) });
    expect(uses.remove("claude", "max-2")).toMatchObject({ ok: false, code: "in_use", usedBy: ["rig fleet (claude)"] });
    expect(JSON.stringify(result)).not.toContain(CONTENT);
  });

  it("reads each seat's activity as rig ps does: a working hook, else the pane; the plan notes a busy seat and the apply stores it", async () => {
    seat("hook"); seat("pane"); seat("quiet");
    // hook: its hook says it's working (the pane's idle frame doesn't outrank it). pane: no hook, and the cached pane
    // reading is working. quiet: neither, so unknown.
    const hooks: Record<string, AgentActivity> = { "hook@fleet": { state: "running", reason: "user_prompt_submit", evidenceSource: "runtime_hook", sampledAt: "t", stale: false } as AgentActivity };
    const panes: Record<string, StructuralObservation> = {
      "hook@fleet": { state: "agent_idle", reason: "idle_prompt", evidence: null, observedAt: "t" },
      "pane@fleet": { state: "agent_active", reason: "esc_to_interrupt", evidence: "esc to interrupt", observedAt: "t" } };
    const seatActivity = (s: string) => readCurrentSeatActivity({ hooks: { getLatestForNode: ({ sessionName }) => hooks[sessionName ?? ""] ?? null },
      structural: { getStructuralActivity: (n) => panes[n] ?? null }, runtimeOf: () => "claude-code" }, s).activity;
    svc = new ProviderServiceImpl({ db, listRigs: () => db.prepare("SELECT id FROM rigs ORDER BY id").all() as Array<{ id: string }>,
      env: { HOME: dir }, platform: "linux", now: () => "2026-11-21T07:00:00.000Z", seatActivity,
      claudePrecedence: async () => ({ conflicts: [], checked: ["the pane environment"], notChecked: [] }) });
    const claude = stoppedClaude();
    const planned = await svc.assignmentPlan({ rig: "fleet", provider: "claude", label: "max-2", includeOverrides: false, daemon: "host-a" }, undefined, claude);
    expect(planned.ok && planned.plan.rows.map((r) => [r.seat, r.activity, (r.notes ?? []).some((n) => n.startsWith("busy (working)"))]))
      .toEqual([["hook@fleet", "running", true], ["pane@fleet", "running", true], ["quiet@fleet", "unknown", false]]);
    // The activity isn't in the digest, so the apply acts on the same plan, and each result stores what the seat was doing.
    const result = await svc.applyAssignment(request("max-2", planned.ok ? planned.plan.digest : ""), { claudeSeat: claude });
    expect(result.ok).toBe(true);
    expect(new ProviderAccountAssignmentsRepository(db).results("rig-fleet", "claude").map((r) => [r.seat, r.kind, r.activity]).sort())
      .toEqual([["hook@fleet", "switched", "running"], ["pane@fleet", "switched", "running"], ["quiet@fleet", "switched", "unknown"]]);
    // Status shows it with the seat's last result.
    const model = await svc.getReadModel();
    expect(model.bindings.find((b) => b.seatSession === "hook@fleet")!.assignment?.applied).toMatchObject({ kind: "switched", activity: "running" });
  });

  it("a seat brought in with --include-overrides that's already on the account follows the assignment from then on", async () => {
    seat("own"); seat("mine");
    // Both chose max-2 by hand. Only "own" is brought in with --include-overrides.
    for (const id of ["own", "mine"]) db.prepare("UPDATE nodes SET claude_token_ref = ? WHERE id = ?").run(JSON.stringify({ label: "max-2", tokenFile: path.join(dir, "max-2") }), id);
    const claude = stoppedClaude();
    const digest = async (over: { includeOverrides: boolean; label: string }) => {
      const p = await svc.assignmentPlan({ rig: "fleet", provider: "claude", daemon: "host-a", ...over }, undefined, claude);
      if (!p.ok) throw new Error(p.message);
      return p.plan;
    };
    const folded = await svc.applyAssignment(request("max-2", (await digest({ includeOverrides: true, label: "max-2" })).digest, { includeOverrides: true }), { claudeSeat: claude });
    expect(folded.ok && folded.report.results.map((r) => [r.seat, r.kind])).toEqual([["mine@fleet", "unchanged"], ["own@fleet", "unchanged"]]);
    const saved = new ProviderAccountAssignmentsRepository(db).results("rig-fleet", "claude");
    expect(saved.map((r) => [r.seat, r.applied?.file ?? null]).sort()).toEqual([["mine@fleet", path.join(dir, "max-2")], ["own@fleet", path.join(dir, "max-2")]]);
    // The next assignment moves both: neither reads as its own choice again.
    expect((await digest({ includeOverrides: false, label: "max-3" })).rows.map((r) => [r.seat, r.effect])).toEqual([["mine@fleet", "change"], ["own@fleet", "change"]]);
  });

  it("without --include-overrides, a seat on the account by its own choice records no applied account and stays its own choice", async () => {
    seat("mine");
    db.prepare("UPDATE nodes SET claude_token_ref = ? WHERE id = 'mine'").run(JSON.stringify({ label: "max-2", tokenFile: path.join(dir, "max-2") }));
    const claude = stoppedClaude();
    const result = await svc.applyAssignment(request("max-2", await digestOf("max-2", claude)), { claudeSeat: claude });
    expect(result.ok && result.report.results.map((r) => [r.seat, r.kind])).toEqual([["mine@fleet", "unchanged"]]);
    expect(new ProviderAccountAssignmentsRepository(db).results("rig-fleet", "claude").map((r) => r.applied ?? null)).toEqual([null]);
    const next = await svc.assignmentPlan({ rig: "fleet", provider: "claude", label: "max-3", includeOverrides: false, daemon: "host-a" }, undefined, claude);
    expect(next.ok && next.plan.rows.map((r) => [r.seat, r.effect])).toEqual([["mine@fleet", "kept_override"]]);
  });

  it("an assignment set from a caller that isn't a seat says so, rather than naming nobody", async () => {
    seat("a");
    const claude = stoppedClaude();
    await svc.applyAssignment(request("max-2", await digestOf("max-2", claude), { requestedBy: null }), { claudeSeat: claude });
    expect(new ProviderAccountAssignmentsRepository(db).intent("rig-fleet", "claude")?.requestedBy).toBe("a caller that isn't a seat");
  });

  it("a seat an earlier assignment moved follows the rig's assignment; one that chose its own account is still an override", async () => {
    seat("a");
    const claude = stoppedClaude();
    expect((await svc.applyAssignment(request("max-2", await digestOf("max-2", claude)), { claudeSeat: claude })).ok).toBe(true);
    // c joins later with the same file, but chose it itself: no apply gave it.
    seat("c");
    db.prepare("UPDATE nodes SET claude_token_ref = ? WHERE id = 'c'").run(JSON.stringify({ label: "mine", tokenFile: path.join(dir, "max-2") }));
    const next = await svc.assignmentPlan({ rig: "fleet", provider: "claude", label: "max-3", includeOverrides: false, daemon: "host-a" }, undefined, claude);
    expect(next.ok && next.plan.rows.map((r) => [r.seat, r.effect])).toEqual([["a@fleet", "change"], ["c@fleet", "kept_override"]]);
  });

  it("refuses a plan that changed since it was shown, with nothing changed", async () => {
    seat("a"); seat("b");
    const claude = stoppedClaude();
    const digest = await digestOf("max-2", claude);
    db.prepare("UPDATE nodes SET claude_token_ref = ? WHERE id = 'b'").run(JSON.stringify({ label: "max-1", tokenFile: path.join(dir, "max-1") }));
    const before = everything();
    const result = await svc.applyAssignment(request("max-2", digest), { claudeSeat: claude });
    expect(result).toMatchObject({ ok: false, code: "plan_changed", digest: await digestOf("max-2", claude) });
    expect(result.ok || result.message).toContain(`since plan ${digest} was shown`);
    expect(everything()).toBe(before);
  });

  it("an apply where no seat took effect stores no assignment, keeps the rig's earlier one, and doesn't hold the label", async () => {
    seat("a");
    const claude = stoppedClaude();
    const uses = new ProviderAccountRefsRepository(db, { uses: accountRefUses(db) });
    // An API key outranks the token: the precheck is unsafe, so the seat isn't attempted.
    outranked = true;
    const refused = await svc.applyAssignment(request("max-3", await digestOf("max-3", claude)), { claudeSeat: claude });
    expect(refused.ok && refused.report.results.map((r) => r.kind)).toEqual(["failed_before_effect"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM provider_account_assignments").get()).toEqual({ n: 0 });
    expect(uses.remove("claude", "max-3")).toMatchObject({ ok: true });

    // With an earlier assignment in place, a refused apply leaves it as it was.
    outranked = false;
    expect((await svc.applyAssignment(request("max-2", await digestOf("max-2", claude)), { claudeSeat: claude })).ok).toBe(true);
    outranked = true;
    const again = await svc.applyAssignment(request("max-1", await digestOf("max-1", claude)), { claudeSeat: claude });
    expect(again.ok && again.report.results.map((r) => r.kind)).toEqual(["failed_before_effect"]);
    outranked = false;
    const planned = await svc.assignmentPlan({ rig: "fleet", provider: "claude", label: "max-2", includeOverrides: false, daemon: "host-a" }, undefined, claude);
    expect(planned.ok && planned.plan.intent?.label).toBe("max-2");
    expect(uses.remove("claude", "max-1")).toMatchObject({ ok: true });
  });

  it("applying the account a rig's seats are already on stores it and frees the old label; a kept override alone doesn't", async () => {
    seat("a");
    const claude = stoppedClaude();
    const uses = new ProviderAccountRefsRepository(db, { uses: accountRefUses(db) });
    expect((await svc.applyAssignment(request("max-1", await digestOf("max-1", claude)), { claudeSeat: claude })).ok).toBe(true);
    // Moved to max-2 by hand: max-1 is still the rig's assignment, so it can't be removed.
    db.prepare("UPDATE nodes SET claude_token_ref = ? WHERE id = 'a'").run(JSON.stringify({ label: "max-2", tokenFile: path.join(dir, "max-2") }));
    expect(uses.remove("claude", "max-1")).toMatchObject({ ok: false, code: "in_use" });
    // Applying max-3 with the seat kept as an override moves nothing: max-1 stays assigned.
    const kept = await svc.applyAssignment(request("max-3", await digestOf("max-3", claude)), { claudeSeat: claude });
    expect(kept.ok && kept.report.results.map((r) => r.kind)).toEqual(["unchanged"]);
    expect(uses.remove("claude", "max-3")).toMatchObject({ ok: true });
    expect(uses.remove("claude", "max-1")).toMatchObject({ ok: false, code: "in_use" });
    // Applying max-2, which the seat is already on, records it as the rig's assignment, and max-1 is free.
    const same = await svc.applyAssignment(request("max-2", await digestOf("max-2", claude)), { claudeSeat: claude });
    expect(same.ok && same.report.results.map((r) => [r.kind, r.detail])).toEqual([["unchanged", "already on max-2"]]);
    expect(uses.remove("claude", "max-1")).toMatchObject({ ok: true });
  });

  it("a second apply to the same rig while one runs is refused, with nothing changed", async () => {
    seat("a");
    let release!: () => void;
    const claude = stoppedClaude(new Promise<void>((r) => { release = r; }));
    const digest = await digestOf("max-2", claude);
    const first = svc.applyAssignment(request("max-2", digest), { claudeSeat: claude });
    await vi.waitFor(() => expect(claude.entered()).toBe(true));
    const before = everything();
    expect(await svc.applyAssignment(request("max-2", digest), { claudeSeat: claude })).toMatchObject({ ok: false, code: "apply_in_progress" });
    expect(everything()).toBe(before);
    release();
    expect((await first).ok).toBe(true);
    // Once it's done, the rig takes another apply.
    expect((await svc.applyAssignment(request("max-3", await digestOf("max-3", claude)), { claudeSeat: claude })).ok).toBe(true);
  });
});

describe("POST /api/provider/assignment-apply", () => {
  const app = () => {
    const a = new Hono();
    a.use("*", async (c, next) => { c.set("rigRepo" as never, new RigRepository(db)); c.set("providerService" as never, svc); await next(); });
    a.route("/api/provider", providerRoutes());
    return a;
  };
  const post = (body: unknown) => app().request("/api/provider/assignment-apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("refuses a malformed request (400), an unknown label (404), and a stale digest (409) with nothing changed", async () => {
    seat("a");
    expect((await post({ rig: "fleet", provider: "claude", account: "max-2" })).status).toBe(400);
    expect((await post({ rig: "fleet", provider: "claude", account: "max-2", plan: "not-a-digest" })).status).toBe(400);
    expect((await post({ rig: "fleet", provider: "claude", account: "max-2", plan: "0123456789ab", accountHome: "/h" })).status).toBe(400);
    expect((await post({ rig: "fleet", provider: "claude", account: "nope", plan: "0123456789ab" })).status).toBe(404);
    const before = everything();
    const stale = await post({ rig: "fleet", provider: "claude", account: "max-2", plan: "0123456789ab" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ ok: false, code: "plan_changed" });
    expect(everything()).toBe(before);
  });

  it("is 503 when the service can't apply", async () => {
    const a = new Hono();
    a.use("*", async (c, next) => { c.set("providerService" as never, { getReadModel: vi.fn(), precheck: vi.fn(), switchAccount: vi.fn() }); await next(); });
    a.route("/api/provider", providerRoutes());
    expect((await a.request("/api/provider/assignment-apply", { method: "POST", body: "{}" })).status).toBe(503);
  });
});
