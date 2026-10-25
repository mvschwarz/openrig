import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { Hono } from "hono";
import { seatRoutes } from "../src/routes/seat.js";
import { createTestApp } from "./helpers/test-app.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigSpecCodec, LegacyRigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { readClaudePermissionRules, validateClaudePermissionRules } from "../src/domain/claude-permission-rules.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
const rules = { allow: ["Bash(node lane.mjs *)"], deny: ["Read(./private/**)"] };
function fixture(withMigration = true) {
  const db = new Database(":memory:"); opened.push(db);
  migrate(db, withMigration ? ALL_MIGRATIONS : ALL_MIGRATIONS.filter(m => m.name !== "139_node_claude_permissions.sql"));
  const rigRepo = new RigRepository(db), rig = rigRepo.createRig("rules");
  const a = rigRepo.addNode(rig.id, "dev.a", { runtime: "claude-code", cwd: "/same/project" });
  const b = rigRepo.addNode(rig.id, "dev.b", { runtime: "claude-code", cwd: "/same/project" });
  const registry = new SessionRegistry(db), session = registry.registerSession(a.id, "dev-a@rules");
  registry.updateStatus(session.id, "running"); registry.updateResumeToken(session.id, "native-id", "history-kept", "hook");
  const eventBus = new EventBus(db);
  const tmux = new Proxy({}, { get: (_, key) => key === "deliveryGuard" ? undefined : () => { throw new Error("No native or lifecycle effect allowed"); } }) as TmuxAdapter;
  const service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux });
  return { db, rigRepo, a, b, service, eventBus };
}
const update = { seatRef: "dev-a@rules", rules, actor: "operator@rules", reason: "Select this lane" };
const histories = (db: Database.Database) => ["sessions", "bindings", "occupant_tenures", "node_permission_selections"]
  .map(table => db.prepare(`SELECT * FROM ${table}`).all());

