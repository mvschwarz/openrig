import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CLAUDE_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import { hookEventState } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { evidenceFromHookActivity } from "../src/routes/activity.js";
import { probeSessionActivity } from "../src/domain/session-transport.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createDaemon } from "../src/startup.js";

const captures = JSON.parse(readFileSync(new URL("./fixtures/claude-permission-2.1.300.json", import.meta.url), "utf8")) as Record<string, string>;

function fixture() {
  let nowMs = 0;
  let sequence = 0;
  let visible: boolean | null = true;
  const changed = vi.fn();
  const reader = vi.fn(async (): Promise<boolean | null> => visible);
  const service = new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3,
    now: () => new Date(nowMs), permissionPromptReader: reader, permissionPromptChanged: changed,
  });
  const declare = () => service.declareRungInventory({ seatNodeId: "seat", sessionName: "session" }, CLAUDE_ACTIVITY_RUNG_INVENTORY);
  declare();
  const hook = (event = "Notification", subtype = "permission_prompt") => {
    const evidence = evidenceFromHookActivity({ seatNodeId: "seat", sessionName: "session", runtime: "claude-code", seq: ++sequence,
      activity: { state: hookEventState(event, subtype, "claude-code"), reason: event === "Notification" ? subtype : event,
        rawEvent: event, rawSubtype: subtype, evidenceSource: "runtime_hook", sampledAt: new Date(nowMs).toISOString(), evidence: null } });
    if (evidence) service.reportEvidence(evidence);
  };
  return { service, reader, changed, hook, declare,
    visible: (value: boolean | null) => { visible = value; },
    tick: async (delta = 1_000) => { nowMs += delta; await service.pollSeat("session"); },
    count: () => service.getSeatState("seat")!.needsInput.count,
  };
}

