import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { NativePermissionStore } from "../src/domain/native-permission-store.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeClaudePermission } from "../src/domain/permission-drift.js";
import { readClaudeAutoMode } from "../src/domain/claude-auto-mode.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { LegacyRigSpecCodec, RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { LegacyRigSpecSchema, RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { seatRoutes } from "../src/routes/seat.js";
import { createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

const block = {
  environment: ["$defaults", "Source control: github.com/acme; pushing issue branches and opening PRs is routine"],
  soft_deny: ["$defaults", "Never run migrations outside the migrations CLI"],
};

function fixture(migrations = ALL_MIGRATIONS) {
  const db = new Database(":memory:"); opened.push(db);
  migrate(db, migrations);
  const rigRepo = new RigRepository(db), rig = rigRepo.createRig("team");
  const a = rigRepo.addNode(rig.id, "dev.a", { runtime: "claude-code", cwd: "/same/project" });
  const b = rigRepo.addNode(rig.id, "dev.b", { runtime: "claude-code", cwd: "/same/project" });
  const codex = rigRepo.addNode(rig.id, "dev.c", { runtime: "codex", cwd: "/same/project" });
  const registry = new SessionRegistry(db), session = registry.registerSession(a.id, "dev-a@team");
  registry.updateStatus(session.id, "running");
  const eventBus = new EventBus(db);
  const tmux = new Proxy({}, { get: (_, key) => key === "deliveryGuard" ? undefined : () => { throw new Error("No native or lifecycle effect allowed"); } }) as TmuxAdapter;
  const service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux });
  return { db, rigRepo, registry, a, b, codex, service, eventBus };
}
const update = { seatRef: "dev-a@team", autoMode: block, actor: "operator@team", reason: "Trust the team's org" };
const histories = (db: Database.Database) => ["sessions", "bindings", "occupant_tenures", "node_permission_selections"]
  .map(table => db.prepare(`SELECT * FROM ${table}`).all());
const events = (db: Database.Database) => (db.prepare("SELECT payload FROM events WHERE type='node.claude_auto_mode_changed' ORDER BY seq").all() as { payload: string }[])
  .map(row => JSON.parse(row.payload));