describe("current member Claude rules (offline, no native enforcement claim)", () => {
  it("audits a retained same-cwd seat update without changing its live session or sibling", async () => {
    const f = fixture(), before = histories(f.db);
    expect(await f.service.setPermissions(update)).toMatchObject({ ok: true, changed: true, to: rules });
    expect(histories(f.db)).toEqual(before);
    expect(readClaudePermissionRules(f.db, f.a.id)).toEqual(rules);
    expect(readClaudePermissionRules(f.db, f.b.id)).toBeUndefined();
    const event = f.db.prepare("SELECT payload FROM events WHERE type='node.permission_rules_changed'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ nodeId: f.a.id, actor: update.actor, reason: update.reason, from: null, to: rules, effect: "future_launches_only" });
    const store = new NativePermissionStore(f.db), planned = store.launchOverride(f.a.id, "claude-code");
    expect(planned.teamPermissionDefault).toBe(true);
    expect(planned.claudePermissions).toEqual(rules);
    expect(new SeatStatusService({ rigRepo: f.rigRepo }).getStatus(update.seatRef)).toMatchObject({ ok: true, status: {
      permissions: { nativeEffect: "unverified", account: { basis: "planned", openRigAdds: { claudeDeny: rules.deny } } },
    } });
    expect(operationalLaunchArgs("claude-code", planned).filter(arg => arg === "--settings")).toHaveLength(1);
    expect(await f.service.setPermissions({ ...update, rules: { allow: [], deny: [] } })).toMatchObject({ ok: true, changed: true });
    expect(store.launchOverride(f.a.id, "claude-code").claudePermissions).toEqual({ allow: [], deny: [] });
  });

  it.each([false, true])("keeps Claude rules dormant through a different runtime and restores them on return (pods=%s)", async podAware => {
    const f = fixture();
    expect(await f.service.setPermissions(update)).toMatchObject({ ok: true });
    const podRepo = new PodRepository(f.db);
    if (podAware) {
      const pod = podRepo.createPod(f.a.rigId, "dev", "Dev");
      f.db.prepare("UPDATE nodes SET pod_id=? WHERE rig_id=?").run(pod.id, f.a.rigId);
    }
    const exporter = new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: new SessionRegistry(f.db), ...(podAware ? { podRepo } : {}) });
    const stored = () => (f.db.prepare("SELECT claude_permissions_json v FROM nodes WHERE id=?").get(f.a.id) as { v: string }).v;
    const before = stored();
    // Simulate the separately implemented runtime switch's persisted commit.
    f.db.prepare("UPDATE nodes SET runtime='codex' WHERE id=?").run(f.a.id);
    expect(JSON.stringify(exporter.exportRig(f.a.rigId))).not.toContain("claudePermissions");
    const store = new NativePermissionStore(f.db), codex = store.launchOverride(f.a.id, "codex");
    expect(codex.claudePermissions).toBeUndefined();
    expect(operationalLaunchArgs("codex", codex).join(" ")).not.toContain(rules.deny[0]);
    // A switch back plans Claude's launch before committing its runtime column.
    expect(store.launchOverride(f.a.id, "claude-code").claudePermissions).toEqual(rules);
    f.db.prepare("UPDATE nodes SET runtime='claude-code' WHERE id=?").run(f.a.id);
    expect(store.launchOverride(f.a.id, "claude-code").claudePermissions).toEqual(rules);
    expect(JSON.stringify(exporter.exportRig(f.a.rigId))).toContain(JSON.stringify(rules));
    expect(stored()).toBe(before);
  });

  it("plans a target runtime with its own mode/profile while preserving dormant Claude rules", async () => {
    const f = fixture();
    expect(await f.service.setPermissions(update)).toMatchObject({ ok: true });
    const store = new NativePermissionStore(f.db);
    store.write(f.a.id, { runtime: "claude-code", mode: "auto" }, "operator", "prior mode");
    const codex = store.launchOverride(f.a.id, "codex", {
      selection: { runtime: "codex", mode: "floor" }, codexProfile: "target-profile",
    });
    expect(codex).toMatchObject({ launchPosture: "floor", teamPermissionDefault: false });
    expect(codex.claudePermissions).toBeUndefined();
    // A target profile also wins when the switch inherits rather than selects a mode.
    expect(store.launchOverride(f.a.id, "codex", { selection: null, codexProfile: "target-profile" }).teamPermissionDefault).toBe(false);
    f.db.prepare("UPDATE nodes SET runtime='codex' WHERE id=?").run(f.a.id);
    store.write(f.a.id, { runtime: "codex", mode: "floor" }, "operator", "prior Codex mode");
    expect(store.launchOverride(f.a.id, "claude-code", {
      selection: { runtime: "claude-code", mode: "acceptEdits" }, codexProfile: null,
    })).toMatchObject({ permissionMode: "acceptEdits", claudePermissions: rules });
    expect(readClaudePermissionRules(f.db, f.a.id)).toEqual(rules);
  });

  it("rolls back an update when its audit cannot be persisted", async () => {
    const f = fixture(); vi.spyOn(f.eventBus, "persistWithinTransaction").mockImplementation(() => { throw Error("audit unavailable"); });
    expect(await f.service.setPermissions(update)).toMatchObject({ ok: false });
    expect(readClaudePermissionRules(f.db, f.a.id)).toBeUndefined();
  });

  it("refuses a malformed recorded deny instead of launching more broadly, and allows an audited repair", async () => {
    const f = fixture(); f.db.prepare("UPDATE nodes SET claude_permissions_json='broken' WHERE id=?").run(f.a.id);
    expect(() => new NativePermissionStore(f.db).launchOverride(f.a.id, "claude-code")).toThrow(new RegExp(`Seat ${f.a.id}.*Repair`));
    expect(await f.service.setPermissions(update)).toMatchObject({ ok: true });
    expect(readClaudePermissionRules(f.db, f.a.id)).toEqual(rules);
  });

  it("does not start a Claude process when its recorded rules are unreadable", async () => {
    const f = fixture();
    f.db.prepare("UPDATE nodes SET claude_permissions_json='broken' WHERE id=?").run(f.a.id);
    const project = vi.fn(), launchHarness = vi.fn();
    const registry = new SessionRegistry(f.db), session = registry.getSessionsForRig(f.a.rigId)[0]!;
    const result = await new StartupOrchestrator({ db: f.db, sessionRegistry: registry, eventBus: f.eventBus, tmuxAdapter: {} as TmuxAdapter }).startNode({
      rigId: f.a.rigId, nodeId: f.a.id, sessionId: session.id,
      binding: { nodeId: f.a.id, tmuxSession: "dev-a@rules" } as never,
      adapter: { runtime: "claude-code", project, launchHarness } as never,
      plan: { entries: [] } as never, resolvedStartupFiles: [], startupActions: [],
    });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("Repair the rules");
    expect(project).not.toHaveBeenCalled(); expect(launchHarness).not.toHaveBeenCalled();
  });

  it("keeps older/default records unchanged and never leaves a new node without required rules", () => {
    const f = fixture(false);
    expect(new NativePermissionStore(f.db).launchOverride(f.a.id, "claude-code")).toMatchObject({ teamPermissionDefault: true });
    expect(() => f.rigRepo.addNode(f.a.rigId, "dev.new", { runtime: "claude-code", claudePermissions: rules })).toThrow();
    expect(f.db.prepare("SELECT id FROM nodes WHERE logical_id='dev.new'").get()).toBeUndefined();
  });

  it("uses the existing HTTP authority and audits the sender instead of a supplied operator", async () => {
    const f = fixture(), app = new Hono();
    app.use("*", async (c, next) => {
      for (const [key, value] of Object.entries({ rigRepo: f.rigRepo, eventBus: f.eventBus, sessionRegistry: new SessionRegistry(f.db), tmuxAdapter: {} })) c.set(key as never, value as never);
      await next();
    });
    app.route("/api/seat", seatRoutes);
    const response = await app.request("/api/seat/set-permissions/dev-a%40rules", { method: "POST",
      headers: { "content-type": "application/json", "x-openrig-session": "actual@rules" },
      body: JSON.stringify({ rules, reason: "Change this lane", operator: "ignored@rules" }) });
    expect(response.status).toBe(200);
    expect(JSON.parse((f.db.prepare("SELECT payload FROM events WHERE type='node.permission_rules_changed'").get() as { payload: string }).payload).actor).toBe("actual@rules");
    const ambiguous = await app.request("/api/seat/set-permissions/dev-a%40rules", { method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "actual@rules" },
      body: JSON.stringify({ rules, mode: "full_bypass", reason: "not a rules-only update" }) });
    expect(ambiguous.status).toBe(400);
  });

  it("materializes authored member rules and exports the current seat record, not the old spec", async () => {
    const f = fixture();
    const setup = createTestApp(f.db, { podInstantiatorFsOps: {
      readFile: () => 'name: reader\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []', exists: () => true,
    } });
    const raw = { version: "0.2", name: "authored", pods: [{ id: "dev", label: "Dev", members: [
      { id: "reader", agent_ref: "local:reader.agent.yaml", profile: "default", runtime: "claude-code", cwd: "/same/project", claude_permissions: rules },
    ], edges: [] }], edges: [] };
    expect(RigSpecSchema.validate(raw).valid).toBe(true);
    const result = await setup.podInstantiator.materializeStructured(raw, "/project");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const node = setup.rigRepo.getRig(result.result.rigId)!.nodes[0]!;
    expect(readClaudePermissionRules(f.db, node.id)).toEqual(rules);
    const changed = { allow: [], deny: ["Read(./other/**)"] };
    f.db.prepare("UPDATE nodes SET claude_permissions_json=? WHERE id=?").run(JSON.stringify(changed), node.id);
    const exported = new RigSpecExporter({ rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry, podRepo: new PodRepository(f.db) }).exportRig(result.result.rigId);
    const parsed = RigSpecCodec.parse(RigSpecCodec.serialize(exported as import("../src/domain/types.js").RigSpec));
    expect(RigSpecSchema.normalize(parsed).pods[0]!.members[0]!.claudePermissions).toEqual(changed);
    const wrongRuntime = structuredClone(raw); wrongRuntime.pods[0]!.members[0]!.runtime = "codex";
    expect(RigSpecSchema.validate(wrongRuntime).errors.join(" ")).toContain("claude_permissions");
  });

  it("round-trips rules on legacy flat seats without silently discarding a declaration", () => {
    const f = fixture();
    f.db.prepare("UPDATE nodes SET claude_permissions_json=? WHERE id=?").run(JSON.stringify(rules), f.a.id);
    const exported = new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: new SessionRegistry(f.db) }).exportRig(f.a.rigId);
    const parsed = LegacyRigSpecCodec.parse(LegacyRigSpecCodec.serialize(exported as import("../src/domain/types.js").LegacyRigSpec));
    expect(LegacyRigSpecSchema.normalize(parsed).nodes[0]!.claudePermissions).toEqual(rules);
  });

  it.each([null, { ask: ["Bash"] }, { deny: ["mcp__server__tool(argument)"] }, { deny: ["Read\nWrite"] }, { allow: [""] }, { deny: "Read" }, { defaultMode: "bypassPermissions" }])("names invalid explicit input: %j", value => {
    expect(() => validateClaudePermissionRules(value)).toThrow(/claude_permissions/);
  });
});
