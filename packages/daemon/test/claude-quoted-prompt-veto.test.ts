import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { SessionTransport, classifyPaneActivity } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// A working Claude seat quotes approval-prompt text in its own output: a send or queue wake to it must not read that
// text as the dialogue it waits on. Claude's own timer row above its empty input box shows the turn running, so no
// dialogue is open. A real dialogue replaces the input box (the native captures here), and a prompt drawn above the
// input box with no timer row (send-prompt-guard's FORWARD-FIX layout) stays protected. Quoted lines are constructed.
const permission = JSON.parse(readFileSync(new URL("./fixtures/claude-permission-2.1.300.json", import.meta.url), "utf8")) as Record<string, string>;
const question = JSON.parse(readFileSync(new URL("./fixtures/claude-question-picker-2.1.289.json", import.meta.url), "utf8")) as Record<string, string>;
const border = "────────────────────────────────────────────";
const bar = "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents";
const quoted = ["● I answered review-r2's prompt. It read:", "  Would you like to run the following command?",
  "  › 1. Yes, proceed (y)", "  2. No, and tell Codex what to do differently (esc)", "● Claude's own prompt read: Do you want to proceed?"];
const input = (status: string | null, prompt = "❯ ", footer = bar) => [...(status ? [status] : []), border, prompt, border, footer];
const working = [...quoted, ...input("✶ Churning… (12s · ↓ 300 tokens)")].join("\n");
const workingInHook = [...quoted, ...input("✶ Churning… (running PostToolUse hook · 3m 12s · ↓ 9 tokens)")].join("\n");
const idle = [...quoted, ...input(null)].join("\n");
// send-prompt-guard's FORWARD-FIX layout: a real prompt above the input box, with no timer row. Here with a listed phrase.
const promptAboveInput = ["Do you want to make this edit to session-transport.ts?", "", "❯ 1. Yes",
  "  2. Yes, allow all edits in domain/ this session", "  3. No, and tell Claude what to do differently", "",
  "  Use ↑↓ to choose, enter to confirm", "", ...input(null, "❯ ", "  ⏵⏵ accept edits on (shift+tab to cycle)")].join("\n");
const mcpMenu = ["2 new MCP servers found in this project", "Select any you wish to enable.",
  "MCP servers may execute code or access system resources. All tool calls", "require approval. Learn more in the MCP documentation.",
  "❯ [✔] dummy1", "  [✔] dummy2", "     Enable selected", "Space to select · Esc to reject all"].join("\n");
// Real dialogues, with the same quoted history above them.
const dialogs: Record<string, string> = {
  permissionBash: `${quoted.join("\n")}\n${permission.bash}`,
  permissionEdit: `${quoted.join("\n")}\n${permission.edit}`,
  permissionWebFetch: `${quoted.join("\n")}\n${permission.webFetch}`,
  askUserQuestion: `${quoted.join("\n")}\n${question.picker100}`,
  mcpMenu: `${quoted.join("\n")}\n${mcpMenu}`,
};

