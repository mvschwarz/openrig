// S5b (OPR.0.5.4.11) — running-name guard, RED-first. The specimen: `rig up`
// twice on one spec name while the first rig runs silently mints a DUPLICATE rig
// sharing the name-keyed namespace (dev50-driver 08-26 specimen; 0.5.3
// import-retry precedent). The FLOOR: every instantiator create path refuses when
// a same-name rig is RUNNING (>=1 session row status='running' — the daemon's own
// derivation), teaches the running rig's identity + alternatives, spends nothing.
// Stopped-generation name reuse is pinned UNCHANGED.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { checkRunningNameGuard } from "../src/domain/running-name-guard.js";
import type { PodRigSpec } from "../src/domain/types.js";

function rigCount(db: Database.Database, name: string): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM rigs WHERE name = ?").get(name) as { c: number }).c;
}

function sessionCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c;
}

describe("running-name guard (S5b floor)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => { db.close(); });

  /** A same-name rig with one seat; session status as given. */
  function existingRig(name: string, sessionStatus: string) {
    const rig = setup.rigRepo.createRig(name);
    const node = setup.rigRepo.addNode(rig.id, "crew.a", { runtime: "claude-code", cwd: "/" });
    const session = setup.sessionRegistry.registerSession(node.id, `crew-a@${name}`);
    setup.sessionRegistry.updateStatus(session.id, sessionStatus);
    return { rig, node, session };
  }

  function flatSpec(name: string) {
    return {
      schemaVersion: 1,
      name,
      version: "1.0.0",
      nodes: [{ id: "solo", runtime: "claude-code" as const, role: "worker", cwd: "/" }],
      edges: [],
    };
  }

  function podSpec(name: string): PodRigSpec {
    return {
      version: "0.2",
      name,
      pods: [{
        id: "crew",
        label: "Crew",
        members: [{ id: "a", agentRef: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "/" }],
        edges: [],
      }],
      edges: [],
    } as unknown as PodRigSpec;
  }

  function tmuxMock() {
    return setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
  }

  // ---- proof item 1: SECOND UP REFUSED, RED-FIRST (flat create site) ----

  it("flat instantiate REFUSES when a same-name rig is RUNNING: teaching error, nothing created, nothing launched", async () => {
    const { rig } = existingRig("dupe-rig", "running");
    const sessionsBefore = sessionCount(db);

    const result = await setup.rigInstantiator.instantiate(flatSpec("dupe-rig") as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error(`DEFECT: second up proceeded; rig rows for name = ${rigCount(db, "dupe-rig")}`);
    expect((result as { code: string }).code).toBe("rig_name_running");
    const message = (result as { message: string }).message;
    // Mini-req 2 — the refusal teaches: running rig identity, what was checked,
    // nothing created/launched, and the supported alternatives.
    expect(message).toContain("dupe-rig");
    expect(message).toContain(rig.id);
    expect(message).toMatch(/1 running session/);
    expect(message).toMatch(/checked/i);
    expect(message).toMatch(/nothing was created or launched/i);
    expect(message).toMatch(/rig down/);
    expect(message).toMatch(/different name/);

    // Nothing created, nothing launched, no resource spent.
    expect(rigCount(db, "dupe-rig")).toBe(1);
    expect(sessionCount(db)).toBe(sessionsBefore);
    expect(tmuxMock().createSession).not.toHaveBeenCalled();
  });

  // ---- proof item 2: STOPPED-GENERATION CONTROL (behavior pinned UNCHANGED) ----
  //
  // Mechanism discovery at base ba0550af2 (recorded for the receipt): the FLAT
  // path's RigSpecPreflight ALREADY refuses any same-name rig ("Rig name '<x>'
  // already exists") regardless of running state — the flat path could not mint
  // the duplicate. The unguarded path is the POD path (`rig up`), where the
  // specimen occurred. "Unchanged" therefore means: flat + stopped generations
  // keeps TODAY'S preflight refusal; pod + stopped generations keeps proceeding.

  it("flat instantiate with same-name rigs all STOPPED keeps today's preflight behavior (pinned unchanged)", async () => {
    existingRig("gen-rig", "exited");
    existingRig("gen-rig", "detached");

    const result = await setup.rigInstantiator.instantiate(flatSpec("gen-rig") as never);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("flat path behavior changed: proceeded where pre-fix preflight refused");
    expect((result as { code: string }).code).toBe("preflight_failed");
    expect(JSON.stringify((result as { errors?: string[] }).errors)).toContain("already exists");
    expect(rigCount(db, "gen-rig")).toBe(2); // nothing new created — same as today
  });

  // ---- proof item 4: ONE GUARD, ALL PATHS (pod create sites) ----

  it("pod materializeValidatedSpec REFUSES a running same-name rig (create branch) and spends nothing", async () => {
    existingRig("dupe-pod", "running");
    const before = rigCount(db, "dupe-pod");

    const result = await setup.podInstantiator.materializeValidatedSpec(podSpec("dupe-pod"), "/tmp", []);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("DEFECT: pod materialize created a duplicate running-name rig");
    expect((result as { code: string }).code).toBe("rig_name_running");
    expect(rigCount(db, "dupe-pod")).toBe(before);
  });

  it("pod materializeValidatedSpec with targetRigId (expand path) is NOT blocked by the guard", async () => {
    const { rig } = existingRig("expand-rig", "running");

    const result = await setup.podInstantiator.materializeValidatedSpec(
      podSpec("expand-rig"), "/tmp", [], { targetRigId: rig.id },
    );

    // Expansion targets the EXISTING rig — no new rig row, so the guard must not
    // fire; whatever else the outcome is, it is never the running-name refusal.
    expect((result as { code?: string }).code).not.toBe("rig_name_running");
    expect(rigCount(db, "expand-rig")).toBe(1);
  });

  it("pod YAML instantiate REFUSES a running same-name rig BEFORE preflight (the rig-up path)", async () => {
    existingRig("dupe-yaml", "running");
    const yaml = [
      'version: "0.2"',
      "name: dupe-yaml",
      "pods:",
      "  - id: crew",
      "    label: Crew",
      "    members:",
      "      - id: a",
      '        agent_ref: "builtin:terminal"',
      '        profile: "none"',
      "        runtime: terminal",
      "        cwd: /",
      "    edges: []",
      "edges: []",
    ].join("\n");

    const result = await setup.podInstantiator.instantiate(yaml, "/tmp");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("DEFECT: pod YAML instantiate created a duplicate running-name rig");
    expect((result as { code: string }).code).toBe("rig_name_running");
    expect(rigCount(db, "dupe-yaml")).toBe(1);
    expect(tmuxMock().createSession).not.toHaveBeenCalled();
  });

  it("pod YAML instantiate passes THROUGH the guard when same-name generations are all stopped", async () => {
    existingRig("gen-yaml", "exited");
    const yaml = [
      'version: "0.2"',
      "name: gen-yaml",
      "pods:",
      "  - id: crew",
      "    label: Crew",
      "    members:",
      "      - id: a",
      '        agent_ref: "builtin:terminal"',
      '        profile: "none"',
      "        runtime: terminal",
      "        cwd: /",
      "    edges: []",
      "edges: []",
    ].join("\n");

    const result = await setup.podInstantiator.instantiate(yaml, "/tmp");

    // The discriminator is the guard verdict alone: whatever this harness's
    // preflight yields, a stopped-generation name must NEVER produce the
    // running-name refusal (positive evidence the guard let it through).
    expect((result as { code?: string }).code).not.toBe("rig_name_running");
  });

  // ---- the helper's own contract ----

  it("checkRunningNameGuard: verdict carries the running rig identity; all-stopped names pass", () => {
    const deps = {
      findRigsByName: (name: string) => name === "x" ? [{ id: "RIG1", name: "x" }, { id: "RIG2", name: "x" }] : [],
      countRunningSessions: (rigId: string) => (rigId === "RIG2" ? 2 : 0),
    };

    const blocked = checkRunningNameGuard(deps, "x");
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected refusal");
    expect(blocked.runningRig).toEqual({ id: "RIG2", name: "x", runningSessionCount: 2 });
    expect(blocked.message).toMatch(/2 running session/);

    const clear = checkRunningNameGuard({ ...deps, countRunningSessions: () => 0 }, "x");
    expect(clear.ok).toBe(true);
  });
});
