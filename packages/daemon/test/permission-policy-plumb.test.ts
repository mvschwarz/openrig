// OPR.0.4.8.3 Seam B (R6) — full-thread discrimination pins: the permission_policy REF +
// resolved posture survive materialize → columns → export → DB-REOPEN, with member-over-rig
// precedence and the dev-guard restart ruling (a custom surface:flag policy restores to
// full_bypass) proven against a REOPENED database handle. Every pin here discriminates
// against the pre-Seam-B tip (none of the columns/threading exist at 80336ff0/4694e86d).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFullTestDb, createTestApp, migrationsForFullTestDb } from "./helpers/test-app.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { resolvePermissionPolicyAttachment } from "../src/domain/permission-policy/policy-ref.js";
import { claudePostureFlag, codexPostureArg, piTrust } from "../src/adapters/yolo-mode.js";

const RIG_ROOT = "/project/rigs/policy-rig";
const CUSTOM_POLICY = `---
name: operator-full
version: "1"
description: full-bypass flag policy for the plumb pins
surface: flag
launch_posture: full_bypass
allowed_actions: []
ask_actions: []
denied_actions: []
watch_actions: []
---
# Operator full
`;

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

function rawMember(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".", ...over };
}

function rawSpec(members: Record<string, unknown>[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "0.2",
    name: "policy-rig",
    pods: [{ id: "dev", label: "Dev", members, edges: [] }],
    edges: [],
    ...over,
  };
}

function fsOps() {
  return {
    readFile: (p: string) => {
      if (p.includes("agents/impl")) return agentYaml("impl");
      if (p.includes("policies/operator-full.md")) return CUSTOM_POLICY;
      throw new Error(`Not found: ${p}`);
    },
    exists: (p: string) => p.includes("agents/impl") || p.includes("policies/operator-full.md"),
  };
}

describe("Seam B R6 — full-thread plumb (materialize → columns → export)", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db, { podInstantiatorFsOps: fsOps() });
  });
  afterEach(() => { db.close(); });

  it("rig-level + member refs land on their rows; member OVERRIDES rig at resolution (precedence)", async () => {
    const spec = rawSpec(
      [rawMember("impl", { permission_policy: "builtin:locked" }), rawMember("helper")],
      { permission_policy: "builtin:yolo" },
    );
    const outcome = await setup.podInstantiator.materializeStructured(spec, RIG_ROOT);
    expect(outcome.ok).toBe(true);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;

    // rig row carries the rig ref
    expect(setup.rigRepo.getRigPermissionPolicy(rigId)).toBe("builtin:yolo");
    // member's OWN ref on its node column; ref-less pod-mate NULL (rig ref lives on the rig)
    const refOf = (lid: string) => (db.prepare("SELECT permission_policy FROM nodes WHERE logical_id = ?").get(lid) as { permission_policy: string | null }).permission_policy;
    expect(refOf("dev.impl")).toBe("builtin:locked");
    expect(refOf("dev.helper")).toBeNull();

    // provenance: member ref WINS over rig ref → impl floor (locked), helper full_bypass (rig yolo)
    const nodeId = (lid: string) => (db.prepare("SELECT id FROM nodes WHERE logical_id = ?").get(lid) as { id: string }).id;
    expect(setup.rigRepo.getNodePolicyProvenance(nodeId("dev.impl"))).toMatchObject({ origin: "builtin", launchPosture: "floor", resolvedTarget: null });
    expect(setup.rigRepo.getNodePolicyProvenance(nodeId("dev.helper"))).toMatchObject({ origin: "builtin", launchPosture: "full_bypass", resolvedTarget: null });
  });

  it("export round-trips BOTH levels: member ref on the pod member, rig ref at the top level", async () => {
    const spec = rawSpec(
      [rawMember("impl", { permission_policy: "policies/operator-full.md" })],
      { permission_policy: "builtin:standard" },
    );
    const outcome = await setup.podInstantiator.materializeStructured(spec, RIG_ROOT);
    expect(outcome.ok).toBe(true);
    const rigId = (outcome as { ok: true; result: { rigId: string } }).result.rigId;

    const exported = setup.rigSpecExporter.exportRig(rigId) as import("../src/domain/types.js").RigSpec;
    expect(exported.permissionPolicy).toBe("builtin:standard");
    expect(exported.pods[0]!.members[0]!.permissionPolicy).toBe("policies/operator-full.md");
  });

  it("a CUSTOM surface:flag policy resolves to full_bypass at materialize with restart-stable provenance", async () => {
    const spec = rawSpec([rawMember("impl", { permission_policy: "policies/operator-full.md" })]);
    const outcome = await setup.podInstantiator.materializeStructured(spec, RIG_ROOT);
    expect(outcome.ok).toBe(true);
    const nodeId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.impl'").get() as { id: string }).id;
    const prov = setup.rigRepo.getNodePolicyProvenance(nodeId);
    expect(prov).toMatchObject({
      origin: "custom",
      launchPosture: "full_bypass", // the guard ruling's crux: custom flag CAN be full_bypass
      declaringDir: RIG_ROOT,
      resolvedTarget: `${RIG_ROOT}/policies/operator-full.md`,
      nodeRef: "policies/operator-full.md",
    });
  });
});

