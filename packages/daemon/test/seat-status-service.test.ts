import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStatusService } from "../src/domain/seat-status-service.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { managedBlockBodyHash } from "../src/domain/managed-block-records.js";

describe("SeatStatusService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let service: SeatStatusService;
  let activityStore: AgentActivityStore;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    activityStore = new AgentActivityStore({ db, eventBus: new EventBus(db),
      resolveOccupantGeneration: id => sessionRegistry.currentOccupantTenure(id)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (id, generation) => sessionRegistry.isOccupantGenerationRegistered(id, generation) });
    service = new SeatStatusService({ rigRepo, activityStore });
  });

  afterEach(() => {
    db.close();
  });

  it("does not attach a last tool, another actor's prompt or completed activity to a permission diagnostic", () => {
    const rig = rigRepo.createRig("permission-status");
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });
    const other = rigRepo.addNode(rig.id, "other", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "worker@permission-status");
    sessionRegistry.registerSession(other.id, "other@permission-status");
    sessionRegistry.updateStatus(session.id, "running");
    const store = activityStore;
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    const observedAt = new Date().toISOString();
    store.observePermissionStop({ nodeId: node.id, sessionName: session.sessionName, generation,
      actor: null, at: observedAt, command: "Tool: Read", completed: false });
    expect(service.getStatus(session.sessionName)).toMatchObject({ ok: true, status: {
      permission_stop: { state: "request_observed", command: "Tool: Read", actor: "main", pending: "unknown" },
    } });
    sessionRegistry.mintOccupantTenure(node.id, "handover");
    expect(store.recordHookEvent({ runtime: "claude-code", sessionName: session.sessionName,
      hookEvent: "PreToolUse", subtype: "SYNTHETIC_PRIVATE_TOOL", generation: "old-generation" }).ok).toBe(true);
    expect(store.recordHookEvent({ runtime: "claude-code", sessionName: "other@permission-status",
      hookEvent: "Notification", subtype: "permission_prompt", hookAgentId: "another-actor" }).ok).toBe(true);
    const unavailable = { state: "unavailable", command: "unavailable", origin: "unknown" };
    const read = () => {
      const before = db.prepare("SELECT total_changes() AS count").get();
      const result = service.getStatus(session.sessionName);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(result.status.permission_stop).toEqual(unavailable);
      expect(JSON.stringify(result.status)).not.toContain("SYNTHETIC_PRIVATE_TOOL");
      expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
      return result.status;
    };
    expect(read().occupant_lifecycle).toBe("active");
    expect(store.recordHookEvent({ runtime: "claude-code", sessionName: session.sessionName,
      hookEvent: "Notification", subtype: "permission_prompt", hookAgentId: "subagent" }).ok).toBe(true);
    expect(store.recordHookEvent({ runtime: "claude-code", sessionName: session.sessionName,
      hookEvent: "PostToolBatch", hookAgentId: null }).ok).toBe(true);
    read();
    const currentGeneration = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    store.observePermissionStop({ nodeId: node.id, sessionName: session.sessionName, generation: currentGeneration,
      actor: null, at: new Date().toISOString(), command: "Tool: Write", completed: false });
    expect(service.getStatus(session.sessionName)).toMatchObject({ ok: true, status: {
      permission_stop: { state: "request_observed", command: "Tool: Write" },
    } });
    db.prepare("UPDATE nodes SET occupant_lifecycle = 'retired' WHERE id = ?").run(node.id);
    expect(read().occupant_lifecycle).toBe("retired");
    db.prepare("UPDATE nodes SET occupant_lifecycle = 'active' WHERE id = ?").run(node.id);
    store.observePermissionStop({ nodeId: node.id, sessionName: session.sessionName, generation: currentGeneration,
      actor: null, at: new Date().toISOString(), command: "Tool: Edit", completed: false });
    expect(service.getStatus(session.sessionName)).toMatchObject({ ok: true, status: {
      permission_stop: { state: "request_observed", command: "Tool: Edit" },
    } });
    sessionRegistry.updateStatus(session.id, "exited");
    expect(read().session_status).toBe("exited");
  });

  it("shows an owed restore's delivery failure on the same seat status the operator reads", () => {
    const rig = rigRepo.createRig("restore-status");
    const node = rigRepo.addNode(rig.id, "writer", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "writer@restore-status");
    sessionRegistry.updateStatus(session.id, "running");
    const owedRestore = { stage: "turn_boundary" as const, held: true, detail: "OpenRig owes the turn boundary. Last delivery: target_activity_unknown." };
    const observer = { recoverSeat: () => {}, observedCompaction: () => ({ stage: "compacting" as const, detail: owedRestore.detail }), getOwedRestore: () => owedRestore };
    const status = new SeatStatusService({ rigRepo, compactionEnforcer: observer }).getStatus(session.sessionName);
    expect(status.ok && status.status.compaction).toEqual({ stage: "compacting", detail: owedRestore.detail, owedRestore });
  });

  it("reports a confirmed missing current session as detached while preserving its registration", async () => {
    const { app, rigRepo: repo, sessionRegistry: registry } = createTestApp(db);
    const rig = repo.createRig("missing-seat");
    const node = repo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = registry.registerSession(node.id, "dev-impl@missing-seat");
    registry.updateStatus(session.id, "running");
    registry.updateStartupStatus(session.id, "ready");
    registry.updateBinding(node.id, { tmuxSession: session.sessionName, tmuxPane: "%1", attachmentType: "tmux" });
    const stored = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id);
    new SeatIdentityStore(db).upsert({
      nodeId: node.id, sessionName: session.sessionName,
      verdict: "pane_missing", reason: "session_missing", evidenceSource: "tmux_session",
      evidence: { registeredPane: "%1", observedPid: null, observedCommand: null, matchedLayer: null },
      observedAt: new Date(Date.now() + 1).toISOString(),
    });
    const res = await app.request(`/api/seat/status/${encodeURIComponent(session.sessionName)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      session_status: "detached", session_reason: "session_missing", startup_status: "ready",
      occupant_lifecycle: "unknown", current_occupant: session.sessionName,
    });
    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id)).toEqual(stored);
  });

  it("reports the runtime home a Claude or Codex seat's launches use, and where it comes from", () => {
    const rig = rigRepo.createRig("home-rig");
    const nodes = {
      own: rigRepo.addNode(rig.id, "dev.own", { runtime: "codex" }),
      rel: rigRepo.addNode(rig.id, "dev.rel", { runtime: "codex" }),
      plain: rigRepo.addNode(rig.id, "dev.plain", { runtime: "claude-code" }),
      pi: rigRepo.addNode(rig.id, "dev.pi", { runtime: "pi" }),
      term: rigRepo.addNode(rig.id, "dev.term", { runtime: "terminal" }),
    };
    for (const [name, node] of Object.entries(nodes)) sessionRegistry.registerSession(node.id, `dev-${name}@home-rig`);
    db.prepare("UPDATE nodes SET env_json = ? WHERE id = ?").run(JSON.stringify({ CODEX_HOME: "/homes/own" }), nodes.own.id);
    db.prepare("UPDATE nodes SET env_json = ? WHERE id = ?").run(JSON.stringify({ CODEX_HOME: "rel/codex" }), nodes.rel.id);
    const svc = new SeatStatusService({ rigRepo, env: { HOME: "/users/op", CODEX_HOME: "/daemon/codex", PI_CODING_AGENT_DIR: "/daemon/pi-ignored" } });
    const status = (ref: string) => {
      const result = svc.getStatus(ref);
      if (!result.ok) throw new Error(result.code);
      return result.status;
    };
    expect(status("dev-own@home-rig").runtime_home).toEqual({ variable: "CODEX_HOME", home: "/homes/own", source: "member" });
    expect(status("dev-rel@home-rig").runtime_home).toEqual({ variable: "CODEX_HOME", home: "/daemon/codex", source: "daemon",
      ignored: { source: "member", value: "rel/codex" } });
    expect(status("dev-plain@home-rig").runtime_home).toEqual({ variable: "CLAUDE_CONFIG_DIR", home: "/users/op/.claude", source: "native_default" });
    expect(status("dev-pi@home-rig").runtime_home).toEqual({ variable: "PI_CODING_AGENT_DIR", home: null, source: "native_default" });
    expect(status("dev-term@home-rig")).not.toHaveProperty("runtime_home");
  });

  it("shows what OpenRig's own refocus hook recorded for a Claude or Codex seat, from that hook's state in OPENRIG_HOME", () => {
    const home = mkdtempSync(path.join(tmpdir(), "seat-refocus-"));
    try {
      const rig = rigRepo.createRig("refocus-rig");
      const nodes = {
        claude: rigRepo.addNode(rig.id, "dev.claude", { runtime: "claude-code" }),
        codex: rigRepo.addNode(rig.id, "dev.codex", { runtime: "codex" }),
        pi: rigRepo.addNode(rig.id, "dev.pi", { runtime: "pi" }),
      };
      for (const [name, node] of Object.entries(nodes)) sessionRegistry.registerSession(node.id, `dev-${name}@refocus-rig`);
      // The claude seat's hook has recorded a conversation; the codex seat's never has.
      mkdirSync(path.join(home, "refocus"));
      writeFileSync(path.join(home, "refocus", "dev-claude@refocus-rig__conv-1.json"), JSON.stringify({ lastBytes: 1, baselineAt: "2026-11-10T00:00:00Z" }));
      const svc = new SeatStatusService({ rigRepo, env: { HOME: "/users/op", OPENRIG_HOME: home } });
      const status = (ref: string) => {
        const result = svc.getStatus(ref);
        if (!result.ok) throw new Error(result.code);
        return result.status;
      };
      expect(status("dev-claude@refocus-rig").refocus).toMatchObject({ lastRecordedAt: expect.any(String), currentConversation: "unknown" });
      expect(status("dev-codex@refocus-rig").refocus).toMatchObject({ lastRecordedAt: null, detail: expect.stringContaining("has no record for this seat") });
      expect(status("dev-pi@refocus-rig")).not.toHaveProperty("refocus");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("names a Claude seat's own subscription token by its label and file, and says when that file wouldn't apply at the next launch", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seat-token-status-"));
    try {
      const ready = path.join(dir, "ready");
      writeFileSync(ready, "fixture-file-contents", { mode: 0o600 });
      const rig = rigRepo.createRig("token-rig");
      const nodes = {
        ok: rigRepo.addNode(rig.id, "dev.ok", { runtime: "claude-code" }),
        missing: rigRepo.addNode(rig.id, "dev.missing", { runtime: "claude-code" }),
        none: rigRepo.addNode(rig.id, "dev.none", { runtime: "claude-code" }),
      };
      for (const [name, node] of Object.entries(nodes)) sessionRegistry.registerSession(node.id, `dev-${name}@token-rig`);
      rigRepo.setNodeClaudeTokenRef(nodes.ok.id, { label: "work", tokenFile: ready });
      rigRepo.setNodeClaudeTokenRef(nodes.missing.id, { label: "personal", tokenFile: path.join(dir, "gone") });
      const status = (ref: string) => {
        const result = service.getStatus(ref);
        if (!result.ok) throw new Error(result.code);
        return result.status;
      };
      expect(status("dev-ok@token-rig").claude_token).toEqual({ label: "work", token_file: ready, file: "readable" });
      expect(status("dev-missing@token-rig").claude_token).toMatchObject({ label: "personal", token_file: path.join(dir, "gone"),
        file: "unusable", problem: expect.stringContaining("doesn't exist"), notice: expect.stringContaining("wasn't applied") });
      expect(status("dev-none@token-rig")).not.toHaveProperty("claude_token");
      // The file is checked, never read: its contents appear nowhere.
      expect(JSON.stringify(status("dev-ok@token-rig"))).not.toContain("fixture-file-contents");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns honest no-handover defaults for an existing active node", () => {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");

    const result = service.getStatus("dev-impl@seat-rig");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status).toMatchObject({
      permission_stop: { state: "unavailable", command: "unavailable", origin: "unknown" },
      seat_ref: "dev-impl@seat-rig",
      rig_name: "seat-rig",
      logical_id: "dev.impl",
      current_occupant: "dev-impl@seat-rig",
      session_status: "running",
      startup_status: "ready",
      occupant_lifecycle: "active",
      continuity_outcome: null,
      handover_result: null,
      previous_occupant: null,
      handover_at: null,
    });
  });

  it("returns populated handover axes and provenance fields", () => {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    db.prepare(`
      UPDATE nodes SET
        occupant_lifecycle = 'retired',
        continuity_outcome = 'rebuilt',
        handover_result = 'partial',
        previous_occupant = 'old-impl@seat-rig',
        handover_at = '2026-04-20T13:00:00Z'
      WHERE id = ?
    `).run(node.id);

    const result = service.getStatus("dev.impl@seat-rig");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status.occupant_lifecycle).toBe("retired");
    expect(result.status.continuity_outcome).toBe("rebuilt");
    expect(result.status.handover_result).toBe("partial");
    expect(result.status.previous_occupant).toBe("old-impl@seat-rig");
    expect(result.status.handover_at).toBe("2026-04-20T13:00:00Z");
  });

  it("does not infer active lifecycle for a node with no current running session", () => {
    const rig = rigRepo.createRig("seat-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });

    const result = service.getStatus("dev.impl@seat-rig");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.status.current_occupant).toBeNull();
    expect(result.status.occupant_lifecycle).toBe("unknown");
    expect(result.status.continuity_outcome).toBeNull();
    expect(result.status.handover_result).toBeNull();
  });

  it("resolves canonical pod coordinates for never-launched, dotted-member and stopped seats", () => {
    const rig = rigRepo.createRig("seat-rig");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Development");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: pod.id });
    rigRepo.addNode(rig.id, "dev.member.dot", { runtime: "terminal", podId: pod.id });
    const stopped = rigRepo.addNode(rig.id, "dev.stopped", { runtime: "terminal", podId: pod.id });
    const session = sessionRegistry.registerSession(stopped.id, "former-alias@seat-rig");
    sessionRegistry.updateStatus(session.id, "exited");

    expect(service.getStatus("dev-impl@seat-rig")).toMatchObject({
      ok: true,
      status: { logical_id: "dev.impl", current_occupant: null, occupant_lifecycle: "unknown" },
    });
    expect(service.getStatus("dev-member.dot@seat-rig")).toMatchObject({
      ok: true, status: { logical_id: "dev.member.dot" },
    });
    expect(service.getStatus("dev-stopped@seat-rig")).toMatchObject({
      ok: true, status: { logical_id: "dev.stopped", session_status: "exited" },
    });
    expect(service.getStatus("dev.impl@seat-rig")).toMatchObject({ ok: true });
    expect(service.getStatus("dev-missing@seat-rig")).toMatchObject({ ok: false, code: "seat_not_found" });

    const duplicate = rigRepo.createRig("seat-rig");
    rigRepo.addNode(duplicate.id, "dev.impl", { runtime: "terminal" });
    expect(service.getStatus("dev-impl@seat-rig")).toMatchObject({ ok: false, code: "seat_ambiguous" });
    db.prepare("UPDATE rigs SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), duplicate.id);
    expect(service.getStatus("dev-impl@seat-rig")).toMatchObject({ ok: true });
  });

  it("the status route resolves an adopted seat by canonical, logical and raw session references", async () => {
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("seat-rig");
    const pod = new PodRepository(db).createPod(rig.id, "dev", "Development");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "terminal", podId: pod.id });
    setup.sessionRegistry.registerClaimedSession(node.id, "adopted-private-name");

    for (const ref of ["dev-impl@seat-rig", "dev.impl@seat-rig", "adopted-private-name"]) {
      const response = await setup.app.request(`/api/seat/status/${encodeURIComponent(ref)}`);
      expect(response.status, ref).toBe(200);
      expect(await response.json()).toMatchObject({
        logical_id: "dev.impl", current_occupant: "adopted-private-name", session_status: "running",
      });
    }
  });

  // A running Claude or Codex seat gets what OpenRig wrote into its guidance file, set against when the running agent
  // loaded it; a Pi seat and a stopped seat get no guidance field.
  it("reports when OpenRig wrote each guidance block, set against the session's recorded startup finish", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "seat-guidance-"));
    try {
      const rig = rigRepo.createRig("guidance-rig");
      const node = rigRepo.addNode(rig.id, "lead", { runtime: "claude-code", cwd });
      const session = sessionRegistry.registerSession(node.id, "lead@guidance-rig");
      sessionRegistry.updateStatus(session.id, "running");
      db.prepare("UPDATE sessions SET startup_completed_at = ? WHERE id = ?").run("2026-11-10T10:00:00.000Z", session.id);
      const file = path.join(cwd, "CLAUDE.md");
      writeFileSync(file, "<!-- BEGIN OpenRig MANAGED BLOCK: openrig-start.md -->\nIdentity.\n<!-- END OpenRig MANAGED BLOCK: openrig-start.md -->\n"
        + "<!-- BEGIN OpenRig MANAGED BLOCK: openrig-context-entry.md -->\nWhere things are.\n<!-- END OpenRig MANAGED BLOCK: openrig-context-entry.md -->\n");
      const record = db.prepare("INSERT INTO managed_block_writes (path_key, block_id, body_sha256, written_at) VALUES (?, ?, ?, ?)");
      record.run(realpathSync.native(file), "openrig-start.md", managedBlockBodyHash("Identity."), "2026-11-10T09:59:30.000Z");
      record.run(realpathSync.native(file), "openrig-context-entry.md", managedBlockBodyHash("Where things are."), "2026-11-10T12:00:00.000Z");

      const status = service.getStatus("lead@guidance-rig");
      expect(status.ok && status.status.guidance).toMatchObject({
        file,
        mark: { at: "2026-11-10T10:00:00.000Z", kind: "startup_finished" },
        blocks: [{ id: "openrig-start.md", written: "before" }, { id: "openrig-context-entry.md", written: "after" }],
      });
      expect(status.ok && status.status.guidance?.detail).toContain("OpenRig doesn't record what an agent read.");

      const pi = rigRepo.addNode(rig.id, "helper", { runtime: "pi", cwd });
      sessionRegistry.updateStatus(sessionRegistry.registerSession(pi.id, "helper@guidance-rig").id, "running");
      const piStatus = service.getStatus("helper@guidance-rig");
      expect(piStatus.ok && piStatus.status.guidance).toBeUndefined();
      sessionRegistry.updateStatus(session.id, "exited");
      const stopped = service.getStatus("lead@guidance-rig");
      expect(stopped.ok && stopped.status.guidance).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns not found for an unknown seat reference", () => {
    const result = service.getStatus("missing@seat-rig");

    expect(result).toMatchObject({
      ok: false,
      code: "seat_not_found",
      guidance: "List seats with: rig ps --nodes",
    });
  });

  it("wires the daemon /api/seat/status route", async () => {
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("seat-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");

    const res = await setup.app.request("/api/seat/status/dev-impl%40seat-rig");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      permission_stop: { state: "unavailable", command: "unavailable", origin: "unknown" },
      seat_ref: "dev-impl@seat-rig",
      rig_name: "seat-rig",
      logical_id: "dev.impl",
      occupant_lifecycle: "active",
      handover_result: null,
    });
  });
});
