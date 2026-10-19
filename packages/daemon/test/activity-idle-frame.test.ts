import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { readSeatBeforePaste } from "../src/domain/session-transport.js";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

const NODE = "fixture-node";
const NOW = new Date("2026-10-19T13:00:00Z");
const oldIdle = { state: "idle", reason: "stop_hook", evidenceSource: "runtime_hook", sampledAt: "2026-10-19T12:59:00Z", evidence: null };
// Recorded Claude Code 2.1.296 and Codex 0.160.0 frames; busy/streaming cases below
// edit a status row. These prove the bounded reader layouts, not native activity.
const CNAME = "review-r1@sample-rig";
const cframe = readFileSync(new URL("./fixtures/input-box/claude-code-2.1.296/openrig-seat-accept-edits-idle.txt", import.meta.url), "utf8");
const codexFrame = readFileSync(new URL("./fixtures/input-box/codex-0.160.0/after-enter-15s.J.txt", import.meta.url), "utf8");
const busyFrame = cframe.replace(/^✻ Churned for 4s · done 5:24 PM$/m, "✻ Working… (3s · thinking)");
async function adapterFold(frame: string, opts: { age?: number; sourceName?: string; sourceRuntime?: "claude-code" | "codex"; runtime?: string; hook?: object | null; lastWriteAge?: number; motion?: boolean } = {}) {
  const capturedAt = new Date(NOW.getTime() - (opts.age ?? 0));
  let clock = capturedAt;
  const svc = new SeatStructuralActivityService({ capturePaneContent: async () => frame } as never, () => clock);
  const obs = await svc.pollSeat(opts.sourceName ?? CNAME, undefined, opts.sourceRuntime ?? "claude-code");
  clock = NOW;
  const out = await attachAgentActivity([{ canonicalSessionName: CNAME, nodeId: NODE, runtime: opts.runtime ?? opts.sourceRuntime ?? "claude-code", attachmentType: "tmux", logicalId: "dev.impl" }] as never, {
    now: NOW, tmuxAdapter: { hasSession: async () => true } as never,
    activityStore: { getLatestForNode: () => opts.hook === undefined ? oldIdle : opts.hook } as never,
    structuralActivity: { getStructuralActivity: () => svc.getStructuralActivity(opts.sourceName ?? CNAME) },
    seatActivity: { getSeatActivity: () => ({ paneId: CNAME, isActiveWithinWindow: opts.motion ?? true, silenceWindowSeconds: 3,
      lastActivityAt: new Date(NOW.getTime() - (opts.lastWriteAge ?? 1000)).toISOString(), lastObservedAt: NOW.toISOString() }) },
  });
  return { observation: obs, activity: out[0]!.agentActivity! };
}
describe("issue824 existing strict adapter idle frame (behavioral red-first)", () => {
  it("the existing reader distinguishes completed idle from live work, streaming, unknown and misbound frames", () => {
    expect(busyFrame).not.toBe(cframe);
    const readings = {
      idle: readSeatBeforePaste(cframe, "claude-code", CNAME),
      busy: readSeatBeforePaste(busyFrame, "claude-code", CNAME),
      misbound: readSeatBeforePaste(cframe, "claude-code", "someone.else@sample-rig"),
      unknown: readSeatBeforePaste("unknown output", "claude-code", CNAME),
      codexIdle: readSeatBeforePaste(codexFrame, "codex"),
      codexStreaming: readSeatBeforePaste(codexFrame.replace(/^ {2}Worked for[^\n]+$/m, "• Streaming an unfinished answer"), "codex"),
    };
    expect(readings).toEqual({ idle: "idle", busy: "not-idle", misbound: "unknown", unknown: "unknown", codexIdle: "idle", codexStreaming: "unknown" });
    console.log("824_STRICT_DISTINCTION", JSON.stringify(readings));
  });
  it("a current bound completed-idle observation outranks redraw motion and the old idle hook", async () => {
    const result = await adapterFold(cframe);
    console.log("824_STRICT_IDLE_FOLD", JSON.stringify(result));
    expect(result.activity.state).toBe("idle");
    expect(result.activity.evidenceSource).toBe("pane_heuristic");
  });
  it("the Codex completed frame can prove idle, but the same footer while streaming cannot", async () => {
    expect((await adapterFold(codexFrame, { sourceRuntime: "codex" })).activity.state).toBe("idle");
    const streaming = codexFrame.replace(/^ {2}Worked for[^\n]+$/m, "• Streaming an unfinished answer");
    expect((await adapterFold(streaming, { sourceRuntime: "codex" })).activity.state).toBe("running");
  });
  it("a newer redraw after an old idle capture keeps D2 running", async () => {
    expect((await adapterFold(cframe, { age: 2000 })).activity.state).toBe("running");
    // The write and capture are in the same second: ordering is unknown,
    // so that capture cannot suppress motion.
    expect((await adapterFold(cframe, { age: 500 })).activity.state).toBe("running");
  });
  it("expired, misbound and wrong-runtime samples do not suppress live motion", async () => {
    for (const opts of [{ age: 6000 }, { sourceName: "someone.else@sample-rig" }, { runtime: "codex" }]) {
      expect((await adapterFold(cframe, opts)).activity.state).toBe("running");
    }
  });
  it("current work and needs-input keep their meaning over the idle frame", async () => {
    expect((await adapterFold(busyFrame)).activity.state).toBe("running");
    for (const state of ["running", "needs_input"]) expect((await adapterFold(cframe, { hook: { ...oldIdle, state, sampledAt: NOW.toISOString() } })).activity.state).toBe(state);
  });
  it("a later motion poll with no new write does not invalidate the completed idle frame", async () => {
    expect((await adapterFold(cframe, { age: 900, lastWriteAge: 2000 })).activity.state).toBe("idle");
  });
  it("without motion the idle hook retains its full provenance", async () => {
    const hook = { ...oldIdle, eventAt: oldIdle.sampledAt };
    expect((await adapterFold(cframe, { motion: false, hook })).activity).toEqual(hook);
  });
  it.each(["single", "batch"] as const)("a deferred %s read never dates held idle bytes by response completion", async (path) => {
    // Cover both a write in the capture's second and a read spanning a second.
    for (const age of [900, 1100]) {
      let clock = new Date(NOW.getTime() - age);
      const began = clock.toISOString();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const tmux = {
        capturePaneContent: async () => { entered(); await held; return cframe; },
        ...(path === "batch" ? { capturePanesContent: async () => {
          entered(); await held;
          return new Map([[CNAME, { text: cframe, capturedAt: clock }]]);
        } } : {}),
      };
      const structural = new SeatStructuralActivityService(tmux, () => clock);
      const db = createFullTestDb();
      try {
        const repo = new RigRepository(db);
        const registry = new SessionRegistry(db);
        const rig = repo.createRig("sample-rig");
        const node = repo.addNode(rig.id, "review.r1", { runtime: "claude-code" });
        const session = registry.registerSession(node.id, CNAME);
        registry.updateStatus(session.id, "running");
        registry.updateBinding(node.id, { tmuxSession: CNAME, attachmentType: "tmux" });
        const pending = path === "batch" ? structural.pollAllRunningTmuxSeats(db) : structural.pollSeat(CNAME, undefined, "claude-code");
        await started;
        clock = new Date(NOW.getTime() - 400); // work resumes while old idle bytes are held
        const motion = new SeatActivityService({ tmux: { readPaneLastActivity: async () => Math.floor(clock.getTime() / 1000) }, defaultWindowSeconds: 3, now: () => clock });
        await motion.pollSeat(CNAME);
        clock = new Date(NOW.getTime() - 100); // response completes after motion was observed
        release(); await pending;
        clock = NOW;
        const out = await attachAgentActivity([{ canonicalSessionName: CNAME, nodeId: node.id, runtime: "claude-code", attachmentType: "tmux" }] as never, {
          now: NOW, tmuxAdapter: { hasSession: async () => true } as never,
          activityStore: { getLatestForNode: () => oldIdle } as never,
          structuralActivity: structural, seatActivity: motion,
        });
        expect(out[0]!.agentActivity!.state, `capture age=${age}`).toBe("running");
        expect(structural.getStructuralActivity(CNAME)?.idleFrame?.captureStartedAt).toBe(began);
      } finally { release(); db.close(); }
    }
  });
});
