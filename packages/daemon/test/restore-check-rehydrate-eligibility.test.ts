import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createApp } from "../src/server.js";
import { createRestoreCheckService } from "../src/routes/restore-check.js";
import * as eligibility from "../src/domain/rehydrate-eligibility.js";
import * as preconditions from "../src/domain/restore-preconditions.js";

describe("restore-check current-state eligibility correction", () => {
  let setup: ReturnType<typeof createTestApp>;
  let app: ReturnType<typeof createApp>;
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "restore-eligibility-"));
    vi.stubEnv("OPENRIG_HOME", home);
    setup = createTestApp(createFullTestDb());
    app = createApp(setup);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setup.db.close();
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function seed(name: string, partial = false) {
    const { rigRepo, sessionRegistry, db } = setup;
    const rig = rigRepo.createRig(name);
    for (let i = 0; i < (partial ? 2 : 1); i++) {
      const node = rigRepo.addNode(rig.id, `seat${i}`, { runtime: "claude-code", cwd: home });
      const session = sessionRegistry.registerSession(node.id, `seat${i}@${name}`);
      sessionRegistry.updateStatus(session.id, partial && i === 1 ? "running" : "stopped");
      sessionRegistry.updateStartupStatus(session.id, "ready");
      db.prepare("UPDATE sessions SET resume_type='claude_id',resume_token='fixture-native-token' WHERE id=?").run(session.id);
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'claude-code')").run(node.id);
    }
    return rig;
  }

  function snapshot(rigId: string, stale = false) {
    const rig = setup.rigRepo.getRig(rigId)!;
    const sessions = setup.sessionRegistry.getSessionsForRig(rigId).map((s) => stale ? { ...s, id: `older-${s.id}` } : s);
    return setup.snapshotRepo.createSnapshot(rigId, "auto-pre-down", {
      rig: rig.rig, nodes: rig.nodes, edges: rig.edges, sessions, checkpoints: {},
      activeSessionIdByNode: Object.fromEntries(sessions.map((s) => [s.nodeId, s.id])),
    });
  }
  const changes = () => setup.db.prepare("SELECT total_changes() AS n").get();
  const check = (rig: string, compact = false) => app.request(`/api/restore-check?rig=${rig}&noQueue=true&noHooks=true${compact ? "&compact=1" : ""}`).then((r) => r.json());

  // Retains the stale-occupant specimen: stopped Claude, current token,
  // persisted context, and an older session id in the selected snapshot.
  it.each([false, true])("keeps the stale-occupant manual up hint without capture (compact=%s)", async (compact) => {
    const rig = seed("stale-occupant");
    snapshot(rig.id, true);
    const capture = vi.spyOn(setup.snapshotCapture, "captureSnapshot");
    const validate = vi.spyOn(preconditions, "validatePreRestore");
    const before = changes();
    const result = await check(rig.name, compact);
    const input = result.checks.find((c: { check: string }) => c.check.endsWith(".restore-preconditions"));
    expect(input.status).toBe("yellow");
    expect(input.evidence).toContain("older occupant");
    expect(input.evidence).toContain("restore inputs not inspected");
    expect(result.recovery.status).toBe("actionable");
    expect(result.recovery.actions[0]).toMatchObject({ command: "rig up --existing stale-occupant", safe: false });
    const status = await (await app.request(`/api/rigs/${rig.id}/status`)).json();
    expect(status).toMatchObject({ status: "down", recoverable: true });
    expect(status.perSeat[0].intendedAction).toBe("resume-original");
    const planResponse = await app.request(`/api/rigs/${rig.id}/up`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan: true }) });
    expect(planResponse.status).toBe(200);
    expect(await planResponse.json()).toMatchObject({ mutated: false, wouldCaptureCurrentState: true });
    expect(validate).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(changes()).toEqual(before);
  });

  it.each([false, true])("preserves eligible no-snapshot lifecycle (partial=%s), with one eligibility read per rig", async (partial) => {
    const rig = seed("no-snapshot", partial);
    const decide = vi.spyOn(eligibility, "assessCurrentStateRehydrateEligibility");
    const validate = vi.spyOn(preconditions, "validatePreRestore");
    const prepare = vi.spyOn(setup.db, "prepare");
    const before = changes();
    const result = await check(rig.name);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(validate).not.toHaveBeenCalled();
    expect(prepare.mock.calls.filter(([sql]) => /SELECT node_id, resume_token/.test(sql))).toHaveLength(1);
    expect(prepare.mock.calls.filter(([sql]) => /SELECT 1 FROM node_startup_context/.test(sql))).toHaveLength(partial ? 2 : 1);
    expect(result.recovery.actions[0].command).toBe("rig up --existing no-snapshot");
    expect(result.checks.find((c: { check: string }) => c.check.endsWith(".restore-preconditions")).status).toBe("yellow");
    const status = await (await app.request(`/api/rigs/${rig.id}/status`)).json();
    expect(status).toMatchObject({ status: partial ? "partial" : "down", recoverable: true });
    expect(changes()).toEqual(before);
  });

  it.each(["no-nodes", "no-sessions", "missing-inputs"])("does not make an ineligible rig recoverable: %s", async (kind) => {
    const rig = kind === "no-nodes" ? setup.rigRepo.createRig(kind) : seed(kind);
    if (kind === "no-sessions") setup.db.prepare("UPDATE sessions SET status='superseded'").run();
    if (kind === "missing-inputs") {
      setup.db.prepare("DELETE FROM node_startup_context").run();
      setup.db.prepare("UPDATE sessions SET resume_token=NULL").run();
    }
    const before = changes();
    const result = await check(rig.name);
    const input = result.checks.find((c: { check: string }) => c.check.endsWith(".restore-preconditions"));
    expect(input.status).toBe("red");
    expect(input.evidence).toContain("not eligible");
    expect(result.recovery).toMatchObject({ status: "blocked", actions: [] });
    const status = await (await app.request(`/api/rigs/${rig.id}/status`)).json();
    expect(status).toMatchObject({ status: "blocked", recoverable: false });
    expect(changes()).toEqual(before);
  });

  it.each(["missing-rig", "eligibility-read", "snapshot-read"])("retains named unknown input: %s", (failure) => {
    const rig = seed("unavailable");
    if (failure === "missing-rig") vi.spyOn(setup.rigRepo, "getRig").mockReturnValue(null);
    if (failure === "eligibility-read") vi.spyOn(eligibility, "assessCurrentStateRehydrateEligibility").mockImplementation(() => { throw new Error("fixture eligibility read failed"); });
    if (failure === "snapshot-read") vi.spyOn(setup.snapshotRepo, "selectRestoreUsable").mockImplementation(() => { throw new Error("fixture snapshot read failed"); });
    const before = changes();
    const result = createRestoreCheckService(setup.rigRepo, setup.snapshotRepo).check({ noQueue: true, noHooks: true });
    expect(result.rigs[0].status).toBe("unknown");
    expect(result.recovery.status).toBe("unknown");
    expect(result.recovery.actions).toEqual([]);
    expect(result.recovery.unknown[0].reason).toContain(failure === "missing-rig" ? "no longer exists" : "read failed");
    expect(changes()).toEqual(before);
  });

  it.each(["required-file", "awaiting-decision"])("eligibility never conceals the concrete blocker: %s", async (kind) => {
    const rig = seed("blocked");
    if (kind === "required-file") {
      setup.db.prepare("UPDATE node_startup_context SET resolved_files_json=?").run(JSON.stringify([{ absolutePath: path.join(home, "absent-required.md"), required: true }]));
    } else setup.db.prepare("UPDATE sessions SET resume_token=NULL").run();
    const before = changes();
    const result = await check(rig.name);
    expect(result.checks.find((c: { check: string }) => c.check.endsWith(".restore-preconditions")).status).toBe("yellow");
    if (kind === "required-file") expect(result.recovery).toMatchObject({ status: "blocked", actions: [] });
    const status = await (await app.request(`/api/rigs/${rig.id}/status`)).json();
    expect(status).toMatchObject({ status: "blocked", recoverable: false });
    if (kind === "awaiting-decision") expect(status.perSeat[0].intendedAction).toBe("awaiting-decision");
    expect(changes()).toEqual(before);
  });

  it.each([false, true])("known red wins over unrelated unknown; other results remain intact (compact=%s)", async (compact) => {
    const bad = setup.rigRepo.createRig("known-red");
    const unknown = setup.rigRepo.createRig("unknown-input");
    const good = setup.rigRepo.createRig("unaffected");
    snapshot(bad.id); snapshot(good.id);
    setup.rigRepo.setServicesRecord(bad.id, { kind: "compose", specJson: "{}", rigRoot: path.join(home, "missing-service"), composeFile: path.join(home, "missing-compose.yaml") });
    const select = setup.snapshotRepo.selectRestoreUsable.bind(setup.snapshotRepo);
    vi.spyOn(setup.snapshotRepo, "selectRestoreUsable").mockImplementation((id) => { if (id === unknown.id) throw new Error("fixture unrelated unavailable"); return select(id); });
    const validate = vi.spyOn(preconditions, "validatePreRestore");
    const before = changes();
    const result = await (await app.request(`/api/restore-check?noQueue=true&noHooks=true${compact ? "&compact=1" : ""}`)).json();
    expect(result.verdict).toBe("not_restorable");
    expect(result.readiness).toMatchObject({ status: "not_ready", unknownRigCount: 1 });
    expect(result.counts.red).toBeGreaterThan(0);
    expect(result.counts.yellow).toBeGreaterThan(0);
    expect(result.rigs.find((r: { rigId: string }) => r.rigId === unknown.id).status).toBe("unknown");
    expect(result.rigs.find((r: { rigId: string }) => r.rigId === good.id).status).not.toBe("unknown");
    expect(result.checks.some((c: { evidence: string }) => c.evidence.includes("fixture unrelated unavailable"))).toBe(true);
    expect(validate).toHaveBeenCalledTimes(2);
    expect((await (await app.request(`/api/rigs/${bad.id}/status`)).json()).status).toBe("blocked");
    expect((await (await app.request(`/api/rigs/${unknown.id}/status`)).json()).status).toBe("unknown");
    expect(changes()).toEqual(before);
  });
});
