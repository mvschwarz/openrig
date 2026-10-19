import { describe, it, expect, vi } from "vitest";
import {
  detectCodexLimitBanner,
  clearRecordedBanner,
  recordCodexLimitBanner,
} from "../src/domain/provider/codex-limit-banner.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
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
import { psCommand } from "../../cli/src/commands/ps.js";
import { STATE_FILE } from "../../cli/src/daemon-lifecycle.js";

const BANNER = [
  " long output above",
  "■ You've hit your usage limit. Upgrade to Pro (...), visit",
  "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:14 AM.",
].join("\n");

const NESTED_DRAFTS = ["Explain this example", ""].flatMap(first => ["", "  ", "    "].flatMap(indent => [
  "› Continue the task\n• Working (1s • esc to interrupt)",
  "› Continue the task\n› another example\n• Working (1s • esc to interrupt)",
  "› nested example\n  › deeper example\n  • Working (1s • esc to interrupt)",
  "```\n› Continue the task\n• Working (1s • esc to interrupt)\n```",
  "› Continue the task",
  "\n› Continue the task\n\n• Working (1s • esc to interrupt)\n",
  "■ You've hit your usage limit. try again at 9:00 AM.\n› spoofed composer\n• Working (1s • esc to interrupt)",
].map(body => `${indent}› ${first}\n${body.split("\n").map(line => `${indent}  ${line}`).join("\n")}`)));

