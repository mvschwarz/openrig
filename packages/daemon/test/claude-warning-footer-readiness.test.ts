import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { classifyPaneActivity, SessionTransport } from "../src/domain/session-transport.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// The terminal structure and warning text are retained from Claude 2.1.220 captures.
// Conversation/paths are omitted. The weekly-limit full screen was captured BEFORE
// down, not inside the failed resumed send; that attempt retained only its footer.
const update = "✘ Auto-update failed: no write permission to npm prefix · Run claude doctor";
const focus = "tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and re…";
const weekly = "You've used 96% of your weekly limit · resets 12pm (UTC)";
const bar = "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents";
const border = "────────────────────────────────────────────────────────────────────────────────";
function pane(trailers: string[], composer = "❯\u00a0", before = "● Ready.\n\n✻ Crunched for 2s") {
  return [before, "", border, composer, border, `  ${bar}`, ...trailers.map(line => `  ${line}`), ""].join("\n");
}
const captures = [
  ["upgrade post-refusal focus warning", pane([update, focus])],
  ["fresh pre-down weekly warning", pane([update, weekly])],
  ["fresh post-refusal update warning", pane([update])],
] as const;

describe("Claude composer below noninteractive status warnings", () => {
  it.each(captures)("recognizes the empty composer: %s", (_name, content) => {
    expect(classifyPaneActivity(content)).toMatchObject({ state: "agent_idle", reason: "idle_prompt", evidence: "❯" });
  });

  it.each([
    ["draft", pane([update, focus], "❯ unfinished message")],
    ["permission", pane([update, focus], "❯\u00a0", "Do you want to proceed?\n❯ 1. Yes\n  2. No")],
    ["working", pane([update, focus], "❯\u00a0", "✶ Thinking… (6s · ↑ 284 tokens · thinking)")],
    ["spinner", pane([update, focus], "❯\u00a0", "⠋ Processing")],
    ["interrupt", pane([update, weekly], "❯\u00a0", "esc to interrupt")],
    ["multiline draft", pane([update, focus], "❯\u00a0\n  unfinished second line")],
    ["no input border", pane([update, focus]).replaceAll(border, "")],
    ["mode and warning only", `${bar}\n${update}`],
    ["history followed by another screen", `${pane([update, focus])}\nShell output\n$`],
    ["warning only", `${update}\n${focus}`],
    ["no mode bar", pane([update, focus]).replace(bar, "custom status")],
    ["no composer", pane([update, focus]).replace("❯\u00a0", "")],
    ["later output", `${pane([update, focus])}\nLater output with no current composer`],
    ["blocking limit", pane([update, "You've hit your limit · /upgrade"])],
    ["exhausted weekly limit", pane([update, weekly.replace("96%", "100%")])],
    ["unrelated suffix", pane([update, "Proceed with the operation?"])],
    ["login", pane([update, "Not logged in · Run /login"])],
  ])("does not invent idle from %s", (_name, content) => {
    expect(classifyPaneActivity(content).state).not.toBe("agent_idle");
  });

  it("reports a draft as attention rather than using its mode bar", () => {
    expect(classifyPaneActivity(pane([update, focus], "❯ unfinished message")))
      .toMatchObject({ state: "attention", reason: "prompt_draft" });
  });

  it.each(captures)("shares recognition with the structural-activity consumer: %s", async (_name, content) => {
    const service = new SeatStructuralActivityService({ capturePaneContent: async () => content });
    expect(await service.pollSeat("seat@rig")).toMatchObject({ state: "agent_idle", reason: "idle_prompt" });
  });

  it("keeps structural draft and warning-only observations unsendable", async () => {
    for (const content of [pane([update, focus], "❯ unfinished message"), focus]) {
      const service = new SeatStructuralActivityService({ capturePaneContent: async () => content });
      expect((await service.pollSeat("seat@rig"))?.state).not.toBe("agent_idle");
    }
  });
});

describe("first guarded Claude send with retained warning-shaped composer", () => {
  let db: Database.Database | undefined;
  afterEach(() => { db?.close(); db = undefined; });

  function setup(content: string, event = "SessionStart", ageMs = 16_000, priorGeneration = false) {
    db = createFullTestDb();
    const repo = new RigRepository(db);
    const registry = new SessionRegistry(db);
    const rig = repo.createRig("footer-test");
    const node = repo.addNode(rig.id, "worker.a", { runtime: "claude-code", role: "worker" });
    const name = "worker-a@footer-test";
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name });
    const prior = registry.currentOccupantTenure(node.id)!.generationUuid;
    const generation = priorGeneration
      ? registry.mintOccupantTenure(node.id, "handover").generationUuid
      : prior;
    const now = new Date("2026-10-04T19:20:00Z");
    const store = new AgentActivityStore({
      db, eventBus: new EventBus(db), now: () => now,
      resolveOccupantGeneration: id => registry.currentOccupantTenure(id)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (id, value) => Boolean(db!.prepare(
        "SELECT 1 FROM occupant_tenures WHERE node_id = ? AND generation_uuid = ?"
      ).get(id, value)),
    });
    expect(store.recordHookEvent({ runtime: "claude-code", sessionName: name,
      hookEvent: event, subtype: event === "SessionStart" ? "resume" : undefined,
      occurredAt: new Date(now.getTime() - ageMs).toISOString(),
      generation: priorGeneration ? prior : generation,
    }).ok).toBe(true);
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const tmux = {
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" as const }),
      capturePaneContent: async () => content,
      getPaneCommand: async () => "claude",
      listPanes: async () => [], getPanePid: async () => null,
      sendText, sendKeys,
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo: repo, sessionRegistry: registry,
      tmuxAdapter: tmux, agentActivityStore: store, now: () => now, sleep: async () => undefined, waitForIdlePollMs: 1 });
    return { transport, store, name, sendText, sendKeys };
  }

  it.each(captures)("sends once from current pane after SessionStart freshness: %s", async (_name, content) => {
    const f = setup(content);
    const result = await f.transport.send(f.name, "ordinary marker", { waitForIdleMs: 200 });
    expect(result).toMatchObject({ ok: true, sent: true, activity: { state: "idle", evidenceSource: "pane_heuristic" } });
    expect(f.sendText).toHaveBeenCalledTimes(1);
    expect(f.sendKeys).toHaveBeenCalledTimes(1);
    expect(f.sendKeys).toHaveBeenCalledWith(f.name, ["Enter"]);
    // No synthetic Stop or state rewrite is needed to admit the current pane.
    expect(f.store.getLatestForNode({ sessionName: f.name })).toMatchObject({ state: "unknown", rawEvent: "SessionStart", stale: false });
  });

  it.each([
    ["fresh SessionStart", "SessionStart", 1000, captures[0][1], false],
    ["fresh permission hook", "PermissionRequest", 1000, captures[0][1], false],
    ["fresh working hook", "UserPromptSubmit", 1000, captures[0][1], false],
    ["prior-generation Stop without current pane evidence", "Stop", 1000, focus, true],
  ] as const)("keeps %s from authorizing input", async (_name, event, age, content, prior) => {
    const f = setup(content, event, age, prior);
    const result = await f.transport.send(f.name, "ordinary marker", { waitForIdleMs: 20 });
    expect(result).toMatchObject({ ok: false, sent: false });
    expect(f.sendText).not.toHaveBeenCalled();
    expect(f.sendKeys).not.toHaveBeenCalled();
    if (prior) expect(f.store.getLatestForNode({ sessionName: f.name })).toMatchObject({ state: "unknown", reason: "generation_mismatch", stale: true });
  });
});
