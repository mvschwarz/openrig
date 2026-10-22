import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { bootKernelIfNeeded, classifyManagedKernel } from "../src/domain/kernel-boot.js";
import { restoreExistingRigUnattended } from "../src/domain/existing-rig-restore.js";
import { noServerTerminal } from "./helpers/no-server-terminal.js";
import { snapshotMatchesCurrentOccupants } from "../src/domain/rehydrate-eligibility.js";

const databases: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

// Real seat stop, down/snapshot, up and restore; terminal/provider effects are inert.
async function fixture(mode: "token" | "no-token" | "fresh-policy" = "token", rigName = "fresh-stopped") {
  const db = createFullTestDb(); databases.push(db);
  const h = createTestApp(db), { rigRepo, sessionRegistry: sessions, snapshotCapture, tmuxAdapter: tmux } = h;
  const rig = rigRepo.createRig(rigName);
  const paused = rigRepo.addNode(rig.id, "paused", { runtime: "codex" });
  const previous = sessions.registerSession(paused.id, `paused@${rigName}`);
  sessions.updateStatus(previous.id, "running");
  const others = ["one", "two", "three"].map(name => {
    const node = rigRepo.addNode(rig.id, name, { runtime: "claude-code" });
    const session = sessions.registerSession(node.id, `${name}@${rigName}`);
    sessions.updateStatus(session.id, "running");
    sessions.updateResumeToken(session.id, "claude_name", `native-${name}`, "hook");
    return { node, session };
  });
  const predecessorSnapshot = snapshotCapture.captureSnapshot(rig.id, "manual");
  sessions.updateStatus(previous.id, "exited");
  const current = sessions.registerSession(paused.id, `paused@${rigName}`, "fresh");
  sessions.updateStatus(current.id, "running");
  if (mode !== "no-token") sessions.updateResumeToken(current.id, "codex_id", "00000000-0000-4000-8000-000000000002", "hook");
  if (mode === "fresh-policy") db.prepare("UPDATE sessions SET restore_policy='relaunch_fresh' WHERE id=?").run(current.id);
  sessions.updateBinding(paused.id, { tmuxSession: current.sessionName, tmuxPane: "%42" });
  const generation = sessions.currentOccupantTenure(paused.id)!.generationUuid;
  const freshEvent = { nodeId: paused.id, sessionId: current.id, newGeneration: generation };
  db.prepare("INSERT INTO events(rig_id,node_id,type,payload) VALUES (?,?,'seat.fresh_launched',?)").run(rig.id, paused.id, JSON.stringify(freshEvent));
  const earlierRunning = snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
  const post = (url: string, body: unknown = {}) => h.app.request(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  tmux.probeSession = vi.fn(async () => ({ state: "present" as const }));
  const stopped = await post(`/api/seat/stop/${encodeURIComponent(current.sessionName)}`, { reason: "keep this current seat stopped" });
  expect(stopped.status).toBe(200);
  expect(await stopped.json()).toMatchObject({ ok: true, sessionId: current.id });
  const down = await post("/api/down", { rigId: rig.id, force: true });
  expect(down.status).toBe(200);
  const { snapshotId, errors } = await down.json(); expect(errors).toEqual([]);
  tmux.probeSession = vi.fn(async () => ({ state: "absent" as const }));
  vi.mocked(tmux.createSession).mockClear(); vi.mocked(tmux.sendText).mockClear();
  const snapshot = h.snapshotRepo.getSnapshot(snapshotId)!;
  expect(snapshot.data.activeOccupantsByNode?.[paused.id]).toEqual({ kind: "absent" });
  expect(snapshot.data.sessions.find(s => s.id === current.id)?.status).toBe("exited");
  expect(sessions.currentOccupantTenure(paused.id)?.generationUuid).toBe(generation);
  return { ...h, db, rig, paused, current, previous, generation, freshEvent, others, snapshot, earlierRunning, predecessorSnapshot, post };
}

describe("a deliberately stopped current fresh seat does not block its siblings", () => {
  it("daemon start still skips a kernel with a deliberately stopped current fresh seat", async () => {
    const f = await fixture("token", "kernel");
    const restoreLostKernel = vi.fn(async () => ({ errors: [] as string[] }));
    const restore = vi.spyOn(f.restoreOrchestrator, "restore");
    expect(classifyManagedKernel(f.rigRepo, f.sessionRegistry)).toEqual({ kind: "stopped" });
    const tracker = await bootKernelIfNeeded({
      rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, eventBus: f.eventBus,
      bootstrapOrchestrator: f.bootstrapOrchestrator, specsDir: "/tmp", cwdOverride: "/tmp",
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }), log: () => {},
      degradedTimeoutMs: 0, restoreLostKernel,
    });
    try {
      expect(tracker.getStatus().kernelState).toBe("skipped");
      expect(restoreLostKernel).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(f.tmuxAdapter.createSession).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT status,intentionally_stopped FROM sessions WHERE id=?").get(f.current.id))
        .toEqual({ status: "exited", intentionally_stopped: 1 });
    } finally { tracker.stop(); }
  });

  it("the shared unattended helper preserves the stopped seat when explicitly invoked", async () => {
    const f = await fixture("no-token", "kernel");
    const restore = vi.spyOn(f.restoreOrchestrator, "restore");
    expect(await restoreExistingRigUnattended(f, f.rig.id, () => true)).toEqual({ errors: [] });
    expect(restore).toHaveBeenCalledExactlyOnceWith(f.snapshot.id, expect.objectContaining({ automatic: true }));
    const outcome = await restore.mock.results[0]!.value;
    expect(outcome).toMatchObject({ ok: true, result: { nodes: expect.arrayContaining([
      expect.objectContaining({ logicalId: "paused", status: "awaiting-decision" }),
    ]) } });
    for (const { node } of f.others) {
      expect(f.tmuxAdapter.sendText).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(`--resume 'native-${node.logicalId}'`));
    }
    expect(vi.mocked(f.tmuxAdapter.createSession).mock.calls.every(([name]) => !name.includes("paused"))).toBe(true);
    expect(f.db.prepare("SELECT status,intentionally_stopped FROM sessions WHERE id=?").get(f.current.id))
      .toEqual({ status: "exited", intentionally_stopped: 1 });
    expect(f.sessionRegistry.currentOccupantTenure(f.paused.id)?.generationUuid).toBe(f.generation);
    expect(f.sessionRegistry.getBindingForNode(f.paused.id)).toBeNull();
  });

  it("a no-server down cannot turn detached snapshot history into a proved stopped fresh occupant", async () => {
    const f = await fixture();
    // A reboot-shaped row before explicit down: detached, not a prior deliberate stop.
    f.sessionRegistry.updateStatus(f.current.id, "running");
    f.sessionRegistry.markDetached(f.current.id);
    const detached = f.snapshotCapture.captureSnapshot(f.rig.id, "auto-pre-down");
    expect(detached.data.sessions.find(s => s.id === f.current.id)?.status).toBe("detached");
    const terminal = noServerTerminal();
    f.tmuxAdapter.probeSession = terminal.probeSession;
    f.tmuxAdapter.startServer = terminal.startServer;
    const result = await f.teardownOrchestrator.teardown(f.rig.id);
    expect(result).toMatchObject({ alreadyStopped: true, errors: [] });
    expect(terminal.startServer).toHaveBeenCalledTimes(1);
    expect(f.db.prepare("SELECT status,intentionally_stopped FROM sessions WHERE id=?").get(f.current.id))
      .toEqual({ status: "exited", intentionally_stopped: 1 });
    expect(snapshotMatchesCurrentOccupants(f.db, f.rigRepo.getRig(f.rig.id)!, detached)).toBe(false);
    expect(f.tmuxAdapter.createSession).not.toHaveBeenCalled();
  });

  it.each(["cli", "explorer"])("%s apply without a plan resumes from the accurate stopped snapshot", async entry => {
    const f = await fixture();
    const result = await f.post(entry === "cli" ? "/api/up" : `/api/rigs/${f.rig.id}/up`, { sourceRef: f.rig.name });
    const body = await result.json();
    expect(result.status, JSON.stringify(body)).toBe(200);
    expect(body.snapshotId).toBe(f.snapshot.id);
    expect(body.nodes.find((n: { logicalId: string }) => n.logicalId === "paused").status).toBe("awaiting-decision");
  });

  it.each(["cli", "explorer"].flatMap(entry => ["token", "no-token", "fresh-policy"].map(mode => ({ entry, mode: mode as "token" | "no-token" | "fresh-policy" }))))(
    "$entry up keeps the stopped seat stopped ($mode), using the newest accurate snapshot", async ({ entry, mode }) => {
      const f = await fixture(mode);
      const up = (plan: boolean) => f.post(entry === "cli" ? "/api/up" : `/api/rigs/${f.rig.id}/up`, { sourceRef: f.rig.name, plan });
      const restore = vi.spyOn(f.restoreOrchestrator, "restore");
      const before = f.db.prepare("SELECT total_changes() AS n").get();
      const planned = await up(true);
      expect(planned.status).toBe(200);
      const plan = await planned.json();
      expect(plan).toMatchObject({ snapshot: { id: f.snapshot.id }, wouldCaptureCurrentState: false, mutated: false });
      expect(plan.nodes.find((n: { logicalId: string }) => n.logicalId === "paused").intendedAction).toBe("awaiting-decision");
      for (const { node, session } of f.others) {
        expect(plan.nodes.find((n: { logicalId: string }) => n.logicalId === node.logicalId))
          .toMatchObject({ occupantSessionId: session.id, intendedAction: "resume-original" });
      }
      expect(restore).not.toHaveBeenCalled();
      expect(f.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
      const applied = await up(false); expect(applied.status).toBe(200);
      const result = await applied.json();
      expect(result.nodes.find((n: { logicalId: string }) => n.logicalId === "paused").status).toBe("awaiting-decision");
      expect(restore).toHaveBeenCalledExactlyOnceWith(f.snapshot.id, expect.any(Object));
      expect(f.snapshot.id).not.toBe(f.earlierRunning.id);
      for (const { node } of f.others) {
        expect(f.tmuxAdapter.sendText).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(`--resume 'native-${node.logicalId}'`));
      }
      expect(vi.mocked(f.tmuxAdapter.createSession).mock.calls.every(([name]) => !name.includes("paused"))).toBe(true);
      expect(f.db.prepare("SELECT status,intentionally_stopped FROM sessions WHERE id=?").get(f.current.id))
        .toEqual({ status: "exited", intentionally_stopped: 1 });
      expect(f.sessionRegistry.currentOccupantTenure(f.paused.id)?.generationUuid).toBe(f.generation);
      expect(f.sessionRegistry.getBindingForNode(f.paused.id)).toBeNull();
    });

  it.each(["ambiguous-current", "ambiguous-snapshot", "foreign-history", "missing-history", "no-stop-intent"])(
    "still rejects an unproved stopped relation: %s", async kind => {
      const f = await fixture(), snapshot = structuredClone(f.snapshot);
      if (kind === "ambiguous-current") f.db.prepare("INSERT INTO events(rig_id,node_id,type,payload) VALUES (?,?,'seat.fresh_launched',?)").run(f.rig.id, f.freshEvent.nodeId, JSON.stringify({ ...f.freshEvent, sessionId: f.previous.id }));
      if (kind === "ambiguous-snapshot") snapshot.data.activeOccupantsByNode![f.paused.id] = { kind: "ambiguous", candidateIds: [f.current.id, f.previous.id] };
      if (kind === "foreign-history") snapshot.data.sessions.find(s => s.id === f.current.id)!.nodeId = f.others[0]!.node.id;
      if (kind === "missing-history") snapshot.data.sessions = snapshot.data.sessions.filter(s => s.id !== f.current.id);
      if (kind === "no-stop-intent") f.db.prepare("UPDATE sessions SET intentionally_stopped=0 WHERE id=?").run(f.current.id);
      expect(snapshotMatchesCurrentOccupants(f.db, f.rigRepo.getRig(f.rig.id)!, snapshot)).toBe(false);
      expect(f.tmuxAdapter.createSession).not.toHaveBeenCalled();
    });

  it("does not accept an older snapshot when the current fresh occupant is not stopped", async () => {
    const f = await fixture();
    f.sessionRegistry.updateStatus(f.current.id, "running");
    expect(snapshotMatchesCurrentOccupants(f.db, f.rigRepo.getRig(f.rig.id)!, f.predecessorSnapshot)).toBe(false);
    expect(f.tmuxAdapter.createSession).not.toHaveBeenCalled();
  });
});
