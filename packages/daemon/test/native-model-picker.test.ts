// The program's own /model picker, from real captures of OpenRig seats on a stand-in model: Claude Code 2.1.282 (the
// transcript above it removed, a synthetic seat label) and 2.1.322, and Codex 0.167.2's model and reasoning-level steps.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { classifyPaneActivity, SessionTransport } from "../src/domain/session-transport.js";
import { currentClaudeModelMenu, currentCodexModelPicker } from "../src/domain/native-model-picker.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const claude = fixture("claude-model-2.1.282.txt");
// The highlight on the first model, with wrapped descriptions: its row is above the last 12 lines a generic scan reads.
const claudeDefault = fixture("claude-model-2.1.322.txt");
const codexModel = fixture("codex-model-0.167.2.txt");
const codexReasoning = fixture("codex-reasoning-0.167.2.txt");
const rule = "─".repeat(60);
const claudeComposer = `${rule}\n❯ \n${rule}\n  ⏵⏵ accept edits on (shift+tab to cycle)`;
const codexComposer = "› Ask Codex to do anything\n\n  gpt-6.1-sol default · ~/work";

describe("the program's own model picker", () => {
  it.each([
    ["Claude 2.1.282, as captured", claude, "claude-code", "Select model"],
    ["Claude 2.1.322, the highlight above the scan window", claudeDefault, "claude-code", "Select model"],
    ["Codex 0.167.2, the model popup", codexModel, "codex", "Select Model and Effort"],
    ["Codex 0.167.2, the reasoning-level step", codexReasoning, "codex", "Select Reasoning Level for GPT-6.1-Sol"],
  ] as const)("recognizes %s as a current selector, dialogue-only reads included", (_name, pane, runtime, header) => {
    expect(classifyPaneActivity(pane, { runtime })).toMatchObject({ state: "attention", reason: "selection_prompt", evidence: header });
    expect(classifyPaneActivity(pane, { runtime, currentClaudeDialogueOnly: true })).toMatchObject({ reason: "selection_prompt", evidence: header });
  });

  it.each([
    ["a later empty composer", claude + claudeComposer, codexModel + codexComposer],
    ["a later draft", claude + claudeComposer.replace("❯ ", "❯ keep my draft"), codexModel + codexComposer.replace("Ask Codex to do anything", "keep my draft")],
    ["quoted", claude.split("\n").map(line => "> " + line).join("\n"), codexModel.split("\n").map(line => "> " + line).join("\n")],
    ["fenced output", "```text\n" + claude + "```", "```text\n" + codexModel + "```"],
    ["an unknown footer", claude.replace("Enter to set as default", "Enter to approve"), codexModel.replace("enter select · esc back", "enter approve · esc back")],
    ["no header", claude.replace("Select model", "Select tools"), codexModel.replace("Select Model and Effort", "Select Tools")],
    ["no highlighted row", claude.replace("❯ 6.", "  6."), codexModel.replace("› 1.", "  1.")],
    ["two highlighted rows", claude.replace("    4. Opus", "  ❯ 4. Opus"), codexModel.replace("  4. GPT-6-Luna", "› 4. GPT-6-Luna")],
  ])("doesn't read %s as a current picker", (_name, claudePane, codexPane) => {
    expect(currentClaudeModelMenu(claudePane)).toBeNull();
    expect(currentCodexModelPicker(codexPane)).toBeNull();
  });

  it("reads each program's picker only on that program's pane", () => {
    expect(classifyPaneActivity(codexModel, { runtime: "claude-code", currentClaudeDialogueOnly: true }).reason).not.toBe("selection_prompt");
    expect(classifyPaneActivity(claude, { runtime: "codex", currentClaudeDialogueOnly: true }).reason).not.toBe("selection_prompt");
  });
});

