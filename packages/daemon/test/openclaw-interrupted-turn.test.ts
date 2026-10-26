import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyPaneActivity, communityHarnessPaneActivity, probeSessionActivity } from "../src/domain/session-transport.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";

// OpenClaw2026.10.6 retained local refusal, with a synthetic conversation name.
// The text has several native emitters: it proves a refused turn, not a specific recovery-claim diagnosis.
const refusal = readFileSync(new URL("./fixtures/openclaw-local-turn-refused.txt", import.meta.url), "utf8");
const read = (screen: string, harness: string | null = "openclaw") =>
  communityHarnessPaneActivity(classifyPaneActivity(screen), harness, screen);

const needsAttention = { state: "attention", reason: "OpenClaw turn not recovered; inspect the pane before retrying" };

describe("an OpenClaw local turn that was not recovered", () => {
  it("reports the retained wrapped refusal, with inspection guidance instead of an automatic retry", () => {
    expect(read(refusal)).toMatchObject(needsAttention);
    expect(read(refusal).evidence).toContain('Session "agent:main:openrig-fixture" changed while starting work. Retry.');
  });

  it("reads a styled, unwrapped refusal through the same path", () => {
    expect(read(refusal.replace('Session\n "agent:main:openrig-fixture" changed while\n starting', 'Session "agent:main:openrig-fixture" changed while starting')
      .replace("local ready | error", "\x1b[31mlocal ready | error\x1b[0m"))).toMatchObject(needsAttention);
  });

  it.each([null, "claude-code", "pi", "synth", "openclaw-gateway"])("does not infer an OpenClaw refusal for %s", harness => {
    expect(read(refusal, harness).reason).not.toBe(needsAttention.reason);
  });

  it.each([
    refusal.replace("local ready | error", "local ready | idle"),
    refusal.replace("local ready | error", "gateway connected | error"),
    refusal.replace("starting work. Retry.", "starting work. Try again."),
    refusal.replace('run error: Session', 'quoted example: Session'),
    refusal.replace("agent main | session", "quoted output | session"),
    'Session "agent:main:openrig-fixture" changed while starting work. Retry.',
    refusal + "\nlocal ready | idle\nagent main | session openrig-fixture |",
    refusal + "\n⠋ Working (esc to interrupt)",
  ])("does not mistake history, another error or an incomplete frame for the current native refusal", screen => {
    expect(read(screen).reason).not.toBe(needsAttention.reason);
  });

  it("feeds the existing capture cache and invalidates on an unreadable pane", async () => {
    let content: string | null = refusal;
    const svc = new SeatStructuralActivityService({ capturePaneContent: async () => content });
    expect(await svc.pollSeat("worker@team", undefined, "openclaw", "openclaw")).toMatchObject(needsAttention);
    expect(svc.getStructuralActivity("worker@team")).toMatchObject(needsAttention);
    content = null;
    expect(await svc.pollSeat("worker@team", undefined, "openclaw", "openclaw")).toBeNull();
    expect(svc.getStructuralActivity("worker@team")).toBeNull();
  });

  it("uses the same attention and guidance in the on-demand delivery observation", async () => {
    const activity = await probeSessionActivity({
      sessionName: "worker@team", runtime: "openclaw", communityHarness: "openclaw", attachmentType: "tmux",
      tmuxAdapter: { hasSession: async () => true, capturePaneContent: async () => refusal, getPaneCommand: async () => "openclaw" } as unknown as TmuxAdapter,
    });
    expect(activity).toMatchObject({ ...needsAttention, state: "needs_input" });
  });
});