describe("detectCodexLimitBanner", () => {
  it("matches the banner's own line form and carries the reset text", () => {
    expect(detectCodexLimitBanner(BANNER)).toMatchObject({ resetText: "4:14 AM" });
  });

  it("tolerates leading indent but still requires the marker first", () => {
    expect(detectCodexLimitBanner("   ■ You've hit your usage limit. try again at 4:14 AM.")).toMatchObject({
      resetText: "4:14 AM",
    });
  });

  it("preserves first-banner recognition after earlier input at a shallower column", () => {
    const pane = "› Earlier message\n  ■ You've hit your usage limit. try again at 4:14 AM.\n› Ask Codex to do anything";
    expect(detectCodexLimitBanner(pane)).toMatchObject({ resetText: "4:14 AM" });
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

  it.each(["❯", "›"])("ignores a banner with a newer %s user message and reply below it", (marker) => {
    const pane = [
      "■ You've hit your usage limit. try again at 4:14 AM.",
      "",
      `${marker} please continue with the task`,
      "Done, I continued and finished the remaining work.",
      "› Ask Codex to do anything",
    ].join("\n");
    expect(detectCodexLimitBanner(pane)).toBeNull();
  });

  it.each([
    "◦ Working (2s • esc to interrupt)",
    "• Reviewing changes (1h 09m 39s • esc to interrupt) · 1 background terminal running",
  ].flatMap(status => ["", "  "].flatMap(indent => ["", "\n› Ask Codex to do anything"].map(composer => ({
    status, indent, composer,
  })))))("ends an old banner before newer turn output: %j", ({ status, indent, composer }) => {
    expect(detectCodexLimitBanner(`${BANNER}\n${indent}› Continue the task\n${indent}${status}${composer}`)).toBeNull();
  });

  it.each(["", "  "])("keeps a banner above a multiline draft with indent %j", (indent) => {
    const pane = `${BANNER}\n${indent}› Explain this status:\n${indent}  ◦ Working (2s • esc to interrupt)`;
    expect(detectCodexLimitBanner(pane)).toMatchObject({ resetText: "4:14 AM" });
  });

  it.each(NESTED_DRAFTS)("keeps every continuation inside its outer draft: %j", (draft) => {
    expect(detectCodexLimitBanner(`${BANNER}\n${draft}`)).toMatchObject({ resetText: "4:14 AM" });
  });

  it("does not let an unclosed typed fence hide real subsequent status", () => {
    const pane = BANNER + "\n› Explain this example\n  ```\n◦ Working (2s • esc to interrupt)";
    expect(detectCodexLimitBanner(pane)).toBeNull();
    expect(detectCodexLimitBanner(`${pane}\n■ You've hit your usage limit. try again at 6:02 AM.\n› `))
      .toMatchObject({ resetText: "6:02 AM" });
  });

  it.each(["Working on the draft", "Show me what esc to interrupt means", "gpt-6-astra xhigh · Working directory"])(
    "does not mistake composer/footer prose for turn output: %j", (text) => {
      expect(detectCodexLimitBanner(`${BANNER}\n› Continue the task\n${text}`)).toMatchObject({ resetText: "4:14 AM" });
    },
  );

  it.each(["> ◦ Working (2s • esc to interrupt)", "```\n◦ Working (2s • esc to interrupt)\n```"])(
    "keeps quoted status below a draft: %j", (quoted) => {
      expect(detectCodexLimitBanner(`${BANNER}\n› Explain this status:\n${quoted}`)).toMatchObject({ resetText: "4:14 AM" });
    },
  );

  it("keeps a newer banner after a completed turn-status row", () => {
    expect(detectCodexLimitBanner(`◦ Working (2s • esc to interrupt)\n${BANNER}\n› Continue the task`))
      .toMatchObject({ resetText: "4:14 AM" });
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

  it.each(["› Continue the task", "  › Ask Codex to do anything"])(
    "accepts a current banner above composer %j", (composer) => {
      expect(detectCodexLimitBanner(`${BANNER}\n${composer}`)).toMatchObject({ resetText: "4:14 AM" });
    },
  );

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

  it.each([
    { rawEvent: "PermissionRequest" },
    { rawEvent: "Stop" },
    { generation: null },
    { eventAt: T0.toISOString() },
    { eventAt: new Date(T0.getTime() + 1000).toISOString() },
    { eventAt: null },
    { eventAt: "invalid" },
    { generation: "previous-generation" },
  ])("does not clear newer, undated or other-occupant evidence: %j", (overrides) => {
    const store = fakeStore(hookRow({ eventAt: new Date(T0.getTime() - 1000).toISOString(), ...overrides }));
    expect(recordCodexLimitBanner({ store, resolveGeneration: () => "gen-1", sessionName: "guard@rig", banner: null, now: () => T0 })).toBe(false);
    expect(store.recordHookEvent).not.toHaveBeenCalled();
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
      seen.push({ session: sessionName, reset: banner?.resetText ?? null });
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

  async function recentMotion(sessionName: string) {
    const service = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => NOW.getTime() / 1000 - 1 },
      defaultWindowSeconds: 3,
      now: () => NOW,
    });
    await service.pollSeat(sessionName);
    return service;
  }

  it.each([false, true])("keeps a current limit over cached idle and terminal redraws (live motion: %s)", async (liveMotion) => {
    const db = createFullTestDb();
    try {
      const { sessionName } = seedCodexSeat(db);
      const store = new AgentActivityStore({
        db, eventBus: new EventBus(db), now: () => NOW,
        resolveOccupantGeneration: () => "current-generation",
      });
      const recorded = store.recordHookEvent({
        runtime: "codex",
        sessionName,
        hookEvent: "at_limit",
        generation: "current-generation",
        subtype: "try again at 4:14 AM",
        occurredAt: "2026-10-06T23:59:00.000Z",
      });
      expect(recorded.ok).toBe(true);

      const capturePaneContent = vi.fn(async () => BANNER);
      const out = (await attachAgentActivity(entries(sessionName), {
        tmuxAdapter: { capturePaneContent } as never,
        seatActivity: liveMotion ? await recentMotion(sessionName) : undefined,
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
      expect(out[0]!.agentActivity).toMatchObject({
        state: "unknown",
        reason: "usage_limit",
        evidenceSource: "runtime_hook",
        rawEvent: "at_limit",
        rawSubtype: "try again at 4:14 AM",
        evidence: "try again at 4:14 AM",
        stale: false,
        generation: "current-generation",
        generationProvenance: "resolved",
      });
      expect(capturePaneContent).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it.each([
    { name: "newer permission", hookAge: 2000, paneAge: 1000, expected: "permission_prompt" },
    { name: "equal permission", hookAge: 1000, paneAge: 1000, expected: "usage_limit" },
    { name: "older permission", hookAge: 1000, paneAge: 2000, expected: "usage_limit" },
    { name: "stale newer permission", hookAge: 6000, paneAge: 5000, expected: "usage_limit" },
    { name: "expired limit", hookAge: 600000, paneAge: 1000, expected: "permission_prompt" },
    { name: "previous-generation limit", hookAge: 0, paneAge: 1000, expected: "permission_prompt" },
    { name: "newer idle", hookAge: 2000, paneAge: 1000, expected: "idle_prompt" },
  ].flatMap(scenario => [false, true].map(liveMotion => ({ ...scenario, liveMotion }))))(
    "$name with live motion $liveMotion respects cached attention chronology",
    async ({ name, hookAge, paneAge, expected, liveMotion }) => {
      const db = createFullTestDb();
      try {
        const { sessionName } = seedCodexSeat(db);
        const store = new AgentActivityStore({
          db, eventBus: new EventBus(db), now: () => NOW,
          resolveOccupantGeneration: () => "current-generation",
        });
        expect(store.recordHookEvent({
          runtime: "codex", sessionName, hookEvent: "at_limit",
          generation: name === "previous-generation limit" ? "previous-generation" : "current-generation",
          occurredAt: new Date(NOW.getTime() - hookAge).toISOString(),
        }).ok).toBe(true);
        expect(store.getLatestForNode({ sessionName })).toMatchObject({
          rawEvent: "at_limit",
          reason: name === "previous-generation limit" ? "generation_mismatch"
            : name === "expired limit" ? "stale_runtime_hook" : "usage_limit",
        });
        let clock = new Date(NOW.getTime() - paneAge);
        const capturePaneContent = vi.fn(async () => name === "newer idle" ? "output\n❯ " : "Do you want to proceed?");
        const structuralActivity = new SeatStructuralActivityService({ capturePaneContent }, () => clock);
        if (name === "newer idle") structuralActivity.attachCodexLimitBanner((sessionName, banner, at) => {
          recordCodexLimitBanner({ store, resolveGeneration: () => "current-generation", sessionName, banner, now: () => at });
        });
        expect((await structuralActivity.pollSeat(sessionName, null, "codex"))?.state)
          .toBe(name === "newer idle" ? "agent_idle" : "attention");
        clock = NOW;
        capturePaneContent.mockClear();
        const out = await attachAgentActivity(entries(sessionName), {
          tmuxAdapter: { capturePaneContent } as never,
          activityStore: store, structuralActivity,
          seatActivity: liveMotion ? await recentMotion(sessionName) : undefined,
          now: NOW,
        });
        expect(out[0]!.agentActivity).toMatchObject({
          state: expected === "permission_prompt" ? "needs_input" : expected === "idle_prompt" ? (liveMotion ? "running" : "idle") : "unknown",
          reason: expected === "idle_prompt" && liveMotion ? "window_activity_motion" : expected,
          evidenceSource: expected === "usage_limit" ? "runtime_hook" : expected === "idle_prompt" && liveMotion ? "terminal_activity" : "pane_heuristic",
        });
        if (expected === "permission_prompt") {
          expect(out[0]!.agentActivity?.sampledAt).toBe(new Date(NOW.getTime() - paneAge).toISOString());
          expect(out[0]!.agentActivity?.evidence).toBe("Do you want to proceed?");
        }
        expect(capturePaneContent).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    },
  );

  it.each([
    { name: "whitespace-only capture", frame: " \n\t\n  " },
    { name: "unrecognized non-empty capture", frame: "unclassified output" },
    { name: "banner above draft composer", frame: `${BANNER}\n› Continue the task` },
    { name: "banner above indented empty composer", frame: `${BANNER}\n  › Ask Codex to do anything` },
  ])("does not clear a current limit for $name", async ({ frame }) => {
    const db = createFullTestDb();
    try {
      const { sessionName } = seedCodexSeat(db);
      let clock = NOW;
      const store = new AgentActivityStore({
        db, eventBus: new EventBus(db), now: () => clock,
        resolveOccupantGeneration: () => "current-generation",
      });
      const capturePaneContent = vi.fn(async () => BANNER);
      const structuralActivity = new SeatStructuralActivityService({ capturePaneContent }, () => clock);
      structuralActivity.attachCodexLimitBanner((sessionName, banner, at) => {
        recordCodexLimitBanner({ store, resolveGeneration: () => "current-generation", sessionName, banner, now: () => at });
      });
      await structuralActivity.pollSeat(sessionName, null, "codex");
      capturePaneContent.mockResolvedValue(frame);
      for (let poll = 1; poll <= 2; poll++) {
        clock = new Date(NOW.getTime() + poll * 1000);
        await structuralActivity.pollSeat(sessionName, null, "codex");
        expect.soft(store.getLatestForNode({ sessionName })).toMatchObject({ rawEvent: "at_limit", reason: "usage_limit" });
        const out = await attachAgentActivity(entries(sessionName), {
          tmuxAdapter: { capturePaneContent } as never, activityStore: store, structuralActivity,
          seatActivity: await recentMotion(sessionName), now: clock,
        });
        expect.soft(out[0]!.agentActivity).toMatchObject({ reason: "usage_limit" });
      }
      expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.activity'").get()).toEqual({ n: 1 });
      capturePaneContent.mockResolvedValue("• Working (1s • esc to interrupt)\n› Ask Codex to do anything");
      clock = new Date(NOW.getTime() + 3000);
      expect((await structuralActivity.pollSeat(sessionName, null, "codex"))?.state).toBe("agent_active");
      expect(store.getLatestForNode({ sessionName })).toMatchObject({ reason: "usage_limit_cleared" });
    } finally { db.close(); }
  });

  it.each([
    { name: "submitted prompt followed by actual work", draft: "› Continue the task\n◦ Working (2s • esc to interrupt)", limit: false },
    ...["Explain this example", ""].map(first => ({ name: `unsent nested draft: ${first || "blank first line"}`,
      draft: `› ${first}\n  › Continue the task\n  • Working (1s • esc to interrupt)`, limit: true })),
  ])("keeps store, inventory and --active consistent across repeated polls: $name", async ({ draft, limit }) => {
    const db = createFullTestDb();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { sessionName } = seedCodexSeat(db);
      let clock = NOW;
      const deps = { db, eventBus: new EventBus(db), now: () => clock, resolveOccupantGeneration: () => "current-generation" };
      const store = new AgentActivityStore(deps);
      const capturePaneContent = vi.fn(async () => BANNER);
      const structuralActivity = new SeatStructuralActivityService({ capturePaneContent }, () => clock);
      structuralActivity.attachCodexLimitBanner((sessionName, banner, at) => {
        recordCodexLimitBanner({ store, resolveGeneration: () => "current-generation", sessionName, banner, now: () => at });
      });
      await structuralActivity.pollSeat(sessionName, null, "codex");
      expect(store.getLatestForNode({ sessionName })).toMatchObject({ reason: "usage_limit" });
      capturePaneContent.mockResolvedValue(`${BANNER}\n${draft}`);
      for (let poll = 1; poll <= 2; poll++) {
        clock = new Date(NOW.getTime() + poll * 1000);
        expect((await structuralActivity.pollSeat(sessionName, null, "codex"))?.state).toBe("agent_active");
        expect.soft(new AgentActivityStore(deps).getLatestForNode({ sessionName })).toMatchObject({ reason: limit ? "usage_limit" : "usage_limit_cleared" });
        const motion = new SeatActivityService({ tmux: { readPaneLastActivity: async () => clock.getTime() / 1000 }, defaultWindowSeconds: 3, now: () => clock });
        await motion.pollSeat(sessionName);
        const out = await attachAgentActivity(entries(sessionName), {
          tmuxAdapter: { capturePaneContent } as never, activityStore: store, structuralActivity, seatActivity: motion, now: clock,
        });
        expect.soft(out[0]!.agentActivity).toMatchObject(limit
          ? { state: "unknown", reason: "usage_limit" } : { state: "running", reason: "mid_work_pattern" });
        log.mockClear();
        await psCommand({
          lifecycleDeps: {
            exists: (path) => path === STATE_FILE,
            readFile: () => JSON.stringify({ pid: 1, port: 1, db: "fixture.sqlite", startedAt: NOW.toISOString() }),
            isProcessAlive: () => true, fetch: async () => ({ ok: true }),
          } as never,
          clientFactory: () => ({ get: async (path: string) => ({ status: 200, data: path.includes("/nodes")
            ? [{ canonicalSessionName: sessionName, logicalId: "dev.qa", agentActivity: out[0]!.agentActivity }]
            : [{ rigId: "fixture", rigName: "test-rig", status: "running" }] }) }) as never,
        }).parseAsync(["node", "rig", "--nodes", "--active", "--json", "--rig", "test-rig"]);
        expect.soft(JSON.parse(log.mock.calls[0]![0])).toMatchObject(limit
          ? { totalNodes: 0, entries: [] } : { totalNodes: 1, entries: [{ canonicalSessionName: sessionName }] });
      }
      expect.soft(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.activity'").get()).toEqual({ n: limit ? 1 : 2 });
    } finally { log.mockRestore(); db.close(); }
  });

  it("ends a limit durably after a valid newer poll, without inventing work", async () => {
    const db = createFullTestDb();
    try {
      const { sessionName } = seedCodexSeat(db);
      let clock = NOW;
      let generation = "current-generation";
      const deps = { db, eventBus: new EventBus(db), now: () => clock, resolveOccupantGeneration: () => generation };
      const store = new AgentActivityStore(deps);
      const capturePaneContent = vi.fn(async (): Promise<string | null> => BANNER);
      const structuralActivity = new SeatStructuralActivityService({ capturePaneContent }, () => clock);
      structuralActivity.attachCodexLimitBanner((sessionName, banner, at) => {
        recordCodexLimitBanner({ store, resolveGeneration: () => generation, sessionName, banner, now: () => at });
      });
      const read = async (seatActivity?: SeatActivityService) => (await attachAgentActivity(entries(sessionName), {
        tmuxAdapter: { capturePaneContent } as never, structuralActivity, seatActivity,
        activityStore: new AgentActivityStore(deps), now: clock,
      }))[0]!.agentActivity;
      await structuralActivity.pollSeat(sessionName, null, "codex");
      expect(await read(await recentMotion(sessionName))).toMatchObject({ reason: "usage_limit" });
      clock = new Date(NOW.getTime() + 1000);
      capturePaneContent.mockRejectedValueOnce(new Error("capture failed")).mockResolvedValueOnce(null);
      for (let i = 0; i < 2; i++) {
        await structuralActivity.pollSeat(sessionName, null, "codex");
        expect(await read()).toMatchObject({ reason: "usage_limit" });
      }
      await structuralActivity.pollSeat(sessionName, new Map([[sessionName, { text: "output\n❯ ", capturedAt: NOW }]]), "codex");
      expect(await read()).toMatchObject({ reason: "usage_limit" });
      capturePaneContent.mockResolvedValue("output\n❯ ");
      await structuralActivity.pollSeat(sessionName, null, "codex");
      expect.soft(await read()).toMatchObject({ state: "idle", reason: "idle_prompt" });
      expect.soft(new AgentActivityStore(deps).getLatestForNode({ sessionName })).toMatchObject({
        state: "unknown", reason: "usage_limit_cleared", eventAt: clock.toISOString(), generation: "current-generation",
      });
      const eventCount = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.activity'").get();
      clock = new Date(NOW.getTime() + 2000);
      capturePaneContent.mockResolvedValue("new working output");
      await structuralActivity.pollSeat(sessionName, null, "codex");
      const motion = new SeatActivityService({ tmux: { readPaneLastActivity: async () => clock.getTime() / 1000 }, defaultWindowSeconds: 3, now: () => clock });
      await motion.pollSeat(sessionName);
      const recovered = await read(motion);
      expect.soft(recovered).toMatchObject({ state: "running", reason: "window_activity_motion" });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await psCommand({
          lifecycleDeps: {
            exists: (path) => path === STATE_FILE,
            readFile: () => JSON.stringify({ pid: 1, port: 1, db: "fixture.sqlite", startedAt: NOW.toISOString() }),
            isProcessAlive: () => true, fetch: async () => ({ ok: true }),
          } as never,
          clientFactory: () => ({ get: async (path: string) => ({ status: 200, data: path.includes("/nodes")
            ? [{ canonicalSessionName: sessionName, logicalId: "dev.qa", agentActivity: recovered }]
            : [{ rigId: "fixture", rigName: "test-rig", status: "running" }] }) }) as never,
        }).parseAsync(["node", "rig", "--nodes", "--active", "--json", "--rig", "test-rig"]);
        expect.soft(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ totalNodes: 1, entries: [{ canonicalSessionName: sessionName, agentActivity: { state: "running" } }] });
      } finally { log.mockRestore(); }
      expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'agent.activity'").get()).toEqual(eventCount);
      capturePaneContent.mockResolvedValue("Do you want to proceed?");
      await structuralActivity.pollSeat(sessionName, null, "codex");
      expect(await read(motion)).toMatchObject({ state: "needs_input", reason: "permission_prompt" });
      capturePaneContent.mockResolvedValue(BANNER);
      await structuralActivity.pollSeat(sessionName, null, "codex");
      expect(await read(motion)).toMatchObject({ reason: "usage_limit" });
      generation = "next-generation";
      clock = new Date(NOW.getTime() + 3000);
      store.recordHookEvent({ runtime: "codex", sessionName, hookEvent: "at_limit", generation });
      await structuralActivity.pollSeat(sessionName, new Map([[sessionName, {
        text: "old occupant output", capturedAt: new Date(NOW.getTime() + 2500),
      }]]), "codex");
      expect(await read(motion)).toMatchObject({ reason: "usage_limit", generation });
    } finally {
      db.close();
    }
  });

  it.each(["stale_runtime_hook", "generation_mismatch"].flatMap(reason =>
    [false, true].map(liveMotion => ({ reason, liveMotion })),
  ))("a demoted limit ($reason) yields to structural activity and motion ($liveMotion)", async ({ reason, liveMotion }) => {
    const db = createFullTestDb();
    try {
      const { sessionName } = seedCodexSeat(db);
      const store = new AgentActivityStore({
        db, eventBus: new EventBus(db), now: () => NOW,
        resolveOccupantGeneration: () => "current-generation",
      });
      const recorded = store.recordHookEvent({
        runtime: "codex",
        sessionName,
        hookEvent: "at_limit",
        subtype: "try again at 4:14 AM",
        generation: reason === "generation_mismatch" ? "previous-generation" : "current-generation",
        occurredAt: reason === "stale_runtime_hook" ? "2026-10-06T23:50:00.000Z" : NOW.toISOString(),
      });
      expect(recorded.ok).toBe(true);

      expect(store.getLatestForNode({ sessionName })).toMatchObject({ reason, stale: true });
      const out = (await attachAgentActivity(entries(sessionName), {
        tmuxAdapter: { capturePaneContent: async () => BANNER } as never,
        activityStore: store,
        seatActivity: liveMotion ? await recentMotion(sessionName) : undefined,
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
      expect(out[0]!.agentActivity.reason).toBe(liveMotion ? "window_activity_motion" : "idle_prompt");
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
