import { describe, it, expect, vi } from "vitest";
import { SessionTransport } from "../src/domain/session-transport.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// A person can open a Claude dialog (a permission selector, a picker) in the seconds after the seat's Stop hook, and
// opening it fires no new hook. An ordinary send then mustn't type into it.
const border = "────────────────────────────────────────────";
const framed = (prompt: string) => ["● Done.", border, prompt, border, "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"].join("\n");
const permission = "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEnter to select · ↑/↓ to navigate · Esc to cancel";

async function sendAfterHook(event: "Stop" | "UserPromptSubmit", pane: string) {
  const db = createFullTestDb();
  try {
    const repo = new RigRepository(db), registry = new SessionRegistry(db), rig = repo.createRig("idle-dialog");
    const node = repo.addNode(rig.id, "worker.a", { runtime: "claude-code", role: "worker" });
    const name = "worker-a@idle-dialog";
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name });
    const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
    const now = new Date("2026-11-11T03:40:00Z");
    const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => now,
      resolveOccupantGeneration: (id) => registry.currentOccupantTenure(id)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (id, g) => Boolean(db.prepare(
        "SELECT 1 FROM occupant_tenures WHERE node_id=? AND generation_uuid=?").get(id, g)),
    });
    expect(store.recordHookEvent({ runtime: "claude-code", sessionName: name, hookEvent: event, generation,
      occurredAt: new Date(now.getTime() - 1_000).toISOString() }).ok).toBe(true);
    const paste = vi.fn(async () => ({ ok: true as const })), keys = vi.fn(async () => ({ ok: true as const }));
    const capture = vi.fn(async () => pane);
    const adapter = { hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
      getPaneCommand: async () => "claude", getPanePid: async () => null, listPanes: async () => [],
      hasSessionEnv: async () => false, capturePaneContent: capture, sendText: paste, sendKeys: keys,
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo: repo, sessionRegistry: registry, tmuxAdapter: adapter,
      agentActivityStore: store, now: () => now, sleep: async () => undefined, activityEndpointFile: () => null });
    const result = await transport.send(name, "Ordinary synthetic peer message");
    return { result, paste: paste.mock.calls.length, keys: keys.mock.calls.length, captures: capture.mock.calls.length };
  } finally { db.close(); }
}

describe("a fresh idle hook doesn't let a send type into a current Claude dialog", () => {
  it("a permission selector opened after Stop refuses the send, with nothing typed or pressed", async () => {
    const sent = await sendAfterHook("Stop", permission);
    expect(sent.result).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(sent.paste).toBe(0);
    expect(sent.keys).toBe(0);
    expect(sent.captures).toBe(1);
  });

  it("an empty composer after Stop still sends", async () => {
    const sent = await sendAfterHook("Stop", framed("❯ "));
    expect(sent.result.ok).toBe(true);
    expect(sent.paste).toBe(1);
  });

  it("a draft after Stop isn't a dialog: it still sends, as before (drafts are the delivery guard's)", async () => {
    const sent = await sendAfterHook("Stop", framed("❯ unfinished message"));
    expect(sent.result.ok).toBe(true);
    expect(sent.paste).toBe(1);
  });

  it("a fresh running hook keeps its own check: the selector refuses there too", async () => {
    const sent = await sendAfterHook("UserPromptSubmit", permission);
    expect(sent.result).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(sent.paste).toBe(0);
  });
});
