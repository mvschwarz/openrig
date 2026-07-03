// OPR.0.4.3.06 — startup proof (challenge-verified orientation) honesty matrix.
//
// The keystone invariant: `oriented=verified` is set ONLY by a correct,
// identity-bound, this-launch, content-correct proof. A bare ACK / empty /
// wrong / replayed / identity-mismatched proof is REJECTED (append-only) and
// NEVER renders verified. `ready` (startup_status) never implies orientation.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import {
  issueStartupChallenge,
  verifyStartupProof,
  deriveOriented,
  computeContractHash,
  computeExpectedAnswer,
} from "../src/domain/startup-proof.js";
import { activityRoutes } from "../src/routes/activity.js";

const CONTRACT = JSON.stringify([{ path: "role.md", effectiveId: "guidance/role.md" }]);

function setup() {
  const db = createFullTestDb();
  const eventBus = new EventBus(db);
  const store = new AgentActivityStore({ db, eventBus });
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const rig = rigRepo.createRig("test-rig");
  const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "codex" });
  const sessionName = "dev-worker@test-rig";
  sessionRegistry.registerSession(node.id, sessionName);
  return { db, eventBus, store, rigId: rig.id, nodeId: node.id, sessionName };
}

describe("startup-proof — issue + verify", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it("VERIFIED sets oriented=verified (append-only accepted evidence)", () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    // Before a proof: challenged but not proven.
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");

    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: ctx.sessionName,
      challengeId: challenge.challengeId,
      answer: challenge.expectedAnswer,
    });
    expect(result.ok).toBe(true);
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("verified");

    // Accepted evidence is a distinct append-only event.
    const verified = ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'node.startup_proof_verified'").get(ctx.nodeId) as { n: number };
    expect(verified.n).toBe(1);
  });

  it("challenge prompt includes an executable authenticated hook submission", () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    expect(challenge.promptBlock).toContain("rig startup-proof submit");
    expect(challenge.promptBlock).toContain(`--challenge-id ${challenge.challengeId}`);
    expect(challenge.promptBlock).toContain(`--answer ${challenge.expectedAnswer}`);
  });

  it("DELIVERY-READY is not orientation: a challenged-but-unproven node is oriented=missing", () => {
    issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    // startup_status may be ready (delivery) — orientation is independent.
    ctx.eventBus.emit({ type: "node.startup_ready", rigId: ctx.rigId, nodeId: ctx.nodeId });
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");
  });

  it("WRONG (plausible-but-content-wrong) answer is rejected; oriented NOT set", () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: ctx.sessionName,
      challengeId: challenge.challengeId,
      answer: "0".repeat(32), // right shape, wrong content
    });
    expect(result).toMatchObject({ ok: false, code: "contract_mismatch" });
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("rejected");
    const rejected = ctx.db.prepare("SELECT payload FROM events WHERE node_id = ? AND type = 'node.startup_proof_rejected'").get(ctx.nodeId) as { payload: string };
    expect(JSON.parse(rejected.payload).reason).toBe("contract_mismatch");
  });

  it("BARE ACK is presence-only, NEVER proof (keystone)", () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    for (const ack of ["", "  ", "ack", "ready", "ok", "DONE", "oriented"]) {
      const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
        sessionName: ctx.sessionName,
        challengeId: challenge.challengeId,
        answer: ack,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("bare_ack");
    }
    // A bare ACK must never render oriented/verified.
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("rejected");
  });

  it("REPLAY of a prior launch's valid answer is rejected as stale", () => {
    const first = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    // A second launch issues a NEW challenge (the latest governs).
    const second = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    expect(second.challengeId).not.toBe(first.challengeId);

    const replay = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: ctx.sessionName,
      challengeId: first.challengeId, // stale
      answer: first.expectedAnswer,
    });
    expect(replay).toMatchObject({ ok: false, code: "challenge_stale" });
    // A stale replay carries the OLD challengeId, so it does not downgrade the
    // CURRENT launch's orientation — it stays honestly `missing` (awaiting a
    // valid proof for the current challenge). The rejection is still audited.
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");
    const rejected = ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'node.startup_proof_rejected'").get(ctx.nodeId) as { n: number };
    expect(rejected.n).toBe(1);

    // The current launch's correct proof still verifies.
    const fresh = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: ctx.sessionName,
      challengeId: second.challengeId,
      answer: second.expectedAnswer,
    });
    expect(fresh.ok).toBe(true);
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("verified");
  });

  it("IDENTITY mismatch (unknown session) is rejected; no node state projected", () => {
    issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: "nope@ghost-rig",
      challengeId: "whatever",
      answer: "whatever",
    });
    expect(result).toMatchObject({ ok: false, code: "identity_unbound" });
    // The real node stays challenged/missing — no rejection attributed to it.
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");
  });

  // rev1-r2 BLOCKING keystone: resolveSession prioritizes nodeId and does NOT
  // cross-check sessionName. A proof carrying node-a's id (+ node-a's CORRECT
  // answer) but a DIFFERENT known seat's sessionName must NOT false-verify
  // node-a — it must bind to BOTH.
  it("IDENTITY MISMATCH: nodeId=node-a + sessionName=node-b is rejected; node-a NOT false-verified", () => {
    const challengeA = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    // A second real managed seat in the same rig.
    const nodeB = new RigRepository(ctx.db).addNode(ctx.rigId, "dev.worker-b", { runtime: "codex" });
    const sessionNameB = "dev-worker-b@test-rig";
    new SessionRegistry(ctx.db).registerSession(nodeB.id, sessionNameB);

    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      nodeId: ctx.nodeId,        // node-a
      sessionName: sessionNameB, // node-b — CONFLICT
      challengeId: challengeA.challengeId,
      answer: challengeA.expectedAnswer, // node-a's correct answer
    });
    expect(result).toMatchObject({ ok: false, code: "identity_mismatch" });
    // node-a is NOT verified (keystone) and NOT downgraded to rejected — a
    // cross-seat proof must not touch its projection at all.
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");
    expect(deriveOriented(ctx.db, nodeB.id)).toBe("n-a");
    const rejected = ctx.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'node.startup_proof_rejected'").get() as { n: number };
    expect(rejected.n).toBe(0);
  });

  it("MATCHING nodeId + sessionName still verifies (no regression)", () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      nodeId: ctx.nodeId,
      sessionName: ctx.sessionName,
      challengeId: challenge.challengeId,
      answer: challenge.expectedAnswer,
    });
    expect(result.ok).toBe(true);
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("verified");
  });

  it("a proof against a node that was NEVER challenged is rejected without projecting rejected", () => {
    // No issueStartupChallenge → resumed/non-agent seat.
    const result = verifyStartupProof({ store: ctx.store, eventBus: ctx.eventBus }, {
      sessionName: ctx.sessionName,
      challengeId: "x",
      answer: "y",
    });
    expect(result).toMatchObject({ ok: false, code: "challenge_stale" });
    // No challenge issued → oriented stays honestly n-a (no false-downgrade).
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("n-a");
  });
});