describe("Seam B R6 — DB-REOPEN restart proof (dev-guard ruling)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seam-b-reopen-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("a custom surface:flag=full_bypass attachment restores to full_bypass from a REOPENED database", async () => {
    const dbFile = join(dir, "daemon.sqlite");
    const db1 = createDb(dbFile);
    // identical canonical migration set as createFullTestDb, against the FILE-backED db
    migrate(db1, migrationsForFullTestDb);
    const setup1 = createTestApp(db1, { podInstantiatorFsOps: fsOps() });
    const outcome = await setup1.podInstantiator.materializeStructured(
      rawSpec([rawMember("impl", { permission_policy: "policies/operator-full.md" })]),
      RIG_ROOT,
    );
    expect(outcome.ok).toBe(true);
    const nodeId = (db1.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.impl'").get() as { id: string }).id;
    db1.close(); // ── daemon restart boundary ──

    const db2 = createDb(dbFile); // REOPEN: no in-memory RigSpec exists anymore
    const repo2 = new RigRepository(db2);
    const prov = repo2.getNodePolicyProvenance(nodeId);
    expect(prov).not.toBeNull();
    expect(prov!.launchPosture).toBe("full_bypass"); // persisted posture is restart-stable
    // AND the ruling's re-derivation: reopen + re-validate the policy from provenance alone
    const rederived = resolvePermissionPolicyAttachment(prov!.nodeRef!, prov!.declaringDir!, {
      readFile: (p) => { expect(p).toBe(`${RIG_ROOT}/policies/operator-full.md`); return CUSTOM_POLICY; },
    });
    expect(rederived.launchPosture).toBe("full_bypass");
    expect(rederived.surface).toBe("flag");
    db2.close();
  });
});

describe("Seam B R6 — resolved posture drives the REAL launch helpers on all three harnesses", () => {
  const yoloOn = { OPENRIG_YOLO: "1" } as NodeJS.ProcessEnv;
  const yoloOff = {} as NodeJS.ProcessEnv;

  it("full_bypass posture lifts a seat even with YOLO OFF (custom flag policy — the ruling)", () => {
    expect(claudePostureFlag(yoloOff, "full_bypass")).toBe("--dangerously-skip-permissions");
    expect(codexPostureArg("", yoloOff, "full_bypass")).toBe(" -s danger-full-access");
    expect(piTrust(undefined, yoloOff, "full_bypass")).toBe("approve"); // Pi = resource trust, not a permission policy
  });

  it("floor posture HOLDS a seat at the floor even with global YOLO ON (attached policy is authoritative)", () => {
    expect(claudePostureFlag(yoloOn, "floor")).toBe("--permission-mode acceptEdits");
    expect(codexPostureArg(" -p prof", yoloOn, "floor")).toBe(" -p prof");
    expect(piTrust("no-approve", yoloOn, "floor")).toBe("no-approve");
  });

  it("ABSENT posture preserves the 0.4.8.2 env behavior byte-for-byte (no policy attached)", () => {
    expect(claudePostureFlag(yoloOn)).toBe("--dangerously-skip-permissions");
    expect(claudePostureFlag(yoloOff)).toBe("--permission-mode acceptEdits");
    expect(codexPostureArg("", yoloOff)).toBe(" -s workspace-write");
    expect(piTrust(undefined, yoloOff)).toBe("no-approve");
  });
});
