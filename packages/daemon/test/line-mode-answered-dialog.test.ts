import { describe, it, expect, vi } from "vitest";
import { SessionTransport, classifyPaneActivity } from "../src/domain/session-transport.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// A line-mode community harness prints a numbered dialog, the person's answer and more output into its scrollback, then
// a later prompt. As #2520 reads Claude's empty input box, that later prompt makes the dialog history: the seat isn't
// asking now, and a send delivers. A dialog with no later prompt below it is still open and still refuses. The screens
// are modelled on a line-mode harness whose answered dialog read as a live selection_prompt for over a minute after its
// turn's Stop, refusing every send until the text scrolled away.
const asked = ["❯ ask", "  [hook PreToolUse/Bash seq 14 → 200]", "", " Bash command: rm -rf ./build-cache",
  " Do you want to proceed?", "❯ 1. Yes", "  2. No, and tell the agent what to do differently"];
const open = asked.join("\n");
const after = ["1", "  ran: rm -rf ./build-cache", "  [hook PostToolUse/Bash seq 16 → 200]", "  [hook Stop/end_turn seq 17 → 200]"];
const answered = [...asked, ...after, "❯ "].join("\n");
// The same, after a screen clear pushed it all into scrollback above a fresh prompt, and with a draft at the new prompt.
const clearedAbove = [...asked, ...after, "❯ ", "", "", "", "", "❯ "].join("\n");
const draftBelow = [...asked, ...after, "❯ next task, not sent yet"].join("\n");
// The highlight on the second row: still the open dialog, not a later prompt.
const openSecondRow = ["❯ ask", " Allow this edit?", "  1. Yes", "❯ 2. No"].join("\n");
const prompts = new Set(["selection_prompt", "permission_prompt"]);
const asking = (pane: string, runtime?: string) => {
  const c = classifyPaneActivity(pane, runtime === undefined ? {} : { runtime });
  return c.state === "attention" && prompts.has(c.reason ?? "");
};

describe("an answered numbered dialog in a line-mode community harness's scrollback", () => {
  it("is history below a later prompt; with no later prompt the dialog is still open", () => {
    for (const pane of [answered, clearedAbove, draftBelow]) expect(asking(pane, "synth"), pane).toBe(false);
    for (const pane of [open, openSecondRow]) expect(asking(pane, "synth"), pane).toBe(true);
    expect(classifyPaneActivity(open, { runtime: "synth" }).reason).toBe("selection_prompt");
  });

  it("changes nothing for Claude, Codex or a read without a runtime: they keep their own dialog readers", () => {
    for (const runtime of ["claude-code", "codex", undefined]) expect(asking(answered, runtime), String(runtime)).toBe(true);
  });

  it("reads the same in the structural recognizer, which reads a community seat's screen as its runtime's", async () => {
    const read = async (pane: string, communityHarness: string | null) =>
      (await new SeatStructuralActivityService({ capturePaneContent: async () => pane } as never).pollSeat("w@r", null, communityHarness, communityHarness))!;
    expect((await read(answered, "synth")).state).not.toBe("attention");
    expect(await read(open, "synth")).toMatchObject({ state: "attention", reason: "selection_prompt" });
    expect((await read(answered, null)).state).toBe("attention");
  });
});

describe("a send to a line-mode community seat", () => {
  async function send(pane: string, hookAgeMs: number | null) {
    const db = createFullTestDb();
    try {
      const repo = new RigRepository(db), registry = new SessionRegistry(db), rig = repo.createRig("line-mode");
      const node = repo.addNode(rig.id, "work.worker", { runtime: "synth", role: "worker" });
      const name = "work-worker@line-mode";
      const session = registry.registerSession(node.id, name);
      registry.updateStatus(session.id, "running");
      registry.updateBinding(node.id, { tmuxSession: name });
      registry.recordCommunityHarnessSelection(session.id, "synth");
      const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
      const now = new Date("2026-11-26T01:00:00Z");
      const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => now,
        resolveOccupantGeneration: id => registry.currentOccupantTenure(id)?.generationUuid ?? null,
        isRegisteredOccupantGeneration: (id, g) => Boolean(db.prepare("SELECT 1 FROM occupant_tenures WHERE node_id=? AND generation_uuid=?").get(id, g)),
      });
      // The harness's own Stop after the answer, older than the send window: the stale-idle path reads the pane too.
      if (hookAgeMs !== null) expect(store.recordHookEvent({ runtime: "synth", sessionName: name, hookEvent: "Stop", subtype: "end_turn",
        generation, occurredAt: new Date(now.getTime() - hookAgeMs).toISOString() }).ok).toBe(true);
      const paste = vi.fn(async () => ({ ok: true as const })), enter = vi.fn(async () => ({ ok: true as const }));
      const adapter = { hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
        getPaneCommand: async () => "node", getPanePid: async () => null, listPanes: async () => [],
        hasSessionEnv: async () => false, capturePaneContent: vi.fn(async () => pane), sendText: paste, sendKeys: enter,
      } as unknown as TmuxAdapter;
      const transport = new SessionTransport({ db, rigRepo: repo, sessionRegistry: registry, tmuxAdapter: adapter,
        agentActivityStore: store, now: () => now, sleep: async () => undefined, activityEndpointFile: () => null });
      const result = await transport.send(name, "Ordinary synthetic peer message");
      return { result, pasted: paste.mock.calls.length };
    } finally { db.close(); }
  }

  it.each([["no hook", null], ["the harness's own Stop after the answer", 60_000]] as const)(
    "delivers past an answered dialog with %s, and still refuses at the same dialog open", async (_label, hookAgeMs) => {
      for (const pane of [answered, clearedAbove]) {
        const delivered = await send(pane, hookAgeMs);
        expect(delivered.result.ok, JSON.stringify(delivered.result)).toBe(true);
        expect(delivered.pasted).toBe(1);
      }
      const refused = await send(open, hookAgeMs);
      expect(refused.result).toMatchObject({ ok: false, reason: "target_needs_input" });
      expect(refused.pasted).toBe(0);
    });
});