describe("startup-proof — non-proof signals never satisfy proof", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });
  afterEach(() => ctx.db.close());

  it("ready / activity / session_identity / held do NOT set oriented", () => {
    issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    ctx.eventBus.emit({ type: "node.startup_ready", rigId: ctx.rigId, nodeId: ctx.nodeId });
    ctx.eventBus.emit({ type: "agent.session_identity", rigId: ctx.rigId, nodeId: ctx.nodeId, sessionName: ctx.sessionName, runtime: "codex", sessionId: "thread-1", provenance: "hook" });
    ctx.eventBus.emit({ type: "agent.activity", rigId: ctx.rigId, nodeId: ctx.nodeId, sessionName: ctx.sessionName, runtime: "codex", activity: { state: "running", reason: "active", evidenceSource: "runtime_hook", sampledAt: new Date().toISOString(), eventAt: new Date().toISOString(), fallback: false, stale: false } });
    // None of these are startup proof → still missing (not verified).
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("missing");
  });

  it("a resumed restore (never challenged) projects oriented=n-a even with runtime activity", () => {
    ctx.eventBus.emit({ type: "node.startup_ready", rigId: ctx.rigId, nodeId: ctx.nodeId });
    ctx.eventBus.emit({ type: "agent.activity", rigId: ctx.rigId, nodeId: ctx.nodeId, sessionName: ctx.sessionName, runtime: "codex", activity: { state: "running", reason: "active", evidenceSource: "runtime_hook", sampledAt: new Date().toISOString(), eventAt: new Date().toISOString(), fallback: false, stale: false } });
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("n-a");
  });
});

