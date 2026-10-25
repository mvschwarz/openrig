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
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigSpecCodec, LegacyRigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema, LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import { codexEnvelopeArgs } from "../src/domain/codex-rebuild-permissions.js";
import { clearCodexMemberPermissions, codexMemberEnvelope, readCodexMemberPermissions, readProfileFingerprint, validateCodexMemberPermissions,
  type CodexMemberPermissions, type CodexProfileObservation } from "../src/domain/codex-member-permissions.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { seatRoutes } from "../src/routes/seat.js";
import { createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

// A Codex seat's own permission envelope and profile: one current record, the audited setter, and the live read every
// launch path uses. Offline: these show the record and the planned flags, not native enforcement.

const opened: Database.Database[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); vi.unstubAllEnvs(); });

const lease: CodexMemberPermissions = { sandbox: "workspace-write", approval: "never", network_access: false,
  writable_roots: ["/lease/a"], exclude_tmpdir_env_var: false, exclude_slash_tmp: false };
const reader: CodexMemberPermissions = { sandbox: "read-only", approval: "on-request" };

function fixture(observeProfile?: (profile: string, cwd: string, nodeId: string) => Promise<CodexProfileObservation>) {
  const db = new Database(":memory:"); opened.push(db);
  migrate(db, ALL_MIGRATIONS);
  const rigRepo = new RigRepository(db), rig = rigRepo.createRig("codex-team");
  const a = rigRepo.addNode(rig.id, "dev.a", { runtime: "codex", cwd: "/same/project" });
  const b = rigRepo.addNode(rig.id, "dev.b", { runtime: "codex", cwd: "/same/project" });
  const registry = new SessionRegistry(db), session = registry.registerSession(a.id, "dev-a@codex-team");
  registry.updateStatus(session.id, "running");
  registry.registerSession(b.id, "dev-b@codex-team");
  const eventBus = new EventBus(db);
  const tmux = new Proxy({}, { get: (_, key) => key === "deliveryGuard" ? undefined : () => { throw new Error("No native or lifecycle effect allowed"); } }) as TmuxAdapter;
  const runtimeAdapters = observeProfile ? { codex: { runtime: "codex", observeProfile } as unknown as RuntimeAdapter } : undefined;
  const service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux, ...(runtimeAdapters ? { runtimeAdapters } : {}) });
  return { db, rigRepo, rig, a, b, service, eventBus };
}
const set = (codexPermissions: unknown) => ({ seatRef: "dev-a@codex-team", codexPermissions, actor: "operator@codex-team", reason: "Narrow this lane" });
const events = (db: Database.Database, type: string) =>
  (db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq").all(type) as { payload: string }[]).map(row => JSON.parse(row.payload));
const observation = (over: Partial<CodexProfileObservation> = {}): CodexProfileObservation => ({ vantage: "configured_codex_home", home: "/codex-home",
  file: "present", sha256: "a".repeat(64), load: "ok", detail: "/codex-home/lease.config.toml loads.", observedAt: "2026-10-24T09:00:00.000Z", ...over });

describe("the typed Codex envelope", () => {
  it("normalizes workspace-write so every field the emitter sets is explicit", () => {
    expect(validateCodexMemberPermissions({ sandbox: "workspace-write", approval: "untrusted" })).toEqual({ sandbox: "workspace-write",
      approval: "untrusted", network_access: false, writable_roots: [], exclude_tmpdir_env_var: false, exclude_slash_tmp: false });
    const args = codexEnvelopeArgs(codexMemberEnvelope({ ...lease, network_access: true, exclude_slash_tmp: true }));
    expect(args).toContain(" -s workspace-write -a never");
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    expect(args).toContain("sandbox_workspace_write.exclude_tmpdir_env_var=false");
    expect(args).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(args).toContain('sandbox_workspace_write.writable_roots=["/lease/a"]');
    expect(codexEnvelopeArgs(codexMemberEnvelope(reader))).toBe(" -s read-only -a on-request");
  });

  it.each([
    [null, /mapping/], [{ approval: "never" }, /sandbox/], [{ sandbox: "danger-full-access", approval: "never" }, /full_bypass/],
    [{ sandbox: "workspace-write", approval: "always" }, /approval/], [{ sandbox: "read-only", approval: "never", network_access: false }, /workspace-write/],
    [{ sandbox: "workspace-write", approval: "never", writable_roots: ["relative/root"] }, /absolute/],
    [{ sandbox: "workspace-write", approval: "never", writable_roots: ["/a\nb"] }, /absolute/],
    [{ sandbox: "workspace-write", approval: "never", network_access: "yes" }, /true or false/],
    [{ sandbox: "workspace-write", approval: "never", profile: "x" }, /unsupported key/],
  ])("names invalid input: %j", (value, message) => {
    expect(() => validateCodexMemberPermissions(value)).toThrow(message);
  });
});

describe("a Codex seat's current envelope (offline, no native enforcement claim)", () => {
  it("gives two seats in one folder their own envelopes, as the seat's explicit choice", async () => {
    const f = fixture();
    expect(new NativePermissionStore(f.db).launchOverride(f.a.id, "codex")).toMatchObject({ teamPermissionDefault: true });
    expect(await f.service.setPermissions(set(lease))).toMatchObject({ ok: true, changed: true, from: null, to: lease });
    expect(await f.service.setPermissions({ ...set(reader), seatRef: "dev-b@codex-team" })).toMatchObject({ ok: true, to: reader });
    const store = new NativePermissionStore(f.db);
    expect(store.launchOverride(f.a.id, "codex")).toEqual({ codexPermissions: lease, kernelAuthority: false, teamPermissionDefault: false });
    expect(store.launchOverride(f.b.id, "codex")).toEqual({ codexPermissions: reader, kernelAuthority: false, teamPermissionDefault: false });
    expect(events(f.db, "node.codex_permissions_changed")[0]).toMatchObject({ nodeId: f.a.id, from: null, to: lease,
      actor: "operator@codex-team", reason: "Narrow this lane", effect: "future_launches_only" });
    expect(await f.service.setPermissions(set(lease))).toMatchObject({ ok: true, changed: false });
  });

  it("replaces a recorded mode in one audited write, and a mode replaces the envelope the same way", async () => {
    const f = fixture();
    expect(await f.service.setPermissions({ seatRef: "dev-a@codex-team", mode: "full_bypass", actor: "operator@codex-team", reason: "Full access" })).toMatchObject({ ok: true });
    expect(await f.service.setPermissions(set(lease))).toMatchObject({ ok: true, changed: true, replaced: { mode: { mode: "full_bypass" } } });
    const store = new NativePermissionStore(f.db);
    expect(store.read(f.a.id)).toBeNull();
    expect(events(f.db, "node.codex_permissions_changed").at(-1)).toMatchObject({ replaced: { mode: { mode: "full_bypass" } }, to: lease });

    const back = await f.service.setPermissions({ seatRef: "dev-a@codex-team", mode: "floor", actor: "operator@codex-team", reason: "Back to the floor" });
    expect(back).toMatchObject({ ok: true, changed: true, replaced: { codexPermissions: lease } });
    expect(JSON.stringify(back)).toContain("replaces the seat's Codex permission envelope");
    expect(readCodexMemberPermissions(f.db, f.a.id)).toBeUndefined();
    expect(store.read(f.a.id)).toMatchObject({ mode: "floor" });
    expect(events(f.db, "node.permissions_changed").at(-1)).toMatchObject({ to: { mode: "floor" }, replaced: { codexPermissions: lease } });

    await f.service.setPermissions(set(lease));
    expect(await f.service.setPermissions({ seatRef: "dev-a@codex-team", mode: "inherit", actor: "operator@codex-team", reason: "Clear" }))
      .toMatchObject({ ok: true, replaced: { codexPermissions: lease } });
    expect(readCodexMemberPermissions(f.db, f.a.id)).toBeUndefined();
    expect(store.read(f.a.id)).toBeNull();
  });

  it("keeps the previous record on invalid input, rolls back without its audit, and refuses non-Codex seats", async () => {
    const f = fixture();
    await f.service.setPermissions(set(lease));
    expect(await f.service.setPermissions(set({ sandbox: "danger-full-access", approval: "never" }))).toMatchObject({ ok: false, message: expect.stringMatching(/full_bypass/) });
    expect(readCodexMemberPermissions(f.db, f.a.id)).toEqual(lease);
    vi.spyOn(f.eventBus, "persistWithinTransaction").mockImplementation(() => { throw Error("audit unavailable"); });
    expect(await f.service.setPermissions(set(reader))).toMatchObject({ ok: false });
    expect(readCodexMemberPermissions(f.db, f.a.id)).toEqual(lease);
    f.db.prepare("UPDATE nodes SET runtime = 'claude-code' WHERE id = ?").run(f.a.id);
    expect(await fixtureLess(f).setPermissions(set(lease))).toMatchObject({ ok: false });
  });

  it("refuses a seat whose envelope can't be read, or that also records a mode, rather than launching broader", async () => {
    const f = fixture();
    f.db.prepare("UPDATE nodes SET codex_permissions_json = 'broken' WHERE id = ?").run(f.a.id);
    expect(() => new NativePermissionStore(f.db).launchOverride(f.a.id, "codex")).toThrow(/cannot read codex_permissions.*Repair/);
    expect(await f.service.setPermissions(set(lease))).toMatchObject({ ok: true, from: { state: "invalid", stored: "broken" } });
    // Another writer (an older OpenRig) recorded a mode beside the envelope: neither is guessed.
    f.db.prepare("INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at) VALUES (?, 'codex', 'full_bypass', 'old', 'old', datetime('now'))").run(f.a.id);
    expect(() => new NativePermissionStore(f.db).launchOverride(f.a.id, "codex")).toThrow(/both a Codex permission envelope and the full_bypass mode/);
  });

  it("stays with the seat across a runtime switch, as Claude rules do, until the switch's explicit mode replaces it", async () => {
    const f = fixture();
    await f.service.setPermissions(set(lease));
    const store = new NativePermissionStore(f.db);
    // Leaving Codex: the envelope isn't the target runtime's.
    expect(store.launchOverride(f.a.id, "claude-code", { selection: null, codexProfile: null })).not.toHaveProperty("codexPermissions");
    // Back to Codex, inheriting policy: the seat's envelope applies again.
    expect(store.launchOverride(f.a.id, "codex", { selection: null, codexProfile: null }))
      .toEqual({ codexPermissions: lease, kernelAuthority: false, teamPermissionDefault: false });
    // A switch that selects a mode replaces the envelope: that launch uses the mode (the switch's commit clears the envelope),
    // even when the stored envelope is unreadable.
    const replacing = { selection: { runtime: "codex", mode: "full_bypass" } as never, codexProfile: null };
    expect(store.launchOverride(f.a.id, "codex", replacing)).toEqual({ kernelAuthority: false, teamPermissionDefault: false, launchPosture: "full_bypass" });
    f.db.prepare("UPDATE nodes SET codex_permissions_json = 'broken' WHERE id = ?").run(f.a.id);
    expect(store.launchOverride(f.a.id, "codex", replacing)).toMatchObject({ launchPosture: "full_bypass" });
    expect(() => store.launchOverride(f.a.id, "codex", { selection: null, codexProfile: null })).toThrow(/cannot read codex_permissions/);
  });

  it("clears an envelope only after reading it: a schema without the column has none, and any other read error propagates", () => {
    const f = fixture();
    f.db.prepare("UPDATE nodes SET codex_permissions_json = ? WHERE id = ?").run(JSON.stringify(reader), f.a.id);
    expect(clearCodexMemberPermissions(f.db, f.a.id)).toEqual(reader);
    expect(readCodexMemberPermissions(f.db, f.a.id)).toBeUndefined();
    // Malformed bytes are still replaced, and returned as such for the audit.
    f.db.prepare("UPDATE nodes SET codex_permissions_json = 'broken' WHERE id = ?").run(f.a.id);
    expect(clearCodexMemberPermissions(f.db, f.a.id)).toEqual({ state: "invalid", stored: "broken" });
    const bare = new Database(":memory:"); opened.push(bare);
    bare.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY)"); bare.prepare("INSERT INTO nodes (id) VALUES ('n')").run();
    expect(clearCodexMemberPermissions(bare, "n")).toBeUndefined();
    const failing = { prepare: () => { throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }); } } as unknown as Database.Database;
    expect(() => clearCodexMemberPermissions(failing, "n")).toThrow("disk I/O error");
  });

  it("plans the envelope's flags in status, naming the posture it replaces and OpenRig's additions", async () => {
    const f = fixture();
    f.db.prepare("UPDATE nodes SET permission_policy = 'builtin:yolo', policy_origin = 'builtin', policy_launch_posture = 'full_bypass' WHERE id = ?").run(f.a.id);
    vi.stubEnv("OPENRIG_YOLO", "1");
    await f.service.setPermissions(set(lease));
    const status = new SeatStatusService({ rigRepo: f.rigRepo }).getStatus("dev-a@codex-team") as { ok: true; status: { permissions: { account: Record<string, unknown> } } };
    const account = status.status.permissions.account as { summary: string; nativeArgument: string; openRigAdds: { notes: string[] }; controls: string[] };
    expect(account.nativeArgument).toContain("-s workspace-write -a never");
    expect(account.nativeArgument).not.toContain("danger-full-access");
    expect(account.summary).toContain("this seat's own permission envelope");
    expect(account.summary).toContain("the envelope replaces the policy's full_bypass posture and the ambient OPENRIG_YOLO setting");
    expect(account.openRigAdds.notes.join(" ")).toContain("Network access off, as the envelope states");
    expect(account.controls.join(" ")).toContain("--codex-permissions <file.json>");
  });

  it("accepts the envelope through the existing HTTP authority and refuses two choices at once", async () => {
    const f = fixture(), app = new Hono();
    app.use("*", async (c, next) => {
      for (const [key, value] of Object.entries({ rigRepo: f.rigRepo, eventBus: f.eventBus, sessionRegistry: new SessionRegistry(f.db), tmuxAdapter: {} })) c.set(key as never, value as never);
      await next();
    });
    app.route("/api/seat", seatRoutes);
    const post = (body: unknown) => app.request("/api/seat/set-permissions/dev-a%40codex-team", { method: "POST",
      headers: { "content-type": "application/json", "x-openrig-session": "actual@codex-team" }, body: JSON.stringify(body) });
    expect((await post({ codexPermissions: lease, reason: "Narrow" })).status).toBe(200);
    expect(events(f.db, "node.codex_permissions_changed")[0].actor).toBe("actual@codex-team");
    expect((await post({ codexPermissions: lease, mode: "floor", reason: "both" })).status).toBe(400);
    expect((await post({ codexProfile: "lease", codexPermissions: lease, reason: "both" })).status).toBe(400);
  });
});

