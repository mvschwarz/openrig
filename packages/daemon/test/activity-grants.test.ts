// The seat activity grant's store and the only activity values a guest receives.
import { afterEach, describe, expect, it } from "vitest";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ActivityGrantStore, grantGeneration, guestActivityEnv } from "../src/domain/activity-grants.js";
import { createFullTestDb } from "./helpers/test-app.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  const db = createFullTestDb();
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("guest-rig");
  const node = rigs.addNode(rig.id, "dev.guest", { runtime: "synth" });
  const sessions = new SessionRegistry(db);
  sessions.registerSession(node.id, "dev-guest@guest-rig");
  const generation = sessions.currentOccupantTenure(node.id)!.generationUuid;
  const ledger = { current: (id: string) => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    registered: (id: string, g: string) => sessions.isOccupantGenerationRegistered(id, g) };
  return { db, node, sessions, generation, ledger, grants: new ActivityGrantStore(db) };
}

describe("issuing a seat activity grant", () => {
  it("returns the token once and stores only its sha256", () => {
    const f = fixture();
    const issued = f.grants.issue({ nodeId: f.node.id, generation: f.generation, issuedBy: "driver@test" });
    expect(issued.token).toMatch(/^oag_[0-9a-f]{64}$/);
    expect(issued).toMatchObject({ nodeId: f.node.id, generation: f.generation, issuedBy: "driver@test", revokedAt: null });
    const rows = f.db.prepare("SELECT * FROM activity_grants").all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(issued.token);
    expect(f.grants.get(issued.grantId)).not.toHaveProperty("token");
    expect(f.grants.authenticate(issued.token)?.grantId).toBe(issued.grantId);
  });

  it("keeps one active grant per seat: issuing again revokes the earlier one", () => {
    const f = fixture();
    const first = f.grants.issue({ nodeId: f.node.id, generation: f.generation, issuedBy: "driver@test" });
    const second = f.grants.issue({ nodeId: f.node.id, generation: f.generation, issuedBy: "driver@test" });
    expect(f.grants.get(first.grantId)).toMatchObject({ revokeReason: "reissued" });
    expect(f.grants.get(first.grantId)?.revokedAt).not.toBeNull();
    expect(f.grants.activeForNode(f.node.id)?.grantId).toBe(second.grantId);
  });

  it("revokes by grant or by seat, once", () => {
    const f = fixture();
    const issued = f.grants.issue({ nodeId: f.node.id, generation: f.generation, issuedBy: "driver@test" });
    expect(f.grants.revoke({ nodeId: f.node.id }, "stopped")).toBe(1);
    expect(f.grants.revoke({ grantId: issued.grantId }, "again")).toBe(0);
    expect(f.grants.get(issued.grantId)).toMatchObject({ revokeReason: "stopped" });
    expect(f.grants.activeForNode(f.node.id)).toBeNull();
    // A revoked grant still authenticates, so the ingress can say it was revoked.
    expect(f.grants.authenticate(issued.token)?.revokedAt).not.toBeNull();
  });

  it("refuses an unknown seat and blank input, and knows no other token", () => {
    const f = fixture();
    expect(() => f.grants.issue({ nodeId: "no-such-node", generation: f.generation, issuedBy: "driver@test" })).toThrow(/No seat/);
    expect(() => f.grants.issue({ nodeId: f.node.id, generation: " ", issuedBy: "driver@test" })).toThrow(/needs a node/);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM activity_grants").get()).toEqual({ n: 0 });
    for (const token of [null, "", "install-token", `oag_${"0".repeat(64)}`]) expect(f.grants.authenticate(token)).toBeNull();
  });

  it("places a grant against the occupant ledger: current, stale after replacement, pending before registration", () => {
    const f = fixture();
    const current = f.grants.issue({ nodeId: f.node.id, generation: f.generation, issuedBy: "driver@test" });
    expect(grantGeneration(current, f.ledger)).toBe("current");
    const reserved = f.sessions.reserveOccupantGeneration()!;
    const next = f.grants.issue({ nodeId: f.node.id, generation: reserved, issuedBy: "driver@test" });
    expect(grantGeneration(next, f.ledger)).toBe("pending");
    f.sessions.registerSession(f.node.id, "dev-guest@guest-rig", "handover", reserved);
    expect(grantGeneration(next, f.ledger)).toBe("current");
    expect(grantGeneration(current, f.ledger)).toBe("stale");
  });
});

describe("the activity values a guest receives", () => {
  const grant = { token: "oag_guest", nodeId: "node-1", generation: "gen-1" };

  it("are exactly the grant, the seat and a guest-reachable origin", () => {
    expect(guestActivityEnv(grant, "dev-guest@guest-rig", "http://host.containers.internal:7433/")).toEqual({
      OPENRIG_URL: "http://host.containers.internal:7433", OPENRIG_ACTIVITY_HOOK_TOKEN: "oag_guest", OPENRIG_NODE_ID: "node-1",
      OPENRIG_SESSION_NAME: "dev-guest@guest-rig", OPENRIG_OCCUPANT_GENERATION: "gen-1" });
  });

  it.each(["not a url", "ftp://host:7433", "http://host:7433/api/activity", "http://user:secret@host:7433", "http://host:7433/?a=1", "http://host:7433/#x"])(
    "refuse %s as the guest's address", (address) => {
      expect(() => guestActivityEnv(grant, "dev-guest@guest-rig", address)).toThrow(/guest's activity address/);
    });
});