describe("a seat's Claude autoMode block", () => {
  it("records an audited replacement for the next launch only, without touching the session, mode or sibling", async () => {
    const f = fixture(), before = histories(f.db);
    expect(await f.service.setPermissions(update)).toMatchObject({ ok: true, changed: true, from: null, to: block, advisories: [] });
    expect(histories(f.db)).toEqual(before);
    expect(readClaudeAutoMode(f.db, f.a.id)).toEqual(block);
    expect(readClaudeAutoMode(f.db, f.b.id)).toBeUndefined();
    expect(events(f.db)).toEqual([expect.objectContaining({ nodeId: f.a.id, from: null, to: block, actor: update.actor, reason: update.reason, effect: "future_launches_only" })]);
    const planned = new NativePermissionStore(f.db).launchOverride(f.a.id, "claude-code");
    expect(planned).toMatchObject({ claudeAutoMode: block, teamPermissionDefault: true });
    const settings = operationalLaunchArgs("claude-code", planned);
    expect(JSON.parse(settings[settings.indexOf("--settings") + 1]!).autoMode).toEqual(block);
    expect(await f.service.setPermissions(update)).toMatchObject({ ok: true, changed: false });
    expect(events(f.db)).toHaveLength(1);
  });

  it("clears the saved block and says user and managed settings are unaffected", async () => {
    const f = fixture();
    await f.service.setPermissions(update);
    const cleared = await f.service.setPermissions({ ...update, autoMode: null });
    expect(cleared).toMatchObject({ ok: true, changed: true, from: block, to: null });
    expect(JSON.stringify(cleared)).toMatch(/user and managed auto mode settings are unaffected/);
    expect(readClaudeAutoMode(f.db, f.a.id)).toBeUndefined();
    expect(new NativePermissionStore(f.db).launchOverride(f.a.id, "claude-code").claudeAutoMode).toBeUndefined();
    expect(events(f.db).at(-1)).toMatchObject({ from: block, to: null });
  });

  it("warns about a list without $defaults but records it as written", async () => {
    const f = fixture(), owned = { soft_deny: ["Only this rule"] };
    const result = await f.service.setPermissions({ ...update, autoMode: owned });
    expect(result).toMatchObject({ ok: true, to: owned });
    expect((result as { advisories: string[] }).advisories.join(" ")).toMatch(/soft_deny: without "\$defaults"/);
    expect(readClaudeAutoMode(f.db, f.a.id)).toEqual(owned);
  });

  it.each([
    [{ seatRef: "dev-c@team" }, /only supported for claude-code seats/],
    [{ autoMode: { deny: ["x"] } }, /claude_auto_mode\.deny: unsupported key/],
    [{ rules: { allow: [], deny: [] } }, /exactly one/],
  ])("refuses %j", async (change, message) => {
    const f = fixture();
    const result = await f.service.setPermissions({ ...update, ...change });
    expect(result).toMatchObject({ ok: false, code: "permission_selection_refused" });
    expect((result as { message: string }).message).toMatch(message);
  });

  it("rolls back an update when its audit can't be written", async () => {
    const f = fixture(); vi.spyOn(f.eventBus, "persistWithinTransaction").mockImplementation(() => { throw Error("audit unavailable"); });
    expect(await f.service.setPermissions(update)).toMatchObject({ ok: false });
    expect(readClaudeAutoMode(f.db, f.a.id)).toBeUndefined();
  });

  it("launches without a malformed record, says so, keeps the rest of status, and takes an audited repair", async () => {
    const f = fixture(); f.db.prepare("UPDATE nodes SET claude_auto_mode_json='broken' WHERE id=?").run(f.a.id);
    const override = new NativePermissionStore(f.db).launchOverride(f.a.id, "claude-code");
    expect(override.claudeAutoMode).toEqual({ unreadable: expect.stringMatching(new RegExp(`Seat ${f.a.id}.*don't send it.*--clear-auto-mode`)) });
    expect(operationalLaunchArgs("claude-code", override).join(" ")).not.toContain("autoMode");
    const status = new SeatStatusService({ rigRepo: f.rigRepo }).getStatus("dev-a@team") as { ok: true; status: { permissions: Record<string, unknown> & { claudeAutoMode?: Record<string, unknown> } } };
    expect(status.status.permissions).toMatchObject({ selectionState: "inherit", account: expect.any(Object), effective: expect.any(Object),
      claudeAutoMode: { saved: { state: "unavailable" }, matchesLastLaunch: null, plannedAutoMode: false } });
    expect(status.status.permissions).not.toHaveProperty("error");
    const exporter = new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: f.registry });
    expect(JSON.stringify(exporter.exportRig(f.a.rigId))).not.toContain("claudeAutoMode");
    expect(exporter.claudeAutoModeNotCarried(f.a.rigId)).toEqual([f.a.logicalId]);
    expect(await f.service.setPermissions(update)).toMatchObject({ ok: true, from: { state: "invalid", stored: "broken" } });
    expect(readClaudeAutoMode(f.db, f.a.id)).toEqual(block);
  });

  it("shows whether the next launch uses auto mode as unknown when the permission plan can't be read", async () => {
    const f = fixture(); await f.service.setPermissions(update);
    f.db.prepare("UPDATE nodes SET claude_permissions_json='broken' WHERE id=?").run(f.a.id);
    const status = new SeatStatusService({ rigRepo: f.rigRepo }).getStatus("dev-a@team") as { ok: true; status: { permissions: Record<string, unknown> & { claudeAutoMode?: Record<string, unknown> } } };
    expect(status.status.permissions).toMatchObject({ error: expect.stringContaining("claude_permissions"), claudeAutoMode: { saved: { state: "recorded" }, plannedAutoMode: null } });
    expect(status.status.permissions).not.toHaveProperty("account");
    const notes = (status.status.permissions.claudeAutoMode!["notes"] as string[]).join(" ");
    expect(notes).toContain("Whether the next launch uses auto mode: unknown");
    expect(notes).not.toMatch(/isn't planned in auto mode/);
  });

  it("stays dormant on another runtime and applies again on return to Claude", async () => {
    const f = fixture();
    await f.service.setPermissions(update);
    const exporter = new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: f.registry });
    f.db.prepare("UPDATE nodes SET runtime='codex' WHERE id=?").run(f.a.id);
    const store = new NativePermissionStore(f.db);
    expect(store.launchOverride(f.a.id, "codex").claudeAutoMode).toBeUndefined();
    expect(JSON.stringify(exporter.exportRig(f.a.rigId))).not.toContain("claudeAutoMode");
    f.db.prepare("UPDATE nodes SET runtime='claude-code' WHERE id=?").run(f.a.id);
    expect(store.launchOverride(f.a.id, "claude-code").claudeAutoMode).toEqual(block);
  });

  it("shows the saved block against the one the current occupant's launch composed", async () => {
    const f = fixture(), status = () => new SeatStatusService({ rigRepo: f.rigRepo }).getStatus("dev-a@team") as { ok: true; status: { permissions: { claudeAutoMode?: Record<string, unknown> } } };
    expect(status().status.permissions.claudeAutoMode).toBeUndefined();
    await f.service.setPermissions(update);
    expect(status().status.permissions.claudeAutoMode).toMatchObject({ saved: { state: "recorded", block }, lastLaunch: { state: "unknown" }, matchesLastLaunch: null });
    const launches = new AppliedLaunchObservationStore(f.db), generation = f.registry.currentOccupantTenure(f.a.id)!.generationUuid;
    launches.recordGeneration(generation, { ...observeClaudePermission("--permission-mode acceptEdits"), claudeAutoMode: null });
    const differs = status().status.permissions.claudeAutoMode!;
    expect(differs).toMatchObject({ lastLaunch: { state: "none" }, matchesLastLaunch: false });
    expect((differs["notes"] as string[]).join(" ")).toMatch(/applies at the next managed launch.*isn't planned in auto mode/);
    expect(differs["inspect"]).toMatch(/^claude --settings '.*' auto-mode config$/);
    launches.recordGeneration(generation, { ...observeClaudePermission("--permission-mode auto"), claudeAutoMode: block });
    expect(status().status.permissions.claudeAutoMode).toMatchObject({ lastLaunch: { state: "sent", block }, matchesLastLaunch: true });
    const reordered = Object.fromEntries(Object.entries(block).reverse());
    expect(Object.keys(reordered)).not.toEqual(Object.keys(block));
    launches.recordGeneration(generation, { ...observeClaudePermission("--permission-mode auto"), claudeAutoMode: reordered });
    expect(status().status.permissions.claudeAutoMode).toMatchObject({ matchesLastLaunch: true });
    const listReordered = { ...block, environment: [...block.environment!].reverse() };
    launches.recordGeneration(generation, { ...observeClaudePermission("--permission-mode auto"), claudeAutoMode: listReordered });
    expect(status().status.permissions.claudeAutoMode).toMatchObject({ matchesLastLaunch: false });
    await f.service.setPermissions({ ...update, autoMode: null });
    expect(status().status.permissions.claudeAutoMode).toMatchObject({ saved: { state: "none" }, matchesLastLaunch: false });
  });

  it("keeps a launch observation on a database without the applied column", () => {
    const f = fixture(ALL_MIGRATIONS.filter(m => m.name !== "171_claude_auto_mode.sql"));
    const generation = f.registry.currentOccupantTenure(f.a.id)!.generationUuid;
    const launches = new AppliedLaunchObservationStore(f.db);
    expect(launches.recordGeneration(generation, { ...observeClaudePermission("--permission-mode auto"), claudeAutoMode: block })).toBe(true);
    expect(launches.readCurrent(f.a.id)).toMatchObject({ value: "auto" });
    expect(launches.readCurrent(f.a.id)?.claudeAutoMode).toBeUndefined();
  });

  it("records the block as unknown, never an older one, when its write fails", () => {
    const f = fixture(), launches = new AppliedLaunchObservationStore(f.db), generation = f.registry.currentOccupantTenure(f.a.id)!.generationUuid;
    launches.recordGeneration(generation, { ...observeClaudePermission("--permission-mode auto"), claudeAutoMode: block });
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
      if (sql.startsWith("UPDATE applied_launch_observations SET claude_auto_mode_json")) throw new Error("database is locked");
      return prepare(sql);
    }) as typeof f.db.prepare);
    expect(launches.recordGeneration(generation, { ...observeClaudePermission("--permission-mode acceptEdits"), claudeAutoMode: null })).toBe(true);
    expect(launches.readCurrent(f.a.id)).toMatchObject({ value: "acceptEdits" });
    expect(launches.readCurrent(f.a.id)).not.toHaveProperty("claudeAutoMode");
  });

  it("shows a launch that read --settings from a file as unknown, even with no saved block", () => {
    const f = fixture(), status = () => new SeatStatusService({ rigRepo: f.rigRepo }).getStatus("dev-a@team") as { ok: true; status: { permissions: { claudeAutoMode?: Record<string, unknown> } } };
    const launches = new AppliedLaunchObservationStore(f.db), generation = f.registry.currentOccupantTenure(f.a.id)!.generationUuid;
    launches.recordGeneration(generation, { ...observeClaudePermission("--permission-mode auto"), claudeAutoMode: { unknown: "settings_file" } });
    expect(status().status.permissions.claudeAutoMode).toMatchObject({ saved: { state: "none" }, lastLaunch: { state: "unknown", reason: "settings_file" }, matchesLastLaunch: null });
    launches.recordGeneration(generation, { ...observeClaudePermission("--permission-mode auto"), claudeAutoMode: null });
    expect(status().status.permissions.claudeAutoMode).toBeUndefined();
  });

  it("replaces the applied block with each re-recorded observation of the generation", () => {
    const f = fixture(), launches = new AppliedLaunchObservationStore(f.db), generation = f.registry.currentOccupantTenure(f.a.id)!.generationUuid;
    launches.recordGeneration(generation, { ...observeClaudePermission("--permission-mode auto"), claudeAutoMode: block });
    expect(launches.readCurrent(f.a.id)).toMatchObject({ value: "auto", claudeAutoMode: block });
    launches.recordGeneration(generation, { ...observeClaudePermission("--permission-mode auto"), claudeAutoMode: null });
    expect(launches.readCurrent(f.a.id)?.claudeAutoMode).toBeNull();
  });

  it("takes the block over HTTP as autoMode, with null to clear, and audits the sender", async () => {
    const f = fixture(), app = new Hono();
    app.use("*", async (c, next) => {
      for (const [key, value] of Object.entries({ rigRepo: f.rigRepo, eventBus: f.eventBus, sessionRegistry: f.registry, tmuxAdapter: {} })) c.set(key as never, value as never);
      await next();
    });
    app.route("/api/seat", seatRoutes);
    const post = (body: unknown) => app.request("/api/seat/set-permissions/dev-a%40team", { method: "POST",
      headers: { "content-type": "application/json", "x-openrig-session": "actual@team" }, body: JSON.stringify(body) });
    expect((await post({ autoMode: block, reason: "set" })).status).toBe(200);
    expect(events(f.db).at(-1).actor).toBe("actual@team");
    expect((await post({ autoMode: null, reason: "clear" })).status).toBe(200);
    expect(readClaudeAutoMode(f.db, f.a.id)).toBeUndefined();
    expect((await post({ autoMode: block, rules: { allow: [], deny: [] }, reason: "both" })).status).toBe(400);
  });

  it("materializes an authored member block, reports its advisories, and exports the current record", async () => {
    const f = fixture();
    const setup = createTestApp(f.db, { podInstantiatorFsOps: {
      readFile: () => 'name: reader\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []', exists: () => true,
    } });
    const raw = { version: "0.2", name: "authored", pods: [{ id: "dev", label: "Dev", members: [
      { id: "reader", agent_ref: "local:reader.agent.yaml", profile: "default", runtime: "claude-code", cwd: "/same/project", claude_auto_mode: { ...block, allow: ["Bash(git push *)"] } },
    ], edges: [] }], edges: [] };
    const validation = RigSpecSchema.validate(raw);
    expect(validation.valid).toBe(true);
    expect(validation.advisories?.join(" ")).toMatch(/pods\[0\]\.members\[0\]\.claude_auto_mode\.allow: without "\$defaults"/);
    expect(validation.advisories?.join(" ")).toMatch(/claude_auto_mode\.allow\[0\]: .*claude_permissions/);
    const result = await setup.podInstantiator.materializeStructured(raw, "/project");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const node = setup.rigRepo.getRig(result.result.rigId)!.nodes[0]!;
    expect(readClaudeAutoMode(f.db, node.id)).toEqual(raw.pods[0]!.members[0]!.claude_auto_mode);
    f.db.prepare("UPDATE nodes SET claude_auto_mode_json=? WHERE id=?").run(JSON.stringify(block), node.id);
    const exported = new RigSpecExporter({ rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry, podRepo: new PodRepository(f.db) }).exportRig(result.result.rigId);
    const parsed = RigSpecCodec.parse(RigSpecCodec.serialize(exported as import("../src/domain/types.js").RigSpec));
    expect(RigSpecSchema.normalize(parsed).pods[0]!.members[0]!.claudeAutoMode).toEqual(block);
    const wrongRuntime = structuredClone(raw); wrongRuntime.pods[0]!.members[0]!.runtime = "codex";
    expect(RigSpecSchema.validate(wrongRuntime).errors.join(" ")).toContain("claude_auto_mode: only valid when runtime is \"claude-code\"");
  });

  it("round-trips the block on legacy flat seats", () => {
    const f = fixture();
    f.db.prepare("UPDATE nodes SET claude_auto_mode_json=? WHERE id=?").run(JSON.stringify(block), f.a.id);
    const exported = new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: f.registry }).exportRig(f.a.rigId);
    const parsed = LegacyRigSpecCodec.parse(LegacyRigSpecCodec.serialize(exported as import("../src/domain/types.js").LegacyRigSpec));
    expect(LegacyRigSpecSchema.normalize(parsed).nodes.find(n => n.id === "dev.a")!.claudeAutoMode).toEqual(block);
  });
});