describe("quoted approval text above Claude's current input box", () => {
  it("is history to a Claude read while Claude's timer row shows the turn running", () => {
    for (const pane of [working, workingInHook]) {
      for (const options of [{ runtime: "claude-code" }, { runtime: "claude-code", currentClaudeDialogueOnly: true }]) {
        expect(classifyPaneActivity(pane, options), JSON.stringify(options)).toMatchObject({ state: "agent_active", reason: "mid_work_pattern" });
      }
    }
  });

  it.each(Object.entries({ ...dialogs, promptAboveInput }))("a real dialogue still reads as attention: %s", (_name, pane) => {
    for (const options of [{ runtime: "claude-code" }, { runtime: "claude-code", currentClaudeDialogueOnly: true }, {}]) {
      expect(classifyPaneActivity(pane, options).state, JSON.stringify(options)).toBe("attention");
    }
  });

  it("changes nothing without the Claude runtime, its timer row, a recognized mode bar, or an empty input box", () => {
    for (const pane of [working, workingInHook]) {
      expect(classifyPaneActivity(pane).state).toBe("attention");
      expect(classifyPaneActivity(pane, { runtime: "codex" }).state).toBe("attention");
    }
    // No timer row: an idle seat quoting prompt text is not told apart from a prompt above the input box, so it stays refused.
    for (const options of [{ runtime: "claude-code" }, { runtime: "claude-code", currentClaudeDialogueOnly: true }]) {
      expect(classifyPaneActivity(idle, options).state).toBe("attention");
    }
    const unrecognizedBar = [...quoted, ...input("✶ Churning… (12s · ↓ 300 tokens)", "❯ ", "⏸ manual mode on · ← for agents")].join("\n");
    const notAModeBar = [...quoted, ...input("✶ Churning… (12s · ↓ 300 tokens)", "❯ ", "Esc to cancel · Tab to amend")].join("\n");
    const draft = [...quoted, ...input("✶ Churning… (12s · ↓ 300 tokens)", "❯ unfinished message")].join("\n");
    for (const pane of [unrecognizedBar, notAModeBar, draft]) {
      expect(classifyPaneActivity(pane, { runtime: "claude-code" })).toEqual(classifyPaneActivity(pane));
    }
  });
});

describe("a send to a working Claude seat with quoted approval text", () => {
  async function send(pane: string, hookEvent: "UserPromptSubmit" | null) {
    const db = createFullTestDb();
    try {
      const repo = new RigRepository(db), registry = new SessionRegistry(db), rig = repo.createRig("quoted-test");
      const node = repo.addNode(rig.id, "worker.a", { runtime: "claude-code", role: "worker" });
      const name = "worker-a@quoted-test";
      const session = registry.registerSession(node.id, name);
      registry.updateStatus(session.id, "running");
      registry.updateBinding(node.id, { tmuxSession: name });
      const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
      const now = new Date("2026-10-25T01:00:00Z");
      const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => now,
        resolveOccupantGeneration: id => registry.currentOccupantTenure(id)?.generationUuid ?? null,
        isRegisteredOccupantGeneration: (id, g) => Boolean(db.prepare("SELECT 1 FROM occupant_tenures WHERE node_id=? AND generation_uuid=?").get(id, g)),
      });
      // A fresh running hook (1 s old) takes the #1864 path; none takes the ordinary pane probe.
      if (hookEvent) expect(store.recordHookEvent({ runtime: "claude-code", sessionName: name, hookEvent, generation,
        occurredAt: new Date(now.getTime() - 1_000).toISOString() }).ok).toBe(true);
      const paste = vi.fn(async () => ({ ok: true as const })), enter = vi.fn(async () => ({ ok: true as const }));
      const adapter = { hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
        getPaneCommand: async () => "claude", getPanePid: async () => null, listPanes: async () => [],
        hasSessionEnv: async () => false, capturePaneContent: vi.fn(async () => pane), sendText: paste, sendKeys: enter,
      } as unknown as TmuxAdapter;
      const transport = new SessionTransport({ db, rigRepo: repo, sessionRegistry: registry, tmuxAdapter: adapter,
        agentActivityStore: store, now: () => now, sleep: async () => undefined, activityEndpointFile: () => null });
      const result = await transport.send(name, "Ordinary synthetic peer message");
      return { result, pasted: paste.mock.calls.length };
    } finally { db.close(); }
  }

  it.each([["the ordinary pane probe", null], ["the fresh running-hook path (#1864)", "UserPromptSubmit"]] as const)(
    "is delivered through %s", async (_path, hook) => {
      const { result, pasted } = await send(working, hook);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(pasted).toBe(1);
    });

  it.each([["the ordinary pane probe", null], ["the fresh running-hook path (#1864)", "UserPromptSubmit"]] as const)(
    "is still refused at a real permission dialogue through %s", async (_path, hook) => {
      for (const pane of [dialogs.permissionBash!, dialogs.mcpMenu!]) {
        const { result, pasted } = await send(pane, hook);
        expect(result).toMatchObject({ ok: false, reason: "target_needs_input" });
        expect(pasted).toBe(0);
      }
    });
});