describe("a Codex seat's current profile", () => {
  it("records a profile with what the setter saw in the seat's config home, and inherit clears it", async () => {
    const observe = vi.fn(async () => observation());
    const f = fixture(observe);
    const result = await f.service.setPermissions({ seatRef: "dev-a@codex-team", codexProfile: "lease", actor: "operator@codex-team", reason: "Use the lease profile" });
    expect(result).toMatchObject({ ok: true, changed: true, from: null, to: "lease", observation: { file: "present", load: "ok" } });
    expect(observe).toHaveBeenCalledWith("lease", "/same/project", f.a.id);
    expect(f.rigRepo.getRig(f.rig.id)!.nodes.find(n => n.id === f.a.id)!.codexConfigProfile).toBe("lease");
    expect(events(f.db, "node.codex_profile_changed")[0]).toMatchObject({ from: null, to: "lease", observation: { sha256: "a".repeat(64) } });
    // Profile and approval are separate: the profile doesn't touch the envelope or mode.
    expect(new NativePermissionStore(f.db).read(f.a.id)).toBeNull();
    expect(readCodexMemberPermissions(f.db, f.a.id)).toBeUndefined();
    expect(await f.service.setPermissions({ seatRef: "dev-a@codex-team", codexProfile: "inherit", actor: "operator@codex-team", reason: "Clear" }))
      .toMatchObject({ ok: true, changed: true, from: "lease", to: null });
    expect(f.db.prepare("SELECT codex_config_profile p FROM nodes WHERE id = ?").get(f.a.id)).toEqual({ p: null });
  });

  it("reports an absent or changed file without refusing, and an unestablished home as unverified", async () => {
    const observe = vi.fn(async () => observation({ file: "absent", sha256: undefined, detail: "absent; base config applies" }));
    const f = fixture(observe);
    const reset = { seatRef: "dev-a@codex-team", codexProfile: "lease", actor: "operator@codex-team", reason: "Check again" };
    expect(await f.service.setPermissions(reset)).toMatchObject({ ok: true, observation: { file: "absent" } });
    observe.mockResolvedValueOnce(observation());
    expect(await f.service.setPermissions(reset)).toMatchObject({ ok: true, changed: false, observation: { file: "present", changedSinceRecorded: true } });
    observe.mockResolvedValueOnce(observation());
    expect(await f.service.setPermissions(reset)).toMatchObject({ ok: true, observation: { file: "present" } });
    expect(JSON.stringify(events(f.db, "node.codex_profile_changed").at(-1))).not.toContain("changedSinceRecorded");
    observe.mockResolvedValueOnce(observation({ vantage: "unestablished", home: null, file: "unverified", sha256: undefined, load: "not_run" }));
    expect(await f.service.setPermissions(reset)).toMatchObject({ ok: true, observation: { vantage: "unestablished", file: "unverified" } });
  });

  it("refuses a profile that fails to load and keeps the previous one", async () => {
    const observe = vi.fn(async () => observation());
    const f = fixture(observe);
    await f.service.setPermissions({ seatRef: "dev-a@codex-team", codexProfile: "lease", actor: "operator@codex-team", reason: "Use it" });
    observe.mockResolvedValueOnce(observation({ load: "failed", detail: "Codex profile 'broken' failed to load: invalid TOML\n  Fix: check the TOML" }));
    expect(await f.service.setPermissions({ seatRef: "dev-a@codex-team", codexProfile: "broken", actor: "operator@codex-team", reason: "Try it" }))
      .toMatchObject({ ok: false, message: expect.stringMatching(/failed to load.*Fix/s) });
    expect(f.db.prepare("SELECT codex_config_profile p FROM nodes WHERE id = ?").get(f.a.id)).toEqual({ p: "lease" });
    expect(await f.service.setPermissions({ seatRef: "dev-a@codex-team", codexProfile: "../escape", actor: "operator@codex-team", reason: "Bad" }))
      .toMatchObject({ ok: false });
  });
});