describe("startup-proof — pure derivations", () => {
  it("expected answer is bound to BOTH challengeId (launch) and contractHash (content)", () => {
    const hashA = computeContractHash("contract-A");
    const hashB = computeContractHash("contract-B");
    expect(computeExpectedAnswer("c1", hashA)).not.toBe(computeExpectedAnswer("c2", hashA)); // launch-bound
    expect(computeExpectedAnswer("c1", hashA)).not.toBe(computeExpectedAnswer("c1", hashB)); // content-bound
    expect(computeExpectedAnswer("c1", hashA)).toBe(computeExpectedAnswer("c1", hashA)); // deterministic
  });
});

describe("startup-proof — authenticated route ingestion", () => {
  let ctx: ReturnType<typeof setup>;
  let app: Hono;
  const TOKEN = "test-hook-token";
  beforeEach(() => {
    ctx = setup();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("agentActivityStore" as never, ctx.store as never);
      c.set("activityHookToken" as never, TOKEN as never);
      c.set("eventBus" as never, ctx.eventBus as never);
      c.set("sessionRegistry" as never, new SessionRegistry(ctx.db) as never);
      await next();
    });
    app.route("/", activityRoutes);
  });
  afterEach(() => ctx.db.close());

  async function post(body: unknown, token = TOKEN) {
    return app.request("/hooks", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it("rejects an unauthenticated startup_proof (401)", async () => {
    const res = await post({ eventFamily: "startup_proof" }, "wrong");
    expect(res.status).toBe(401);
  });

  it("verifies a correct proof via the hook (200 oriented=verified)", async () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const res = await post({ eventFamily: "startup_proof", sessionName: ctx.sessionName, challengeId: challenge.challengeId, answer: challenge.expectedAnswer });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, oriented: "verified" });
    expect(deriveOriented(ctx.db, ctx.nodeId)).toBe("verified");
  });

  it("rejects a bare ACK via the hook (422 bare_ack) and never orients", async () => {
    const challenge = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const res = await post({ eventFamily: "startup_proof", sessionName: ctx.sessionName, challengeId: challenge.challengeId, answer: "ack" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, code: "bare_ack" });
    expect(deriveOriented(ctx.db, ctx.nodeId)).not.toBe("verified");
  });

  it("rejects an unknown identity via the hook (404 identity_unbound)", async () => {
    const res = await post({ eventFamily: "startup_proof", sessionName: "ghost@nope", challengeId: "x", answer: "y" });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "identity_unbound" });
  });

  it("rejects a nodeId/sessionName mismatch via the hook (404 identity_mismatch), no false-verify", async () => {
    const challengeA = issueStartupChallenge(ctx.eventBus, { rigId: ctx.rigId, nodeId: ctx.nodeId, contractSource: CONTRACT });
    const nodeB = new RigRepository(ctx.db).addNode(ctx.rigId, "dev.worker-b", { runtime: "codex" });
    new SessionRegistry(ctx.db).registerSession(nodeB.id, "dev-worker-b@test-rig");
    const res = await post({ eventFamily: "startup_proof", nodeId: ctx.nodeId, sessionName: "dev-worker-b@test-rig", challengeId: challengeA.challengeId, answer: challengeA.expectedAnswer });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, code: "identity_mismatch" });
    expect(deriveOriented(ctx.db, ctx.nodeId)).not.toBe("verified");
  });
});