type Hook = "Stop" | "UserPromptSubmit" | "SessionStart";
async function send(runtime: "claude-code" | "codex", pane: string, hook: Hook | null) {
  const db = createFullTestDb();
  try {
    const repo = new RigRepository(db), registry = new SessionRegistry(db), rig = repo.createRig("picker");
    const node = repo.addNode(rig.id, "worker.a", { runtime, role: "worker" });
    const name = "worker-a@picker";
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name });
    const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
    const now = new Date("2026-11-12T17:00:00Z");
    const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => now,
      resolveOccupantGeneration: (id) => registry.currentOccupantTenure(id)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (id, g) => Boolean(db.prepare(
        "SELECT 1 FROM occupant_tenures WHERE node_id=? AND generation_uuid=?").get(id, g)),
    });
    if (hook) expect(store.recordHookEvent({ runtime, sessionName: name, hookEvent: hook, generation,
      occurredAt: new Date(now.getTime() - 1_000).toISOString() }).ok).toBe(true);
    const paste = vi.fn(async () => ({ ok: true as const })), keys = vi.fn(async () => ({ ok: true as const }));
    const adapter = { hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
      getPaneCommand: async () => (runtime === "codex" ? "codex" : "claude"), getPanePid: async () => null, listPanes: async () => [],
      hasSessionEnv: async () => false, capturePaneContent: async () => pane, sendText: paste, sendKeys: keys,
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo: repo, sessionRegistry: registry, tmuxAdapter: adapter,
      agentActivityStore: store, now: () => now, sleep: async () => undefined, activityEndpointFile: () => null });
    const result = await transport.send(name, "Ordinary synthetic peer message");
    return { result, written: paste.mock.calls.length + keys.mock.calls.length };
  } finally { db.close(); }
}

describe("an ordinary send never types into an open model picker", () => {
  it.each([
    ["Claude, no hooks", "claude-code", claudeDefault, null],
    ["Claude, a fresh Stop hook", "claude-code", claudeDefault, "Stop"],
    ["Codex, no hooks", "codex", codexModel, null],
    ["Codex, a fresh Stop hook", "codex", codexModel, "Stop"],
    ["Codex, the reasoning-level step after a fresh Stop hook", "codex", codexReasoning, "Stop"],
    // Codex opens /model during a running turn too, and a fresh SessionStart reads unknown on both programs.
    ["Codex, a fresh UserPromptSubmit hook (a running turn)", "codex", codexModel, "UserPromptSubmit"],
    ["Codex, a fresh SessionStart hook", "codex", codexModel, "SessionStart"],
    ["Claude, a fresh SessionStart hook", "claude-code", claudeDefault, "SessionStart"],
    ["Claude, a fresh UserPromptSubmit hook (a running turn)", "claude-code", claudeDefault, "UserPromptSubmit"],
  ] as const)("%s: refused before any input", async (_name, runtime, pane, hook) => {
    const sent = await send(runtime, pane, hook);
    // One assertion, so a failure shows both what the send answered and what it wrote.
    expect({ ok: sent.result.ok, reason: (sent.result as { reason?: string }).reason, written: sent.written })
      .toEqual({ ok: false, reason: "target_needs_input", written: 0 });
    expect(sent.result).toMatchObject({ sent: false });
  });

  it.each([
    ["Codex", "an empty composer", "codex", codexComposer],
    ["Codex", "an empty composer under a numbered message in the history", "codex", "› 1. check the build\n• ok\n\n" + codexComposer],
    ["Codex", "a picker's rows in the history, under a later composer", "codex", codexModel + "\n• Model changed\n\n" + codexComposer],
    ["Claude", "an empty composer", "claude-code", claudeComposer],
    ["Claude", "a picker's rows in the history, under a later composer", "claude-code", claudeDefault + "\n⎿ Set model to Opus 5.5\n\n" + claudeComposer],
  ] as const)("%s after a fresh Stop hook still delivers to %s", async (_program, _name, runtime, pane) => {
    const sent = await send(runtime, pane, "Stop");
    expect(sent.result.ok).toBe(true);
    expect(sent.written).toBeGreaterThan(0);
  });

  it.each([
    ["Codex, a fresh SessionStart hook, an empty composer", "codex", codexComposer, "SessionStart"],
    ["Claude, a fresh SessionStart hook, an empty composer", "claude-code", claudeComposer, "SessionStart"],
  ] as const)("%s: still delivers", async (_name, runtime, pane, hook) => {
    const sent = await send(runtime, pane, hook);
    expect(sent.result.ok).toBe(true);
    expect(sent.written).toBeGreaterThan(0);
  });

  it("Codex mid-turn with no picker still delivers, with the busy advisory, as before", async () => {
    const sent = await send("codex", "• Working (4s • esc to interrupt)\n\n" + codexComposer, "UserPromptSubmit");
    expect(sent.result).toMatchObject({ ok: true });
    expect((sent.result as { warning?: string }).warning).toContain("mid-task");
    expect(sent.written).toBeGreaterThan(0);
  });
});