describe("both writers: the spec at creation, the setter afterwards, every launch reading the seat's record", () => {
  const authored = (profile: string, permissions?: CodexMemberPermissions) => ({ version: "0.2", name: "authored", pods: [{ id: "dev", label: "Dev", members: [
    { id: "impl", agent_ref: "local:impl.agent.yaml", profile: "default", runtime: "codex", cwd: "/same/project", codex_config_profile: profile,
      ...(permissions ? { codex_permissions: permissions } : {}) },
  ], edges: [] }], edges: [] });
  const materialize = async (db: Database.Database, raw: unknown) => {
    const setup = createTestApp(db, { podInstantiatorFsOps: {
      readFile: () => 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []', exists: () => true,
    } });
    const result = await setup.podInstantiator.materializeStructured(raw as never, "/project");
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error("materialize failed");
    return { setup, node: setup.rigRepo.getRig(result.result.rigId)!.nodes[0]!, rigId: result.result.rigId };
  };

  it("launches a changed spec's profile, then the setter's, and exports the current record", async () => {
    const f = fixture(async () => observation());
    expect(RigSpecSchema.validate(authored("spec-profile", lease)).valid).toBe(true);
    const { setup, node, rigId } = await materialize(f.db, authored("spec-profile", lease));
    expect(node.codexConfigProfile).toBe("spec-profile");
    expect(readCodexMemberPermissions(f.db, node.id)).toEqual(lease);
    const instantiator = setup.podInstantiator as unknown as { liveCodexProfile(nodeId: string, authored?: string): string | undefined };
    expect(instantiator.liveCodexProfile(node.id, "spec-profile")).toBe("spec-profile");

    const service = new SeatLifecycleService({ db: f.db, rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry, eventBus: setup.eventBus,
      tmuxAdapter: {} as TmuxAdapter, runtimeAdapters: { codex: { runtime: "codex", observeProfile: async () => observation() } as unknown as RuntimeAdapter } });
    const seat = "dev-impl@authored";
    setup.sessionRegistry.registerSession(node.id, seat);
    expect(await service.setPermissions({ seatRef: seat, codexProfile: "seat-profile", actor: "operator@authored", reason: "Retained update" })).toMatchObject({ ok: true });
    // The same launch read, now the setter's value; a cleared profile stays cleared rather than falling back to the spec.
    expect(instantiator.liveCodexProfile(node.id, "spec-profile")).toBe("seat-profile");
    f.db.prepare("UPDATE nodes SET codex_config_profile = NULL WHERE id = ?").run(node.id);
    expect(instantiator.liveCodexProfile(node.id, "spec-profile")).toBeUndefined();
    f.db.prepare("UPDATE nodes SET codex_config_profile = 'seat-profile' WHERE id = ?").run(node.id);

    await service.setPermissions({ seatRef: seat, codexPermissions: reader, actor: "operator@authored", reason: "Read only" });
    const exported = new RigSpecExporter({ rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry, podRepo: new PodRepository(f.db) }).exportRig(rigId);
    const member = RigSpecSchema.normalize(RigSpecCodec.parse(RigSpecCodec.serialize(exported as import("../src/domain/types.js").RigSpec))).pods[0]!.members[0]!;
    expect(member.codexPermissions).toEqual(reader);
    expect(member.codexConfigProfile).toBe("seat-profile");
    const wrongRuntime = structuredClone(authored("p", lease)); wrongRuntime.pods[0]!.members[0]!.runtime = "claude-code";
    expect(RigSpecSchema.validate(wrongRuntime).errors.join(" ")).toContain("codex_permissions");
  });

  it("restores with the seat's current profile, so an older snapshot can't bring back a replaced one", async () => {
    const f = fixture();
    const setup = createTestApp(f.db);
    const orchestrator = setup.restoreOrchestrator as unknown as { liveCodexProfile(rigId: string, node: { logicalId: string; codexConfigProfile?: string | null }): string | null };
    f.db.prepare("UPDATE nodes SET codex_config_profile = 'current' WHERE id = ?").run(f.a.id);
    expect(orchestrator.liveCodexProfile(f.rig.id, { logicalId: "dev.a", codexConfigProfile: "from-snapshot" })).toBe("current");
    f.db.prepare("UPDATE nodes SET codex_config_profile = NULL WHERE id = ?").run(f.a.id);
    expect(orchestrator.liveCodexProfile(f.rig.id, { logicalId: "dev.a", codexConfigProfile: "from-snapshot" })).toBeNull();
    expect(orchestrator.liveCodexProfile(f.rig.id, { logicalId: "dev.gone", codexConfigProfile: "from-snapshot" })).toBe("from-snapshot");
  });

  it("refuses to materialize a codex_permissions declaration on a non-Codex node", () => {
    const f = fixture();
    expect(() => f.rigRepo.addNode(f.rig.id, "dev.new", { runtime: "claude-code", codexPermissions: lease })).toThrow(/codex seat/);
    expect(f.db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.new'").get()).toBeUndefined();
  });
});

describe("legacy flat specs carry the envelope too", () => {
  it("validates, normalizes and round-trips a no-pod Codex seat's envelope", () => {
    const f = fixture();
    const raw = { name: "flat", version: "1", nodes: [{ id: "impl", runtime: "codex", cwd: "/same/project", codex_permissions: reader }] };
    expect(LegacyRigSpecSchema.validate(raw).errors).toEqual([]);
    expect(LegacyRigSpecSchema.normalize(raw).nodes[0]!.codexPermissions).toEqual(reader);
    const wrong = { ...raw, nodes: [{ ...raw.nodes[0], runtime: "claude-code" }] };
    expect(LegacyRigSpecSchema.validate(wrong).errors.join(" ")).toContain("codex_permissions");
    f.db.prepare("UPDATE nodes SET codex_permissions_json = ? WHERE id = ?").run(JSON.stringify(lease), f.a.id);
    const exported = new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: new SessionRegistry(f.db) }).exportRig(f.a.rigId);
    const parsed = LegacyRigSpecCodec.parse(LegacyRigSpecCodec.serialize(exported as import("../src/domain/types.js").LegacyRigSpec));
    expect(LegacyRigSpecSchema.normalize(parsed).nodes.find(n => n.codexPermissions)!.codexPermissions).toEqual(lease);
  });
});

