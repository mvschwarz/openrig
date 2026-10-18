// A seat's transcript capture lasts as long as its session. Before this, only a whole rig's teardown stopped it: a
// stopped seat, a removed node or pod, or a cleaned dead seat kept a rotator running `tmux capture-pane` against a
// session that no longer existed, every poll interval, until the daemon restarted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { wireTranscriptCaptureStops } from "../src/domain/transcript-capture.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import {
  clearAllTranscriptRotationsForTest,
  getActiveRotationCount,
  getLastCaptureAt,
  getTranscriptCaptureStats,
  startTranscriptRotation,
} from "../src/domain/transcript-rotation.js";

describe("transcript capture stops when a single session ends", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let tmpDir: string;
  let store: TranscriptStore;
  let unwire: () => void;
  const captureAdapter = { capturePaneContent: vi.fn(async () => "recent work\n") } as unknown as TmuxAdapter;

  beforeEach(() => {
    db = createFullTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-session-end-"));
    // The transcript routes read where the claim's capture and the rotations write, so they serve its saved text.
    store = new TranscriptStore({ transcriptsRoot: tmpDir });
    setup = createTestApp(db, { transcriptStore: store, appDeps: { transcriptStore: store } });
    unwire = wireTranscriptCaptureStops(db, setup.eventBus);
  });

  afterEach(() => {
    unwire();
    clearAllTranscriptRotationsForTest();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function tmux() {
    const t = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    if (!t.probeSession) {
      t.probeSession = vi.fn(async (name: string) =>
        (await t.hasSession(name)) ? { state: "present" } : { state: "absent" });
    }
    return t;
  }

  function seedSeat(logicalId: string) {
    const rig = setup.rigRepo.findRigsByName("capture-rig")[0] ?? setup.rigRepo.createRig("capture-rig");
    const sessionName = `${logicalId.replace(".", "-")}@capture-rig`;
    const node = setup.rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
    const session = setup.sessionRegistry.registerSession(node.id, sessionName);
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
    return { rig, node, sessionName };
  }

  function rotate(sessionName: string) {
    startTranscriptRotation(captureAdapter, sessionName, store.getTranscriptPath("capture-rig", sessionName), { lines: 10, pollIntervalMs: 60_000 });
  }

  // Past the staleness limit on disk: only a running capture would make the saved text read as fresh.
  function ageTranscript(rigName: string, sessionName: string) {
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(store.getTranscriptPath(rigName, sessionName), longAgo, longAgo);
  }

  function reads(sessionName: string) {
    const session = encodeURIComponent(sessionName);
    return Promise.all([
      setup.app.request(`/api/transcripts/${session}/tail?lines=5`),
      setup.app.request(`/api/transcripts/${session}/grep?pattern=recent`),
      setup.app.request(`/api/transcripts/${session}/full`),
    ]);
  }

  async function settle(sessionName: string) {
    const deadline = Date.now() + 2000;
    while (getLastCaptureAt(sessionName) === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  function postSeat(verb: "stop" | "clean", seatRef: string) {
    return setup.app.request(`/api/seat/${verb}/${encodeURIComponent(seatRef)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "session end fixture" }),
    });
  }

  it("rig seat stop ends the stopped seat's capture and keeps its running sibling's", async () => {
    const stopped = seedSeat("dev.impl");
    const sibling = seedSeat("dev.qa");
    rotate(stopped.sessionName);
    rotate(sibling.sessionName);
    await settle(sibling.sessionName);
    expect(getActiveRotationCount()).toBe(2);

    tmux().hasSession.mockResolvedValue(true);
    expect((await postSeat("stop", stopped.sessionName)).status).toBe(200);

    expect(getActiveRotationCount()).toBe(1);
    expect(getTranscriptCaptureStats().rotatingSeats).toBe(1);
    expect(getLastCaptureAt(stopped.sessionName)).toBeUndefined();
    expect(getLastCaptureAt(sibling.sessionName)).toBeDefined();
  });

  it("a cleaned seat whose session exited on its own stops being captured", async () => {
    const dead = seedSeat("dev.impl");
    const sibling = seedSeat("dev.qa");
    rotate(dead.sessionName);
    rotate(sibling.sessionName);

    tmux().hasSession.mockResolvedValue(false);
    expect((await postSeat("clean", dead.sessionName)).status).toBe(200);

    expect(getActiveRotationCount()).toBe(1);
    expect(getLastCaptureAt(dead.sessionName)).toBeUndefined();
  });

  it("removing a pod ends its members' captures and keeps a seat outside the pod", async () => {
    const outside = seedSeat("lead.main");
    const rig = setup.rigRepo.findRigsByName("capture-rig")[0]!;
    const expanded = await setup.rigExpansionService.expand({
      rigId: rig.id,
      pod: {
        id: "dev",
        label: "Development",
        members: [
          { id: "impl", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
          { id: "qa", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" },
        ],
        edges: [],
      },
    });
    expect(expanded.ok).toBe(true);
    const members = (db.prepare(`
      SELECT s.session_name FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.rig_id = ? AND n.logical_id LIKE 'dev.%' ORDER BY n.logical_id
    `).all(rig.id) as Array<{ session_name: string }>).map((row) => row.session_name);
    expect(members).toHaveLength(2);
    for (const name of [outside.sessionName, ...members]) rotate(name);
    expect(getActiveRotationCount()).toBe(3);

    const res = await setup.app.request(`/api/rigs/${rig.id}/pods/dev`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(getActiveRotationCount()).toBe(1);
    for (const name of members) expect(getLastCaptureAt(name)).toBeUndefined();
    await settle(outside.sessionName);
    expect(getLastCaptureAt(outside.sessionName)).toBeDefined();
  });

  it("removing a node whose session name another live seat owns keeps that owner's capture", async () => {
    const owner = seedSeat("dev.impl");
    const stale = setup.rigRepo.createRig("stale-rig");
    const staleNode = setup.rigRepo.addNode(stale.id, "dev.impl", { runtime: "claude-code" });
    setup.sessionRegistry.registerSession(staleNode.id, owner.sessionName);
    rotate(owner.sessionName);

    const res = await setup.app.request(`/api/rigs/${stale.id}/nodes/dev.impl`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await res.json() as { sessionKeptFor?: string }).sessionKeptFor).toBe("dev.impl@capture-rig");

    expect(getActiveRotationCount()).toBe(1);
  });

  it("an unclaimed session keeps its capture and its saved reads, and a re-claim keeps capturing", async () => {
    tmux().capturePaneContent = vi.fn(async () => "recent work\n");
    const rig = setup.rigRepo.createRig("unclaim-capture-rig");
    setup.rigRepo.addNode(rig.id, "external.helper", { runtime: "codex" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "unclaim-capture-session", tmuxPane: "%1", cwd: "/tmp",
      activeCommand: "codex", runtimeHint: "codex", confidence: "high",
    });
    const claim = () => setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "external.helper" });
    const claimed = await claim();
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(getActiveRotationCount()).toBe(1);
    await settle(discovered.tmuxSession);
    expect(getLastCaptureAt(discovered.tmuxSession)).toBeDefined();
    ageTranscript("unclaim-capture-rig", discovered.tmuxSession);

    const unclaim = await setup.app.request(`/api/sessions/${claimed.sessionId}/unclaim`, { method: "POST" });
    expect(unclaim.status).toBe(200);

    expect(getActiveRotationCount()).toBe(1);
    expect(getLastCaptureAt(discovered.tmuxSession)).toBeDefined();
    for (const res of await reads(discovered.tmuxSession)) expect(res.status).toBe(200);

    expect((await claim()).ok).toBe(true);
    expect(getActiveRotationCount()).toBe(1);
    for (const res of await reads(discovered.tmuxSession)) expect(res.status).toBe(200);
  });

  it("a stopped or cleaned session serves its saved text, its ingest health saying capture is not live", async () => {
    const stopped = seedSeat("dev.impl");
    const cleaned = seedSeat("dev.qa");
    rotate(stopped.sessionName);
    rotate(cleaned.sessionName);
    await settle(stopped.sessionName);
    await settle(cleaned.sessionName);

    tmux().hasSession.mockResolvedValue(true);
    expect((await postSeat("stop", stopped.sessionName)).status).toBe(200);
    tmux().hasSession.mockResolvedValue(false);
    expect((await postSeat("clean", cleaned.sessionName)).status).toBe(200);

    const expectSavedReads = async (sessionName: string) => {
      const [tail, grep, full] = await reads(sessionName);
      for (const res of [tail, grep, full]) expect(res!.status).toBe(200);
      const bodies = await Promise.all([tail!.json(), grep!.json(), full!.json()]) as Array<{
        content?: string; matches?: string[]; ingestHealth: { state: string; reason: string };
      }>;
      expect(bodies[0]!.content).toContain("recent work");
      expect(bodies[1]!.matches).toEqual(["recent work"]);
      expect(bodies[2]!.content).toContain("recent work");
      for (const body of bodies) expect(body.ingestHealth).toMatchObject({ state: "degraded", reason: "capture_stale" });
    };
    // At once, while the saved files are still recent, then once they are past the staleness limit.
    for (const sessionName of [stopped.sessionName, cleaned.sessionName]) await expectSavedReads(sessionName);
    ageTranscript("capture-rig", stopped.sessionName);
    ageTranscript("capture-rig", cleaned.sessionName);
    for (const sessionName of [stopped.sessionName, cleaned.sessionName]) await expectSavedReads(sessionName);
    // A read never starts the ended session's capture again.
    expect(getActiveRotationCount()).toBe(0);
  });

  it("a relaunch under the same session name captures again after the stop", async () => {
    const seat = seedSeat("dev.impl");
    rotate(seat.sessionName);
    tmux().hasSession.mockResolvedValue(true);
    expect((await postSeat("stop", seat.sessionName)).status).toBe(200);
    expect(getActiveRotationCount()).toBe(0);

    rotate(seat.sessionName);
    await settle(seat.sessionName);
    expect(getActiveRotationCount()).toBe(1);
    expect(getLastCaptureAt(seat.sessionName)).toBeDefined();
  });
});