describe("Claude permission episodes share the permission poller", () => {
  it.each(["bash", "edit", "webFetch"])("recognizes the native %s permission menu", async shape => {
    const activity = await probeSessionActivity({ sessionName: "session", runtime: "claude-code", attachmentType: "tmux",
      visibleScreenOnly: true, tmuxAdapter: { hasSession: async () => true,
        capturePaneScreen: async () => captures[shape] } as unknown as TmuxAdapter });
    expect(activity).toMatchObject({ state: "needs_input", reason: "permission_prompt" });
  });

  it("recognizes the approved tool as working, but fails closed on an unsupported denied screen", async () => {
    const probe = (text: string) => probeSessionActivity({ sessionName: "session", runtime: "claude-code", attachmentType: "tmux",
      visibleScreenOnly: true, tmuxAdapter: { hasSession: async () => true, capturePaneScreen: async () => text } as unknown as TmuxAdapter });
    expect(await probe(captures.approvedBash!)).toMatchObject({ state: "running" });
    expect(await probe(captures.deniedWebFetch!)).toMatchObject({ state: "unknown" });
  });

  it("reads only the current screen, not an old permission in scrollback", async () => {
    const capturePaneContent = vi.fn(async () => "Do you want to proceed?\n❯ 1. Yes\n  2. No");
    const capturePaneScreen = vi.fn(async () => "❯ ");
    const activity = await probeSessionActivity({ sessionName: "session", runtime: "claude-code", attachmentType: "tmux",
      visibleScreenOnly: true, tmuxAdapter: { hasSession: async () => true, capturePaneScreen, capturePaneContent } as unknown as TmuxAdapter });
    expect(activity.state).toBe("idle");
    expect(capturePaneScreen).toHaveBeenCalledOnce();
    expect(capturePaneContent).not.toHaveBeenCalled();
  });

  it("keeps the styled follow-up capture on the visible screen too", async () => {
    const capturePaneContent = vi.fn();
    const capturePaneScreen = vi.fn(async () => ["● Ready.", "", "✻ Crunched for 2s", "", "─".repeat(60),
      "❯\u00a0yes run the tests and open the PR", "─".repeat(60),
      "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
      "  ✘ Auto-update failed: no write permission to npm prefix · Run claude doctor", ""].join("\n"));
    await probeSessionActivity({ sessionName: "session", runtime: "claude-code", attachmentType: "tmux",
      visibleScreenOnly: true, tmuxAdapter: { hasSession: async () => true, capturePaneScreen, capturePaneContent } as unknown as TmuxAdapter });
    expect(capturePaneScreen).toHaveBeenCalledWith("session", { escapeSequences: true });
    expect(capturePaneContent).not.toHaveBeenCalled();
  });

  it("probes immediately, then clears a seen prompt mid-turn without inferring idle", async () => {
    const subject = fixture();
    subject.hook("UserPromptSubmit");
    subject.hook("PreToolUse");
    subject.hook();
    expect(subject.count()).toBe(1);
    await subject.tick(0);
    expect(subject.reader).toHaveBeenCalledWith("session", "claude-code");
    subject.hook("PreToolUse");
    await subject.tick();
    expect(subject.count()).toBe(1);
    subject.visible(false);
    await subject.tick();
    expect(subject.count()).toBe(0);
    expect(subject.service.getSeatState("seat")!.activity).toBe("working");
    expect(subject.changed).toHaveBeenLastCalledWith("session", false, "claude-code");
    const calls = subject.reader.mock.calls.length;
    await subject.tick(60_000);
    expect(subject.reader).toHaveBeenCalledTimes(calls);
  });

  it.each([false, null])("cannot clear an unseen prompt with %s", async visible => {
    const subject = fixture();
    subject.visible(visible);
    subject.hook();
    await subject.tick(0);
    await subject.tick(20_000);
    expect(subject.count()).toBe(1);
    expect(subject.changed.mock.calls.some(call => call[1] === false)).toBe(false);
    subject.visible(true);
    await subject.tick(5_000);
    subject.visible(false);
    await subject.tick();
    expect(subject.count()).toBe(0);
  });

  it("retains seen attention across a missing capture and only persists transitions", async () => {
    const subject = fixture();
    subject.hook();
    await subject.tick(0);
    await subject.tick();
    const calls = subject.changed.mock.calls.length;
    subject.visible(null);
    await subject.tick();
    expect(subject.count()).toBe(1);
    expect(subject.service.getSeatState("seat")!.needsInput.reason).toBe("permission_prompt");
    expect(subject.changed).toHaveBeenCalledTimes(calls);
    subject.visible(false);
    await subject.tick();
    expect(subject.count()).toBe(0);
  });

  it.each([["request", false], ["occupant", false], ["request", true], ["occupant", true]] as const)(
    "discards an in-flight reading after a new %s (visible=%s) and requires a new seen step", async (change, visible) => {
    const subject = fixture();
    subject.hook();
    await subject.tick(0);
    let finish!: (value: boolean) => void;
    subject.reader.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const polling = subject.tick();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    if (change === "occupant") {
      subject.service.declareOccupantSwap("seat", "successor");
      subject.declare();
    }
    subject.hook();
    finish(visible);
    await polling;
    expect(subject.count()).toBe(1);
    subject.visible(false);
    await subject.tick();
    expect(subject.count()).toBe(1);
    subject.visible(true);
    await subject.tick();
    subject.visible(false);
    await subject.tick();
    expect(subject.count()).toBe(0);
  });

  it.each(["Stop", "UserPromptSubmit"])("retains the authoritative %s fallback for unseen or unusable panes", async event => {
    const subject = fixture();
    subject.visible(null);
    subject.hook();
    await subject.tick(0);
    subject.hook(event);
    expect(subject.count()).toBe(0);
  });

  it("does not clear a different dialog with the old permission episode", async () => {
    const subject = fixture();
    subject.hook();
    await subject.tick(0);
    subject.hook("Notification", "elicitation_dialog");
    subject.visible(false);
    await subject.tick();
    expect(subject.count()).toBe(1);
    expect(subject.service.getSeatState("seat")!.needsInput.reason).toBe("elicitation_dialog");
  });

  it("does not mask later self-report attention with a retired permission episode", async () => {
    const subject = fixture();
    subject.hook("PreToolUse");
    subject.hook();
    await subject.tick(0);
    subject.visible(false);
    await subject.tick();
    expect(subject.count()).toBe(0);
    subject.service.reportEvidence({ seatNodeId: "seat", sessionName: "session", rung: "self-report", sourceId: "claude:pid-json",
      seq: 1, observedAt: new Date(1_001).toISOString(), needsInput: { count: 1, reason: "dialog owns input" } });
    expect(subject.count()).toBe(1);
    await subject.tick();
    expect(subject.count()).toBe(1);
    subject.service.reportEvidence({ seatNodeId: "seat", sessionName: "session", rung: "self-report", sourceId: "claude:pid-json",
      seq: 2, observedAt: new Date(2_001).toISOString(), activity: "working" });
    expect(subject.count()).toBe(0);
    expect(subject.service.getSeatState("seat")!.activity).toBe("working");
  });

  it("keeps probing an open episode when generic self-report waiting may describe the same permission", async () => {
    const subject = fixture();
    subject.hook();
    await subject.tick(0);
    subject.service.reportEvidence({ seatNodeId: "seat", sessionName: "session", rung: "self-report", sourceId: "claude:pid-json",
      seq: 1, observedAt: new Date(0).toISOString(), needsInput: { count: 1, reason: "dialog owns input" } });
    subject.visible(null);
    await subject.tick();
    expect(subject.count()).toBe(1);
    subject.visible(false);
    await subject.tick();
    expect(subject.count()).toBe(0);
  });

  it("wires pane-only Claude confirmation and clearing through the daemon, excluding non-tmux bindings", async () => {
    const originalNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      expect(String(input)).toBe("https://github.com/mvschwarz/openrig-plugins/releases/latest/download/openrig-core.tar.gz");
      return new Response(null, { status: 404 });
    });
    const capture = vi.fn(async () => captures.bash!);
    let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
    try {
      daemon = await createDaemon({ dbPath: ":memory:", tmuxExec: async command => command.includes("capture-pane") ? capture() : "",
        cmuxExec: async () => "" } as Parameters<typeof createDaemon>[0]);
      const { rigRepo, sessionRegistry, agentActivityStore, seatActivityService } = daemon.deps;
      const rig = rigRepo.createRig("permission-reader");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const sessionName = "worker@permission-reader";
      const session = sessionRegistry.registerSession(node.id, sessionName);
      sessionRegistry.updateStatus(session.id, "running");
      const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
      seatActivityService.declareRungInventory({ seatNodeId: node.id, sessionName }, CLAUDE_ACTIVITY_RUNG_INVENTORY);
      let sequence = 0;
      const notify = () => {
        agentActivityStore.recordHookEvent({ sessionName, runtime: "claude-code", generation, hookEvent: "Notification", subtype: "permission_prompt" });
        seatActivityService.reportEvidence({ seatNodeId: node.id, sessionName, rung: "lifecycle-hooks", sourceId: "native-hook",
          seq: ++sequence, observedAt: new Date().toISOString(), needsInput: { count: 1, reason: "permission_prompt" },
          permissionRequest: { id: "claude-permission-prompt" } });
      };
      notify();
      await seatActivityService.pollSeat(sessionName);
      expect(capture).not.toHaveBeenCalled();
      sessionRegistry.updateBinding(node.id, { attachmentType: "external_cli", externalSessionName: sessionName });
      notify();
      await seatActivityService.pollSeat(sessionName);
      expect(capture).not.toHaveBeenCalled();
      sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName });
      notify();
      await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
      await new Promise(resolve => setTimeout(resolve, 1_100));
      capture.mockRejectedValueOnce(new Error("pane unavailable"));
      await seatActivityService.pollSeat(sessionName);
      expect(seatActivityService.getSeatState(node.id)!.needsInput.count).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 1_100));
      capture.mockResolvedValue("❯ ");
      await seatActivityService.pollSeat(sessionName);
      expect(seatActivityService.getSeatState(node.id)!.needsInput.count).toBe(0);
      expect(agentActivityStore.getLatestForNode({ sessionName })).toMatchObject({
        state: "unknown", reason: "permission_prompt_cleared", rawEvent: "PermissionPromptCleared", runtime: "claude-code",
      });
    } finally {
      daemon?.eventLoopMonitor.stop();
      daemon?.db.close();
      fetch.mockRestore();
      if (originalNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = originalNoKernel;
    }
  }, 10_000);
});