describe("the setter's profile hash is bounded evidence, never a blocker", () => {
  const dir = () => { const d = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codex-profile-")); return d; };

  it("hashes a regular file and reports a missing one", async () => {
    const d = dir(); const file = nodePath.join(d, "lease.config.toml"); fs.writeFileSync(file, 'sandbox_mode = "read-only"\n');
    expect(await readProfileFingerprint(file)).toMatchObject({ state: "present", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await readProfileFingerprint(nodePath.join(d, "missing.config.toml"))).toEqual({ state: "absent" });
    expect(await readProfileFingerprint(file, 4)).toMatchObject({ state: "unreadable", reason: expect.stringContaining("larger") });
  });

  it.skipIf(process.platform === "win32")("doesn't wait on a FIFO or read a directory", async () => {
    const d = dir(); const fifo = nodePath.join(d, "fifo.config.toml"); execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    expect(await readProfileFingerprint(fifo)).toEqual({ state: "unreadable", reason: "not a regular file" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await readProfileFingerprint(d)).toEqual({ state: "unreadable", reason: "not a regular file" });
  }, 10_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports a read error as a reason", async () => {
    const d = dir(); const file = nodePath.join(d, "locked.config.toml"); fs.writeFileSync(file, "x = 1\n"); fs.chmodSync(file, 0o000);
    try { expect(await readProfileFingerprint(file)).toMatchObject({ state: "unreadable", reason: "EACCES" }); }
    finally { fs.chmodSync(file, 0o600); }
  });

  it("keeps a loading profile accepted when its bytes can't be read, and reports a check that couldn't run", async () => {
    // observeProfile reads no adapter filesystem: the profile check runs through its two injected seams.
    const tmux = {} as TmuxAdapter, fsOps = {} as CodexAdapterFsOps;
    const unread = new CodexRuntimeAdapter({ tmux, fsOps, codexHome: "/codex-home", profileFingerprint: async () => ({ state: "unreadable", reason: "not a regular file" }),
      verifyProfilePreflight: async profile => ({ ok: true, profile }) });
    expect(await unread.observeProfile("lease", "/same", "node-a")).toMatchObject({ file: "unreadable", load: "ok", detail: expect.stringContaining("not a regular file") });
    const broken = new CodexRuntimeAdapter({ tmux, fsOps, codexHome: "/codex-home", profileFingerprint: async () => { throw new Error("EIO"); },
      verifyProfilePreflight: async () => { throw new Error("spawn failed"); } });
    expect(await broken.observeProfile("lease", "/same", "node-a")).toMatchObject({ file: "unreadable", load: "not_run" });
  });

  it("checks and hashes the profile in the home this seat's launches use: its own CODEX_HOME, else the daemon's", async () => {
    // The profile loads in seat a's own home and fails in the daemon's. Seat b declares no home, so its launches use the daemon's.
    const checked: Array<string | undefined> = [], hashed: string[] = [];
    let f!: ReturnType<typeof fixture>;
    const adapter = new CodexRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps: {} as CodexAdapterFsOps, codexHome: "/daemon-home",
      seatHome: (nodeId) => nodeId === f.a.id ? "/seat-home" : undefined,
      profileFingerprint: async (file) => { hashed.push(file); return { state: "present", sha256: "b".repeat(64) }; },
      verifyProfilePreflight: async (profile, _cwd, home) => {
        checked.push(home);
        return home === "/seat-home" ? { ok: true, profile } : { ok: false, profile, error: `Codex profile '${profile}' failed to load from /daemon-home.` };
      } });
    f = fixture((profile, cwd, nodeId) => adapter.observeProfile(profile, cwd, nodeId));
    expect(await f.service.setPermissions({ seatRef: "dev-a@codex-team", codexProfile: "lease", actor: "operator@codex-team", reason: "Own home" }))
      .toMatchObject({ ok: true, to: "lease", observation: { home: "/seat-home", load: "ok", sha256: "b".repeat(64) } });
    expect(hashed).toEqual(["/seat-home/lease.config.toml"]);
    expect(checked).toEqual(["/seat-home"]);
    expect(await f.service.setPermissions({ seatRef: "dev-b@codex-team", codexProfile: "lease", actor: "operator@codex-team", reason: "Daemon home" }))
      .toMatchObject({ ok: false, code: "permission_selection_refused", message: expect.stringContaining("/daemon-home") });
    expect(hashed.at(-1)).toBe("/daemon-home/lease.config.toml");
    expect(checked.at(-1)).toBeUndefined();
  });

  it("answers the route instead of failing when the check itself throws", async () => {
    const f = fixture(async () => { throw new Error("EISDIR"); }), app = new Hono();
    app.use("*", async (c, next) => {
      for (const [key, value] of Object.entries({ rigRepo: f.rigRepo, eventBus: f.eventBus, sessionRegistry: new SessionRegistry(f.db), tmuxAdapter: {},
        runtimeAdapters: { codex: { runtime: "codex", observeProfile: async () => { throw new Error("EISDIR"); } } } })) c.set(key as never, value as never);
      await next();
    });
    app.route("/api/seat", seatRoutes);
    expect(await f.service.setPermissions({ seatRef: "dev-a@codex-team", codexProfile: "lease", actor: "operator@codex-team", reason: "Check" }))
      .toMatchObject({ ok: true, observation: { load: "not_run", detail: expect.stringContaining("EISDIR") } });
    const response = await app.request("/api/seat/set-permissions/dev-a%40codex-team", { method: "POST",
      headers: { "content-type": "application/json", "x-openrig-session": "actual@codex-team" }, body: JSON.stringify({ codexProfile: "lease", reason: "Check" }) });
    expect(response.status).toBe(200);
  });
});

function fixtureLess(f: ReturnType<typeof fixture>): SeatLifecycleService {
  return new SeatLifecycleService({ db: f.db, rigRepo: f.rigRepo, sessionRegistry: new SessionRegistry(f.db), eventBus: f.eventBus, tmuxAdapter: {} as TmuxAdapter });
}
