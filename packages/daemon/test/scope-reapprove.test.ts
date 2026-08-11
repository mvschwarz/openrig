// OPR.0.5.0.18 — scope amend/re-stamp verb (kills the already_approved
// Status-note workaround). Design of record: ARCH-SHAPING 9d64ceb6 v2 — a lock
// is a point-in-time ATTESTATION; re-approval = a new reasoned attestation
// superseding the prior, BOTH preserved in the append-only audit log. One
// atomic verb: no unapprove window a renderer could observe.
//
// New-file suite (the existing scope-approve.test.ts floor is added-never-edited).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { identityProvenanceSchema } from "../src/db/migrations/065_identity_provenance.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";
import { ScopeApproveError, ScopeApproveService } from "../src/domain/scope/scope-approve.js";

function frontmatterOf(p: string): Record<string, unknown> {
  const content = fs.readFileSync(p, "utf8");
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  return match ? (YAML.parse(match[1]!) as Record<string, unknown>) : {};
}

describe("ScopeApproveService — re-approve/re-stamp (OPR.0.5.0.18)", () => {
  let db: Database.Database;
  let actionLog: MissionControlActionLog;
  let auditBrowse: MissionControlAuditBrowse;
  let missionsRoot: string;
  let sliceDir: string;
  let readmePath: string;

  function service(overrides?: { actionLog?: MissionControlActionLog }): ScopeApproveService {
    return new ScopeApproveService({
      missionsRoot: () => missionsRoot,
      actionLog: overrides?.actionLog ?? actionLog,
    });
  }

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, missionControlActionsSchema, identityProvenanceSchema]);
    actionLog = new MissionControlActionLog(db);
    auditBrowse = new MissionControlAuditBrowse(db);
    missionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scope-reapprove-"));
    sliceDir = path.join(missionsRoot, "release-x", "slices", "18-amend-me");
    fs.mkdirSync(sliceDir, { recursive: true });
    readmePath = path.join(sliceDir, "README.md");
    fs.writeFileSync(readmePath, "---\nid: OPR.X.18\nstatus: building\n---\n\n# The slice\nbody prose stays intact\n");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(missionsRoot, { recursive: true, force: true });
  });

  const base = {
    scopeTier: "slice" as const,
    scopePath: "release-x/slices/18-amend-me",
    actorSession: "pm@rig",
    onBehalfOf: null,
  };

  function approveOnce(scope: "spec" | "delivery" = "spec") {
    return service().approve({ ...base, approvalScope: scope });
  }

  it("re-stamps an approved spec ATOMICALLY: new stamp in frontmatter, priors count, NEW audit row with reason + provenance triple, prior attestation retrievable from the rows", () => {
    const first = approveOnce("spec");
    const result = service().approve({
      ...base,
      approvalScope: "spec",
      actorSession: "planner@rig",
      onBehalfOf: "founder",
      reApprove: true,
      reason: "PRD §3 amended after guard round 2",
    });

    // frontmatter = the CURRENT attestation + prior-count
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-by"]).toBe("planner@rig");
    expect(fm["approved-spec-at"]).toBe(result.approvedAt);
    expect(fm["approved-spec-priors"]).toBe(1);
    // body prose intact
    expect(fs.readFileSync(readmePath, "utf8")).toContain("body prose stays intact");

    // result reports the amendment
    expect(result.reApproved).toBe(true);
    expect(result.priorApprovedBy).toBe("pm@rig");
    expect(result.priorApprovedAt).toBe(first.approvedAt);

    // the append-only rows reconstruct the FULL history (both attestations)
    const rows = auditBrowse.query({ scopeId: "OPR.X.18", approvalScope: "spec" }).rows;
    expect(rows).toHaveLength(2);
    const amendment = rows.find((r) => r.actionId === result.actionId)!;
    const notes = amendment.auditNotes as Record<string, unknown>;
    expect(notes["re_approval"]).toBe(true);
    expect(notes["reason"]).toBe("PRD §3 amended after guard round 2");
    expect(notes["prior_approved_by"]).toBe("pm@rig");
    expect(notes["prior_approved_at"]).toBe(first.approvedAt);
    expect(notes["on_behalf_of"]).toBe("founder"); // authorizer
    expect(amendment.actorSession).toBe("planner@rig"); // acting agent
    expect(amendment.reason).toContain("PRD §3 amended after guard round 2");
    // the PRIOR attestation row is untouched (append-only; nothing deleted)
    const prior = rows.find((r) => r.actionId === first.actionId)!;
    expect((prior.auditNotes as Record<string, unknown>)["re_approval"]).toBeUndefined();
  });

  it("the bare re-approve refusal still fires without the flag AND its message names the sanctioned verb", () => {
    approveOnce("spec");
    let caught: ScopeApproveError | null = null;
    try {
      service().approve({ ...base, approvalScope: "spec" });
    } catch (err) {
      caught = err as ScopeApproveError;
    }
    expect(caught?.code).toBe("already_approved");
    expect(caught?.message).toMatch(/--re-approve --reason/);
  });

  it("--re-approve without --reason refuses loudly, writing NOTHING", () => {
    approveOnce("spec");
    const before = fs.readFileSync(readmePath, "utf8");
    for (const badReason of [undefined, null, "", "   "]) {
      let caught: ScopeApproveError | null = null;
      try {
        service().approve({ ...base, approvalScope: "spec", reApprove: true, reason: badReason as string | null | undefined });
      } catch (err) {
        caught = err as ScopeApproveError;
      }
      expect(caught?.code).toBe("reason_required");
    }
    expect(fs.readFileSync(readmePath, "utf8")).toBe(before); // byte-identical
    expect(auditBrowse.query({ scopeId: "OPR.X.18" }).rows).toHaveLength(1); // only the first approval
  });

  it("re-approve on a scope with NO existing stamp refuses loudly (a 're' needs a prior)", () => {
    let caught: ScopeApproveError | null = null;
    try {
      service().approve({ ...base, approvalScope: "spec", reApprove: true, reason: "nothing to supersede" });
    } catch (err) {
      caught = err as ScopeApproveError;
    }
    expect(caught?.code).toBe("nothing_to_reapprove");
    expect(auditBrowse.query({ scopeId: "OPR.X.18" }).rows).toHaveLength(0);
  });

  it("delivery-scope re-stamp works identically (same mechanics, delivery stamp fields)", () => {
    const first = approveOnce("delivery");
    const result = service().approve({
      ...base,
      approvalScope: "delivery",
      actorSession: "qa@rig",
      reApprove: true,
      reason: "delivery evidence superseded by corrected SHA",
    });
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-by"]).toBe("qa@rig");
    expect(fm["approved-at"]).toBe(result.approvedAt);
    expect(fm["approved-priors"]).toBe(1);
    expect(result.priorApprovedBy).toBe("pm@rig");
    expect(result.priorApprovedAt).toBe(first.approvedAt);
    const rows = auditBrowse.query({ scopeId: "OPR.X.18", approvalScope: "delivery" }).rows;
    expect(rows).toHaveLength(2);
  });

  it("audit-failure on a re-stamp restores the PRIOR frontmatter byte-identically (stamp + priors) and fails loud; the prior row survives", () => {
    approveOnce("spec");
    const beforeBytes = fs.readFileSync(readmePath, "utf8");
    const failingLog = {
      record: () => {
        throw new Error("disk full");
      },
    } as unknown as MissionControlActionLog;
    let caught: ScopeApproveError | null = null;
    try {
      service({ actionLog: failingLog }).approve({ ...base, approvalScope: "spec", reApprove: true, reason: "will fail" });
    } catch (err) {
      caught = err as ScopeApproveError;
    }
    expect(caught?.code).toBe("audit_write_failed");
    expect(fs.readFileSync(readmePath, "utf8")).toBe(beforeBytes); // byte-restore incl. NO priors bump
    expect(auditBrowse.query({ scopeId: "OPR.X.18" }).rows).toHaveLength(1); // first row intact, nothing deleted
  });

  it("a SECOND re-stamp increments priors to 2 and the rows reconstruct all three attestations in order", () => {
    approveOnce("spec");
    service().approve({ ...base, approvalScope: "spec", reApprove: true, reason: "amendment one" });
    service().approve({ ...base, approvalScope: "spec", actorSession: "lead@rig", reApprove: true, reason: "amendment two" });
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-priors"]).toBe(2);
    expect(fm["approved-spec-by"]).toBe("lead@rig");
    const rows = auditBrowse.query({ scopeId: "OPR.X.18", approvalScope: "spec" }).rows;
    expect(rows).toHaveLength(3);
    const reasons = rows.map((r) => (r.auditNotes as Record<string, unknown>)["reason"]).filter(Boolean);
    expect(reasons).toEqual(expect.arrayContaining(["amendment one", "amendment two"]));
  });

  it("a spec re-stamp RE-DERIVES the plan-lock artifact set (the amended PRD becomes the locked set)", () => {
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "---\nid: OPR.X.18\n---\n# PRD v1\n");
    approveOnce("spec");
    const fm1 = frontmatterOf(readmePath);
    expect(Array.isArray(fm1["locked-artifacts"])).toBe(true);
    // amend the PRD, re-stamp: the locked set is derived FRESH at the new attestation
    fs.writeFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "---\nid: OPR.X.18\n---\n# PRD v2 amended\n");
    service().approve({ ...base, approvalScope: "spec", reApprove: true, reason: "PRD amended" });
    const fm2 = frontmatterOf(readmePath);
    expect(Array.isArray(fm2["locked-artifacts"])).toBe(true);
    expect(fm2["approved-spec-priors"]).toBe(1);
  });

  it("ROUTE: reApprove + reason ARRIVE through POST /api/scope/approve (values, not just options)", async () => {
    const { Hono } = await import("hono");
    const { scopeApproveRoutes } = await import("../src/routes/scope-approve.js");
    const indexerStub = { isReady: () => true, slicesRoot: missionsRoot };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sliceIndexer" as never, indexerStub as never);
      c.set("missionControlActionLog" as never, actionLog as never);
      await next();
    });
    app.route("/api/scope/approve", scopeApproveRoutes());

    // P21 I1: the approver identity is the transport header (X-OpenRig-Session), stamped by the CLI
    // from the seat env. The legit caller provides it; body.actorSession is the transitional claim.
    const post = (body: Record<string, unknown>, session = "pm@rig") =>
      app.request("/api/scope/approve", {
        method: "POST",
        headers: { "content-type": "application/json", "X-OpenRig-Session": session },
        body: JSON.stringify(body),
      });

    const wire = { scopeTier: "slice", scopePath: base.scopePath, approvalScope: "spec", actorSession: "pm@rig" };
    expect((await post(wire)).status).toBe(201);
    // bare repeat → 409 teaching the verb
    const conflict = await post(wire);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { message: string }).message).toMatch(/--re-approve --reason/);
    // re-approve without reason → 400 reason_required (the value must ARRIVE to be judged)
    const noReason = await post({ ...wire, reApprove: true });
    expect(noReason.status).toBe(400);
    expect(((await noReason.json()) as { error: string }).error).toBe("reason_required");
    // full amendment through the wire → 201 with the amendment result fields
    const ok = await post({ ...wire, actorSession: "planner@rig", reApprove: true, reason: "wire-level amend" }, "planner@rig");
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as { reApproved: boolean; priorApprovedBy: string };
    expect(okBody.reApproved).toBe(true);
    expect(okBody.priorApprovedBy).toBe("pm@rig");
    const rows = auditBrowse.query({ scopeId: "OPR.X.18", approvalScope: "spec" }).rows;
    expect(rows.some((r) => (r.auditNotes as Record<string, unknown>)["reason"] === "wire-level amend")).toBe(true);
  });

  it("P21 I1: the signing surface derives the approver from the transport header — deliver-and-label (401/409 retired)", async () => {
    const { Hono } = await import("hono");
    const { scopeApproveRoutes } = await import("../src/routes/scope-approve.js");
    const indexerStub = { isReady: () => true, slicesRoot: missionsRoot };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sliceIndexer" as never, indexerStub as never);
      c.set("missionControlActionLog" as never, actionLog as never);
      await next();
    });
    app.route("/api/scope/approve", scopeApproveRoutes());
    const req = (headers: Record<string, string>, body: Record<string, unknown>) =>
      app.request("/api/scope/approve", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const wire = { scopeTier: "slice", scopePath: base.scopePath, approvalScope: "spec" };

    // (1) absent header + body actorSession → deliver-and-label under the claimed actor (claimed:v1), 201; NOT refused.
    const noHeader = await req({}, { ...wire, actorSession: "mallory@rig" });
    expect(noHeader.status).toBe(201);
    expect(frontmatterOf(readmePath)["provenance"]).toBe("claimed:v1");

    // (2) header present + differing body actor → the wire SUPERSEDES (re-stamp under pm@rig, transport:v1); 409 retired.
    // A re-stamp needs an explicit reason (the re-approve guard); the differing body actor is superseded, not refused.
    const mismatch = await req({ "X-OpenRig-Session": "pm@rig" }, { ...wire, actorSession: "mallory@rig", reApprove: true, reason: "wire supersedes body" });
    expect(mismatch.status).toBe(201);
    expect(frontmatterOf(readmePath)["provenance"]).toBe("transport:v1"); // wire wins; mallory@rig superseded

    // (3) header + NO body actorSession → the RECORDED approver is the transport identity, transport:v1.
    const derived = await req({ "X-OpenRig-Session": "pm@rig" }, { ...wire, reApprove: true, reason: "re-derive" });
    expect(derived.status).toBe(201);
    expect(frontmatterOf(readmePath)["provenance"]).toBe("transport:v1");
  });

  it("P21 I1 era-stamp: a DIRECT service approve (no transport chokepoint) leaves identity_provenance NULL — claimed-era, never fabricated", () => {
    // The service records the actor faithfully but does NOT invent provenance: absence IS the claimed-era
    // marker (the pre-P21/direct-caller row). No backfill, no re-label (house absent-never-fabricated).
    service().approve({ scopeTier: "slice", scopePath: base.scopePath, approvalScope: "spec", actorSession: "human@kernel" });
    const rows = auditBrowse.query({ scopeId: "OPR.X.18", approvalScope: "spec" }).rows;
    expect(rows[0]!.identityProvenance).toBeNull();
    expect(frontmatterOf(readmePath)["provenance"]).toBeUndefined();
  });

  it("REGRESSION: a plain first-time approve carries NO amendment fields (byte-identical first-approve behavior)", () => {
    const result = approveOnce("spec");
    expect(result.reApproved).toBe(false);
    const fm = frontmatterOf(readmePath);
    expect(fm["approved-spec-priors"]).toBeUndefined();
    const rows = auditBrowse.query({ scopeId: "OPR.X.18" }).rows;
    expect(rows).toHaveLength(1);
    const notes = rows[0]!.auditNotes as Record<string, unknown>;
    expect(notes["re_approval"]).toBeUndefined();
    expect(notes["reason"]).toBeUndefined();
  });
});
