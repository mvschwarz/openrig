import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../src/adapters/shell-quote.js";
// The seat activity grant's store and the only activity values a guest receives.
import { afterEach, describe, expect, it, vi } from "vitest";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { runnerGrantIssuer } from "../src/domain/runner-grant-launch.js";
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

  it.each(["claude-code", "codex", "terminal", "stub"])("does no run-binding work for an unrelated %s registration", runtime => {
    const f = fixture(); f.db.prepare("UPDATE nodes SET runtime = ? WHERE id = ?").run(runtime, f.node.id);
    const legacy = f.grants.issue({ nodeId: f.node.id, generation: f.generation, issuedBy: "legacy" });
    const session = f.sessions.registerClaimedSession(f.node.id, "dev-guest@guest-rig");
    expect(session.status).toBe("running");
    expect(f.grants.get(legacy.grantId)?.revokedAt).toBeNull();
    expect(f.db.prepare("SELECT count(*) AS n FROM activity_grants WHERE run_id IS NOT NULL").get()).toEqual({ n: 0 });
  });

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

describe("actual run grants", () => {
  function run() {
    const f = fixture();
    const session = f.db.prepare("SELECT id FROM sessions WHERE node_id = ?").get(f.node.id) as { id: string };
    f.db.prepare("INSERT INTO bindings (id,node_id,tmux_session,tmux_pane) VALUES ('b',?,'dev-guest@guest-rig','%1')").run(f.node.id);
    const anchor = { runtime: "synth", runner: 1, pane: "%1", panePid: 101 };
    f.db.prepare("UPDATE sessions SET agent_app = 'synth', agent_runner = 1 WHERE id = ?").run(session.id);
    const issue = (runId: string) => f.grants.issue({ nodeId: f.node.id, generation: f.generation, issuedBy: "launch", run: { runId, sessionId: session.id, binding: anchor } });
    return { ...f, session, anchor, issue };
  }

  it("stages a successor without replacing its predecessor; activation and late cleanup address exact grants", () => {
    const f = run();
    const first = f.issue("attempt-1");
    expect(f.grants.standing(first.grantId)).toBe("pending");
    expect(f.grants.activeForNode(f.node.id)).toBeNull();
    expect(f.grants.activate(first.grantId)).toBe(true);
    const failed = f.issue("attempt-2");
    expect(f.grants.activeForNode(f.node.id)?.grantId).toBe(first.grantId);
    f.grants.revoke({ grantId: failed.grantId }, "failed launch");
    expect(f.grants.activate(failed.grantId)).toBe(false);
    const next = f.issue("attempt-3");
    expect(f.grants.activate(next.grantId)).toBe(true);
    expect(f.grants.standing(first.grantId)).toBe("revoked");
    f.grants.revoke({ grantId: first.grantId }, "late completion");
    expect(f.grants.standing(next.grantId)).toBe("current");
    expect(JSON.stringify(f.db.prepare("SELECT * FROM activity_grants").all())).not.toContain(next.token);
  });

  it("supersedes pending credentials for the same run without touching another staged attempt", () => {
    const f = run();
    const a = f.issue("a"), b = f.issue("b"), replacement = f.issue("a");
    expect(f.grants.standing(a.grantId)).toBe("revoked");
    expect(f.grants.standing(b.grantId)).toBe("pending");
    expect(f.grants.standing(replacement.grantId)).toBe("pending");
  });

  it("does not let an older pending dispatch replace a newer active run", () => {
    const f = run();
    const older = f.issue("older"), newer = f.issue("newer");
    expect(f.grants.activate(newer.grantId)).toBe(true);
    expect(f.grants.activate(older.grantId)).toBe(false);
    expect(f.grants.standing(newer.grantId)).toBe("current");
  });

  it("activates a staged runner only at the Core session and binding cutover", () => {
    const f = run();
    const first = f.issue("first");
    f.grants.activate(first.grantId);
    const generation = f.sessions.reserveOccupantGeneration()!;
    const staged = f.grants.issue({ nodeId: f.node.id, generation, issuedBy: "launch", run: {
      runId: "staged", binding: { ...f.anchor, pane: "%2", panePid: 202 } } });
    expect(f.grants.activate(staged.grantId)).toBe(false);
    expect(f.grants.activeForNode(f.node.id)?.grantId).toBe(first.grantId);
    // The reconciler can have sampled the predecessor while the successor was staging.
    new SeatIdentityStore(f.db).upsert({ nodeId: f.node.id, verdict: "unconfirmed", evidenceSource: "pane_process",
      reason: null, sessionName: "dev-guest@guest-rig", observedAt: "2999-01-01T00:00:00.000Z",
      evidence: { registeredPane: "%1", observedPid: 101, observedPanePid: 101, observedCommand: "node", matchedLayer: null } });
    f.db.prepare("UPDATE bindings SET tmux_pane = '%2' WHERE node_id = ?").run(f.node.id);
    const successor = f.sessions.registerClaimedSession(f.node.id, "dev-guest@guest-rig", "handover", generation);
    expect(f.grants.standing(staged.grantId)).toBe("current");
    expect(f.grants.get(staged.grantId)?.sessionId).toBe(successor.id);
    expect(f.grants.standing(first.grantId)).toBe("revoked");
  });

  it("preserves explicit same-pane adoption only with retained concrete process evidence", () => {
    const f = run();
    const first = f.issue("first");
    f.grants.activate(first.grantId);
    new SeatIdentityStore(f.db).upsert({ nodeId: f.node.id, verdict: "unconfirmed", evidenceSource: "pane_process",
      reason: null, sessionName: "dev-guest@guest-rig", observedAt: new Date().toISOString(),
      evidence: { registeredPane: "%1", observedPid: 101, observedPanePid: 101, observedCommand: "node", matchedLayer: null } });
    f.sessions.registerClaimedSession(f.node.id, "dev-guest@guest-rig", "adopt");
    expect(f.grants.standing(first.grantId)).toBe("current");
    f.db.prepare("UPDATE seat_identity_verdicts SET evidence_pane_pid = 999 WHERE node_id = ?").run(f.node.id);
    expect(f.grants.standing(first.grantId)).toBe("stale");
  });

  it("revokes an adopted run on current-session stop after its concrete anchors are lost", () => {
    const f = run(); const first = f.issue("first"); f.grants.activate(first.grantId);
    new SeatIdentityStore(f.db).upsert({ nodeId: f.node.id, verdict: "unconfirmed", evidenceSource: "pane_process", reason: null,
      sessionName: "dev-guest@guest-rig", observedAt: new Date().toISOString(), evidence: { registeredPane: "%1", observedPid: 101,
        observedPanePid: 101, observedCommand: "node", matchedLayer: null } });
    const adopted = f.sessions.registerClaimedSession(f.node.id, "dev-guest@guest-rig", "adopt");
    expect(f.grants.get(first.grantId)?.sessionId).toBe(f.session.id); // immutable origin evidence
    f.db.prepare("DELETE FROM seat_identity_verdicts WHERE node_id = ?").run(f.node.id);
    f.sessions.markIntentionallyStopped(adopted.id);
    expect(f.grants.standing(first.grantId)).toBe("revoked");
  });


  it("preserves an active grant through unreadable binding evidence and recovery", () => {
    const f = run(), grant = f.issue("current"); f.grants.activate(grant.grantId);
    const prepare = f.db.prepare.bind(f.db);
    let bindingReads = 0;
    const spy = vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("SELECT s.id, s.session_name") && ++bindingReads > 1) throw new Error("observation read unavailable");
      return prepare(sql);
    }) as typeof f.db.prepare);
    try {
      f.grants.reconcileBinding(f.node.id);
      expect(f.grants.get(grant.grantId)?.revokedAt).toBeNull();
      expect(f.grants.standing(grant.grantId)).toBe("unverified"); // refusal is not revocation
    } finally { spy.mockRestore(); }
    expect(f.grants.standing(grant.grantId)).toBe("current");
  });

  it("does not fail claimed registration because optional grant reconciliation cannot read", () => {
    const f = run();
    const spy = vi.spyOn(ActivityGrantStore.prototype, "reconcileBinding").mockImplementation(() => { throw new Error("grant table unavailable"); });
    try {
      const claimed = f.sessions.registerClaimedSession(f.node.id, "dev-guest@guest-rig");
      expect(claimed.status).toBe("running");
      expect(f.sessions.currentOccupantTenure(f.node.id)).toBeTruthy();
    } finally { spy.mockRestore(); }
  });


  it("does not activate an older pending grant when the newer active binding cannot be read", () => {
    const f = run(), older = f.issue("older"), newer = f.issue("newer"); f.grants.activate(newer.grantId);
    const prepare = f.db.prepare.bind(f.db); let bindingReads = 0;
    const spy = vi.spyOn(f.db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("SELECT s.id, s.session_name") && ++bindingReads === 2) throw new Error("newer binding unreadable");
      return prepare(sql);
    }) as typeof f.db.prepare);
    try { expect(f.grants.activate(older.grantId)).toBe(false); }
    finally { spy.mockRestore(); }
    expect(f.grants.standing(newer.grantId)).toBe("current");
    expect(f.grants.standing(older.grantId)).toBe("pending");
  });

  it.each(["missing", "stale"])("preserves adopted authority when identity evidence is %s, then recovers", missing => {
    const f = run(), grant = f.issue("adopted"); f.grants.activate(grant.grantId);
    const evidence = { nodeId: f.node.id, verdict: "unconfirmed" as const, evidenceSource: "pane_process" as const,
      reason: null, sessionName: "dev-guest@guest-rig", observedAt: new Date().toISOString(),
      evidence: { registeredPane: "%1", observedPid: 101, observedPanePid: 101, observedCommand: "node", matchedLayer: null } };
    new SeatIdentityStore(f.db).upsert(evidence);
    f.sessions.registerClaimedSession(f.node.id, "dev-guest@guest-rig", "adopt");
    f.db.prepare("DELETE FROM seat_identity_verdicts WHERE node_id = ?").run(f.node.id);
    if (missing === "stale") new SeatIdentityStore(f.db).upsert({ ...evidence, sessionName: "prior-session" });
    f.grants.reconcileBinding(f.node.id);
    f.grants.revokeForSession(f.session.id, "old_session_stopped");
    expect(f.grants.get(grant.grantId)?.revokedAt).toBeNull();
    expect(f.grants.standing(grant.grantId)).toBe("unverified");
    new SeatIdentityStore(f.db).upsert(evidence);
    expect(f.grants.standing(grant.grantId)).toBe("current");
  });


  it.each(["anchor", "pid", "generation"] as const)("does not issue weaker authority when %s is missing", async missing => {
    const f = run();
    if (missing === "generation") f.db.prepare("DELETE FROM occupant_tenures WHERE node_id = ?").run(f.node.id);
    const setSessionEnv = vi.fn(async () => {});
    const begin = runnerGrantIssuer(f.db, { getPanePid: async () => missing === "pid" ? null : 101,
      setSessionEnv, unsetSessionEnv: async () => {} });
    await expect(begin({ nodeId: f.node.id, tmuxSession: "dev-guest@guest-rig", tmuxPane: missing === "anchor" ? null : "%1" } as never,
      "synth", "unbound", 1)).rejects.toThrow(/authority needs/);
    expect(setSessionEnv).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT count(*) AS n FROM activity_grants").get()).toEqual({ n: 0 });
  });

  it.each(["read", "partial read", "remove"] as const)("executes unbound with the original install token when private credential %s fails", async failure => {
    const f = run(), dir = mkdtempSync(join(tmpdir(), "grant-fallback-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "tmux"), '#!/bin/sh\ncase "$1" in show-environment) [ "$TEST_FAIL" = read ] && exit 1; printf "%s=%s\\n" "$TEST_KEY" "$TEST_PRIVATE"; [ "$TEST_FAIL" != "partial read" ];; set-environment) [ "$TEST_FAIL" != remove ];; *) exit 1;; esac\n');
    chmodSync(join(dir, "tmux"), 0o700);
    let token = "", key = "";
    const begin = runnerGrantIssuer(f.db, { getPanePid: async () => 101,
      setSessionEnv: async (_session, name, value) => { key = name; token = value; }, unsetSessionEnv: async () => {} });
    const launch = await begin({ nodeId: f.node.id, tmuxSession: "dev-guest@guest-rig", tmuxPane: "%1" } as never, "synth", "not-claimed", 1);
    const program = `printf '%s' "$OPENRIG_ACTIVITY_HOOK_TOKEN|\${OPENRIG_RUN_ID-unset}|$OPENRIG_OCCUPANT_GENERATION"`;
    const result = spawnSync("/bin/sh", ["-xc", launch.wrap(`/bin/sh -c ${shellQuote(program)}`)], { encoding: "utf8", env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "legacy-install", OPENRIG_RUN_ID: "stale-run",
      OPENRIG_OCCUPANT_GENERATION: "legacy-generation", TEST_FAIL: failure, TEST_KEY: key, TEST_PRIVATE: token,
    } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("legacy-install|unset|legacy-generation");
    expect(result.stderr).not.toContain(token);
    expect(result.stderr).toContain("using existing install-token reporting");
    await launch.finish(false);
  });

  it.each([false, true])("preserves an adopted grant when declaration is unavailable, without hiding positive replacement=%s", replaced => {
    const f = run(), grant = f.issue("adopted"); f.grants.activate(grant.grantId);
    f.db.prepare("DELETE FROM seat_identity_verdicts WHERE node_id = ?").run(f.node.id);
    f.sessions.registerClaimedSession(f.node.id, "dev-guest@guest-rig", "adopt");
    expect(f.grants.get(grant.grantId)?.revokedAt).toBeNull();
    expect(f.grants.standing(grant.grantId)).toBe("unverified");
    if (replaced) {
      f.db.prepare("UPDATE bindings SET tmux_pane = '%2' WHERE node_id = ?").run(f.node.id);
      f.grants.reconcileBinding(f.node.id);
      expect(f.grants.standing(grant.grantId)).toBe("revoked");
      return;
    }
    new SeatIdentityStore(f.db).upsert({ nodeId: f.node.id, verdict: "unconfirmed", evidenceSource: "pane_process",
      reason: null, sessionName: "dev-guest@guest-rig", observedAt: new Date().toISOString(),
      evidence: { registeredPane: "%1", observedPid: 101, observedPanePid: 101, observedCommand: "node", matchedLayer: null } });
    f.grants.reconcileBinding(f.node.id);
    expect(f.grants.standing(grant.grantId)).toBe("current");
  });

  it("preserves authority through an unavailable occupant generation and recovery", () => {
    const f = run(), grant = f.issue("current"); f.grants.activate(grant.grantId);
    const spy = vi.spyOn(SessionRegistry.prototype, "currentOccupantTenure").mockReturnValue(null);
    try {
      f.grants.reconcileBinding(f.node.id);
      expect(f.grants.get(grant.grantId)?.revokedAt).toBeNull();
      expect(f.grants.standing(grant.grantId)).toBe("unverified");
    } finally { spy.mockRestore(); }
    expect(f.grants.standing(grant.grantId)).toBe("current");
  });

  it("records a Core-selected runner declaration on a previously registered empty launch row", async () => {
    const f = run();
    f.db.prepare("UPDATE sessions SET agent_app = NULL, agent_runner = NULL WHERE id = ?").run(f.session.id);
    const begin = runnerGrantIssuer(f.db, { getPanePid: async () => 101, setSessionEnv: async () => {}, unsetSessionEnv: async () => {} });
    const launch = await begin({ nodeId: f.node.id, tmuxSession: "dev-guest@guest-rig", tmuxPane: "%1" } as never, "synth", "registered-first", 1);
    expect(() => launch.dispatched()).not.toThrow();
    expect(f.grants.standing(launch.grantId)).toBe("current");
    expect(f.db.prepare("SELECT agent_app, agent_runner FROM sessions WHERE id = ?").get(f.session.id)).toEqual({ agent_app: "synth", agent_runner: 1 });
    await launch.finish(true);
  });

  it("activates an earlier staged grant after a later predecessor rotation becomes stale at cutover", () => {
    const f = run(); const first = f.issue("first"); f.grants.activate(first.grantId);
    const generation = f.sessions.reserveOccupantGeneration()!;
    const staged = f.grants.issue({ nodeId: f.node.id, generation, issuedBy: "launch", run: { runId: "staged",
      binding: { ...f.anchor, pane: "%2", panePid: 202 } } });
    const rotation = f.issue("predecessor-rotation");
    expect(f.grants.activate(rotation.grantId)).toBe(true);
    f.db.prepare("UPDATE bindings SET tmux_pane = '%2' WHERE node_id = ?").run(f.node.id);
    f.sessions.registerClaimedSession(f.node.id, "dev-guest@guest-rig", "handover", generation);
    expect(f.grants.standing(staged.grantId)).toBe("current");
    expect(f.grants.standing(rotation.grantId)).toBe("revoked");
  });

  it("revokes the current run on an explicit stop or observed exit", () => {
    const f = run();
    const first = f.issue("first");
    f.grants.activate(first.grantId);
    f.sessions.markIntentionallyStopped(f.session.id);
    expect(f.grants.standing(first.grantId)).toBe("revoked");
  });

  it("distributes privately, and late failed cleanup cannot revoke the replacement", async () => {
    const f = run();
    const env = new Map<string, string>();
    const tmux = { getPaneCommand: async () => "bash", getPanePid: async () => 101,
      setSessionEnv: async (_session: string, key: string, value: string) => { env.set(key, value); },
      unsetSessionEnv: async (_session: string, key: string) => { env.delete(key); } };
    const begin = runnerGrantIssuer(f.db, tmux);
    const binding = { nodeId: f.node.id, tmuxSession: "dev-guest@guest-rig", tmuxPane: "%1" } as never;
    const first = await begin(binding, "synth", "first", 1);
    const token = [...env.values()][0]!;
    expect(first.wrap("node runner.js")).not.toContain(token);
    expect(first.wrap("node runner.js")).toContain("set +x");
    expect(first.wrap("node runner.js")).toContain("set-environment");
    first.dispatched();
    const second = await begin(binding, "synth", "second", 1);
    second.dispatched();
    await first.finish(false);
    expect(f.grants.activeForNode(f.node.id)?.runId).toBe("second");
    expect(env.size).toBe(1);
  });

  it("preserves the active predecessor when private credential distribution fails after its write", async () => {
    const f = run();
    const first = f.issue("first"); f.grants.activate(first.grantId);
    const env = new Map<string, string>();
    const begin = runnerGrantIssuer(f.db, { getPanePid: async () => 101,
      setSessionEnv: async (_session: string, key: string, token: string) => { env.set(key, token); throw new Error("private transport unavailable"); },
      unsetSessionEnv: async (_session: string, key: string) => { env.delete(key); } });
    await expect(begin({ nodeId: f.node.id, tmuxSession: "dev-guest@guest-rig", tmuxPane: "%1" } as never,
      "synth", "failed", 1)).rejects.toThrow("credential distribution failed");
    expect(f.grants.standing(first.grantId)).toBe("current");
    expect(f.grants.activeForNode(f.node.id)?.runId).toBe("first");
    expect(env.size).toBe(0);
  });

  it("keeps the existing staged /bin/sh launch path for non-POSIX parent shells", async () => {
    const f = run();
    const begin = runnerGrantIssuer(f.db, { getPanePid: async () => 101, setSessionEnv: async () => {}, unsetSessionEnv: async () => {} });
    const launch = await begin({ nodeId: f.node.id, tmuxSession: "dev-guest@guest-rig", tmuxPane: "%1" } as never,
      "synth", "shell-independent-bootstrap", 1);
    expect(launch.wrap("node runner.js")).toMatch(/^\/bin\/sh -c /);
    await launch.finish(false);
  });

  it("consumes the private tmux environment before exec without token text in argv or tracing", async () => {
    const f = run();
    const dir = mkdtempSync(join(tmpdir(), "run-grant-transfer-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const marker = join(dir, "consumed");
    writeFileSync(join(dir, "tmux"), '#!/bin/sh\ncase "$1" in show-environment) printf "%s=%s\\n" "$TEST_KEY" "$TEST_PRIVATE";; set-environment) touch "$TEST_REMOVED";; *) exit 1;; esac\n');
    chmodSync(join(dir, "tmux"), 0o700);
    let token = "", key = "";
    const begin = runnerGrantIssuer(f.db, { getPanePid: async () => 101,
      setSessionEnv: async (_session, name, value) => { key = name; token = value; }, unsetSessionEnv: async () => {} });
    const launch = await begin({ nodeId: f.node.id, tmuxSession: "dev-guest@guest-rig", tmuxPane: "%1" } as never, "synth", "opaque-run", 1);
    const program = `const t=process.env.OPENRIG_ACTIVITY_HOOK_TOKEN; process.stdout.write(JSON.stringify({bound:t===process.env.TEST_PRIVATE,run:process.env.OPENRIG_RUN_ID,generation:process.env.OPENRIG_OCCUPANT_GENERATION,argvLeak:process.argv.some(a=>a.includes(t))}));`;
    const command = launch.wrap(`${shellQuote(process.execPath)} -e ${shellQuote(program)}`);
    expect(command).not.toContain(token);
    const result = spawnSync("/bin/sh", ["-xc", command], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
      OPENRIG_ACTIVITY_HOOK_TOKEN: "legacy-install", OPENRIG_OCCUPANT_GENERATION: "stale-shell", TEST_KEY: key, TEST_PRIVATE: token, TEST_REMOVED: marker } });
    expect(result.status, result.error?.message ?? result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ bound: true, run: "opaque-run", generation: f.generation, argvLeak: false });
    expect(result.stderr).not.toContain(token);
    expect(existsSync(marker)).toBe(true);
    await launch.finish(false);
  });

  it("refuses activation and standing after concrete pane or recorded runtime changes", () => {
    const f = run();
    const first = f.issue("first");
    expect(f.grants.activate(first.grantId)).toBe(true);
    const staged = f.issue("staged");
    f.db.prepare("UPDATE bindings SET tmux_pane = '%2' WHERE node_id = ?").run(f.node.id);
    expect(f.grants.standing(first.grantId)).toBe("stale");
    expect(f.grants.activate(staged.grantId)).toBe(false);
    f.db.prepare("UPDATE bindings SET tmux_pane = '%1' WHERE node_id = ?").run(f.node.id);
    f.db.prepare("UPDATE sessions SET agent_runner = 0 WHERE id = ?").run(f.session.id);
    expect(f.grants.standing(first.grantId)).toBe("stale");
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
