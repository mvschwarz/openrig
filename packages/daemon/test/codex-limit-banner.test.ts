import { describe, it, expect, vi } from "vitest";
import {
  detectCodexLimitBanner,
  clearRecordedBanner,
  recordCodexLimitBanner,
} from "../src/domain/provider/codex-limit-banner.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import {
  hookMeansNeedsInput,
  latestHookWaitsOnPerson,
} from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import type { AgentActivity } from "../src/domain/types.js";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";

const BANNER = [
  " long output above",
  "■ You've hit your usage limit. Upgrade to Pro (...), visit",
  "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:14 AM.",
].join("\n");

describe("detectCodexLimitBanner", () => {
  it("matches the banner's own line form and carries the reset text", () => {
    expect(detectCodexLimitBanner(BANNER)).toMatchObject({ resetText: "4:14 AM" });
  });

  it("tolerates leading indent but still requires the marker first", () => {
    expect(detectCodexLimitBanner("   ■ You've hit your usage limit. try again at 4:14 AM.")).toMatchObject({
      resetText: "4:14 AM",
    });
  });

  it("still reports when the reset phrase is absent", () => {
    expect(detectCodexLimitBanner("■ You've hit your usage limit.")).toMatchObject({ resetText: null });
  });

  it("ignores an agent quoting the sentence", () => {
    expect(
      detectCodexLimitBanner("> ■ You've hit your usage limit. try again at 4:14 AM.")
    ).toBeNull();
  });

  it("ignores an error line merely containing the words without the marker", () => {
    expect(
      detectCodexLimitBanner("Error running remote compact task: You've hit your usage limit …")
    ).toBeNull();
  });

  it("ignores prose mentioning the limit without the marker", () => {
    expect(detectCodexLimitBanner("I think you've hit your usage limit, try again later")).toBeNull();
  });

  it("ignores ordinary panes", () => {
    expect(detectCodexLimitBanner("output\n❯ ")).toBeNull();
  });

  it("ignores a banner with a newer user message and reply below it", () => {
    const pane = [
      "■ You've hit your usage limit. try again at 4:14 AM.",
      "",
      "❯ please continue with the task",
      "Done, I continued and finished the remaining work.",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(detectCodexLimitBanner(pane)).toBeNull();
  });

  it("ignores a banner inside a fenced block the agent printed", () => {
    const pane = [
      "here is what the error looked like:",
      "```",
      "■ You've hit your usage limit. try again at 4:14 AM.",
      "```",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(detectCodexLimitBanner(pane)).toBeNull();
  });

  it("still detects a new banner printed at the bottom after recovery", () => {
    const pane = [
      "■ You've hit your usage limit. try again at 4:14 AM.",
      "",
      "❯ please continue with the task",
      "Done, I continued and finished the remaining work.",
      "■ You've hit your usage limit. try again at 6:02 AM.",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(detectCodexLimitBanner(pane)).toMatchObject({ resetText: "6:02 AM" });
  });

  it("accepts input area and footer below a current banner", () => {
    const pane = [
      "■ You've hit your usage limit. try again at 4:14 AM.",
      "",
      "› Ask Codex to do anything",
      "gpt-5.1-codex-max · Context [12%]",
    ].join("\n");
    expect(detectCodexLimitBanner(pane)).toMatchObject({ resetText: "4:14 AM" });
  });

  it("accepts any footer format below the input line", () => {
    const pane = [
      "■ You've hit your usage limit. try again at 4:14 AM.",
      "› Ask Codex to do anything",
      "gpt-6-astra xhigh · ~/path",
    ].join("\n");
    expect(detectCodexLimitBanner(pane)).toMatchObject({ resetText: "4:14 AM" });
  });

  it("ignores a one-line banner whose next line is newer output", () => {
    // The banner line already carries its reset text, so the next line is
    // newer output, not a wrapped continuation.
    const pane = [
      "■ You've hit your usage limit. try again at 4:14 AM.",
      "❯ please continue with the task",
    ].join("\n");
    expect(detectCodexLimitBanner(pane)).toBeNull();
  });
});

function fakeStore(latest: AgentActivity | null) {
  return {
    getLatestForNode: vi.fn().mockReturnValue(latest),
    recordHookEvent: vi.fn().mockReturnValue({ ok: true }),
  };
}

function hookRow(overrides: Partial<AgentActivity> = {}): AgentActivity {
  return {
    state: "unknown",
    reason: "usage_limit",
    evidenceSource: "runtime_hook",
    sampledAt: "2026-10-07T00:00:00.000Z",
    evidence: "try again at 4:14 AM",
    eventAt: "2026-10-07T00:00:00.000Z",
    rawEvent: "at_limit",
    rawSubtype: "try again at 4:14 AM",
    runtime: "codex",
    generation: "gen-1",
    fallback: false,
    stale: false,
    ...overrides,
  };
}

const T0 = new Date("2026-10-07T00:00:00.000Z");

describe("recordCodexLimitBanner", () => {
  it("records a typed at_limit row with the carried generation", () => {
    const store = fakeStore(null);
    const recorded = recordCodexLimitBanner({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: "rec-1@rig",
      banner: { resetText: "4:14 AM", evidence: "■ ..." },
      now: () => T0,
    });
    expect(recorded).toBe(true);
    expect(store.recordHookEvent).toHaveBeenCalledWith({
      runtime: "codex",
      sessionName: "rec-1@rig",
      hookEvent: "at_limit",
      subtype: "4:14 AM",
      generation: "gen-1",
    });
  });

  it("skips a still-fresh report (no per-second event spam)", () => {
    const store = fakeStore(hookRow({ eventAt: "2026-10-06T23:59:00.000Z" }));
    const recorded = recordCodexLimitBanner({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: "rec-2@rig",
      banner: { resetText: "4:14 AM", evidence: "■ ..." },
      now: () => T0,
    });
    expect(recorded).toBe(false);
    expect(store.recordHookEvent).not.toHaveBeenCalled();
  });

  it("reports again once the report ages out while the banner persists", () => {
    const store = fakeStore(hookRow({ eventAt: "2026-10-06T23:50:00.000Z", stale: true }));
    const recorded = recordCodexLimitBanner({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: "rec-3@rig",
      banner: { resetText: "4:14 AM", evidence: "■ ..." },
      now: () => T0,
    });
    expect(recorded).toBe(true);
    expect(store.recordHookEvent).toHaveBeenCalledTimes(1);
  });

  it("reports again once superseding evidence arrives and a new banner appears", () => {
    // A Stop row superseded the banner (clearing on evidence); a banner with
    // new reset text is a new episode, so a fresh typed row is due.
    const store = fakeStore(hookRow({ rawEvent: "Stop", reason: "stop", rawSubtype: null }));
    const recorded = recordCodexLimitBanner({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: "rec-4@rig",
      banner: { resetText: "5:00 AM", evidence: "■ ..." },
      now: () => T0,
    });
    expect(recorded).toBe(true);
  });

  it("does not record the same banner again after a newer hook cleared it", () => {
    const getLatest = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue(hookRow({ rawEvent: "Stop", reason: "stop", rawSubtype: null }));
    const store = { getLatestForNode: getLatest, recordHookEvent: vi.fn().mockReturnValue({ ok: true }) };
    const banner = { resetText: "4:14 AM", evidence: "■ ..." };
    const deps = (s: string) => ({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: s,
      banner,
      now: () => T0,
    });
    expect(recordCodexLimitBanner(deps("rec-5@rig"))).toBe(true);
    // Same banner still visible after a hook cleared the signal: same
    // episode, no new row.
    expect(recordCodexLimitBanner(deps("rec-5@rig"))).toBe(false);
    expect(store.recordHookEvent).toHaveBeenCalledTimes(1);
  });
});

describe("SeatStructuralActivityService — Codex limit banner emission", () => {
  it("emits the banner for a Codex seat showing it", async () => {
    const svc = new SeatStructuralActivityService({
      capturePaneContent: async () => BANNER,
    } as never);
    const seen: Array<{ session: string; reset: string | null }> = [];
    svc.attachCodexLimitBanner((sessionName, banner) => {
      seen.push({ session: sessionName, reset: banner.resetText });
    });
    await svc.pollSeat("dev@rig", null, "codex");
    expect(seen).toEqual([{ session: "dev@rig", reset: "4:14 AM" }]);
  });

  it("never emits for other runtimes or banner-free panes", async () => {
    const svc = new SeatStructuralActivityService({
      capturePaneContent: async () => BANNER,
    } as never);
    const seen: unknown[] = [];
    svc.attachCodexLimitBanner((...args: unknown[]) => {
      seen.push(args);
    });
    await svc.pollSeat("dev@rig", null, "claude-code");
    await svc.pollSeat("other@rig", null, null);
    expect(seen).toEqual([]);
  });

  it("works unattached (no emitter, no behavior change)", async () => {
    const svc = new SeatStructuralActivityService({
      capturePaneContent: async () => BANNER,
    } as never);
    await expect(svc.pollSeat("dev@rig", null, "codex")).resolves.not.toBeNull();
  });
});

describe("codex-limit-banner — store mapping and seat status", () => {
  const NOW = new Date("2026-10-07T00:00:00.000Z");

  function seedCodexSeat(db: Database.Database) {
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex" });
    const session = sessionRegistry.registerSession(node.id, "dev-qa@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-qa@test-rig", attachmentType: "tmux" });
    return { sessionName: "dev-qa@test-rig" as string };
  }

  function entries(sessionName: string) {
    return [{
      canonicalSessionName: sessionName,
      runtime: "codex",
      attachmentType: "tmux",
      logicalId: "dev.qa",
    }] as never;
  }

  it("maps a recorded at_limit row to unknown/usage_limit, not idle — even with a cached idle pane", async () => {
    const db = createFullTestDb();
    try {
      const { sessionName } = seedCodexSeat(db);
      const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => NOW });
      const recorded = store.recordHookEvent({
        runtime: "codex",
        sessionName,
        hookEvent: "at_limit",
        subtype: "try again at 4:14 AM",
        occurredAt: "2026-10-06T23:59:00.000Z",
      });
      expect(recorded.ok).toBe(true);

      const out = (await attachAgentActivity(entries(sessionName), {
        tmuxAdapter: { capturePaneContent: async () => BANNER } as never,
        activityStore: store,
        // A cached idle pane reading must NOT cover the typed limit row.
        structuralActivity: {
          getStructuralActivity: () => ({
            state: "agent_idle",
            reason: "idle_prompt",
            evidence: "› ",
            observedAt: "2026-10-07T00:00:00.000Z",
          }),
        } as never,
        now: NOW,
      } as never)) as Array<{ agentActivity: AgentActivity }>;
      // Carried through, not idle: unknown state (never needs_input, so the
      // send guard and retry logic don't read it as waiting on a person)
      // with the exact reason naming the block.
      expect(out[0]!.agentActivity.state).toBe("unknown");
      expect(out[0]!.agentActivity.reason).toBe("usage_limit");
    } finally {
      db.close();
    }
  });

  it.each([
    ["aged-out hook", { reason: "stale_runtime_hook", stale: true }],
    ["generation-mismatched hook", { reason: "generation_mismatch", stale: true }],
  ])("a demoted limit (%s) falls back to the structural reading", async (_label, verdict) => {
    const db = createFullTestDb();
    try {
      const { sessionName } = seedCodexSeat(db);
      const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => NOW });
      const recorded = store.recordHookEvent({
        runtime: "codex",
        sessionName,
        hookEvent: "at_limit",
        subtype: "try again at 4:14 AM",
        occurredAt: "2026-10-06T23:50:00.000Z",
      });
      expect(recorded.ok).toBe(true);

      const out = (await attachAgentActivity(entries(sessionName), {
        tmuxAdapter: { capturePaneContent: async () => BANNER } as never,
        activityStore: {
          getLatestForNode: () => ({
            ...store.getLatestForNode({ sessionName })!,
            ...verdict,
          }),
        } as never,
        structuralActivity: {
          getStructuralActivity: () => ({
            state: "agent_idle",
            reason: "idle_prompt",
            evidence: "› ",
            observedAt: "2026-10-07T00:00:00.000Z",
          }),
        } as never,
        now: NOW,
      } as never)) as Array<{ agentActivity: AgentActivity }>;
      expect(out[0]!.agentActivity.reason).toBe("idle_prompt");
    } finally {
      db.close();
    }
  });

  it("never counts as waiting on a person (sends to the seat go through)", () => {
    expect(hookMeansNeedsInput("at_limit", "try again at 4:14 AM", "codex")).toBe(false);
    expect(
      latestHookWaitsOnPerson(hookRow({ reason: "usage_limit" }), "codex")
    ).toBe(false);
  });

  it("forgets the recorded banner when a poll finds no current banner", () => {    const getLatest = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValue(hookRow({ rawEvent: "Stop", reason: "stop", rawSubtype: null }));
    const store = { getLatestForNode: getLatest, recordHookEvent: vi.fn().mockReturnValue({ ok: true }) };
    const bannerNoReset = { resetText: null, evidence: "■ ..." };
    const bannerSameReset = { resetText: "4:14 AM", evidence: "■ ..." };
    const deps = (s: string, banner: { resetText: string | null; evidence: string }) => ({
      store,
      resolveGeneration: () => "gen-1",
      sessionName: s,
      banner,
      now: () => T0,
    });
    // No reset time: record, hook clears it, same banner returns → same
    // episode is over, so it reports again.
    expect(recordCodexLimitBanner(deps("rec-7@rig", bannerNoReset))).toBe(true);
    expect(recordCodexLimitBanner(deps("rec-7@rig", bannerNoReset))).toBe(false);
    clearRecordedBanner("rec-7@rig");
    expect(recordCodexLimitBanner(deps("rec-7@rig", bannerNoReset))).toBe(true);
    // Identical reset text: same sequence reports again after the clear.
    expect(recordCodexLimitBanner(deps("rec-8@rig", bannerSameReset))).toBe(true);
    expect(recordCodexLimitBanner(deps("rec-8@rig", bannerSameReset))).toBe(false);
    clearRecordedBanner("rec-8@rig");
    expect(recordCodexLimitBanner(deps("rec-8@rig", bannerSameReset))).toBe(true);
    expect(store.recordHookEvent).toHaveBeenCalledTimes(4);
  });
});
