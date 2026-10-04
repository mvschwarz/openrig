import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { SessionTransport, classifyPaneActivity } from "../src/domain/session-transport.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// Native Claude 2.1.289 at 160x40 and 100x40; only setup/history before the
// question or dismissed result is omitted. All combinations below are constructed.
const native = JSON.parse(readFileSync(new URL("./fixtures/claude-question-picker-2.1.289.json", import.meta.url), "utf8")) as Record<string, string>;
const footer = "Enter to select · ↑/↓ to navigate · Esc to cancel";
const border = "────────────────────────────────────────────";
const framed = (prompt: string) => ["● The earlier question is answered.", border, prompt, border,
  "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"].join("\n");
const picker12 = ["Which region?", "❯ 1. us-east", "     First region description", "  2. us-west",
  "     Second region description", "  3. eu-west", "     Third region description", "  4. ap-south",
  "     Fourth region description", "     Description continuation A", "     Description continuation B",
  "     Description continuation C", footer].join("\n");
const picker13 = picker12.replace(footer, "     One extra description continuation\n" + footer);
const shapes: Record<string, { content: string; state: string }> = {
  picker160: { content: native.picker160!, state: "attention" },
  picker100: { content: native.picker100!, state: "attention" },
  dismissed100: { content: native.dismissed100!, state: "agent_idle" },
  picker12: { content: picker12, state: "attention" },
  picker13: { content: picker13, state: "attention" },
  history_idle: { content: picker13 + "\n" + framed("❯ "), state: "agent_idle" },
  // Existing ordinary-send behavior for this draft is not changed by picker recognition.
  history_draft: { content: picker13 + "\n" + framed("❯ unfinished message"), state: "agent_idle" },
  historical_short_picker: { content: ["Which region?", "❯ 1. us-east", "  2. us-west", footer, framed("❯ ")].join("\n"), state: "agent_idle" },
  footer_only: { content: footer, state: "unknown" },
  later_output: { content: picker13 + "\nLater unrelated output", state: "unknown" },
  // Preserve the existing short-window behavior; this change does not broaden draft parsing.
  footer_in_multiline_draft: { content: framed("❯ draft containing old question\n  Which region?\n  ❯ 1. us-east\n  " + footer), state: "attention" },
};
const hooks = [
  { name: "absent", event: null, age: 0 },
  { name: "fresh_permission", event: "PermissionRequest", age: 1_000 },
  { name: "fresh_running", event: "UserPromptSubmit", age: 1_000 },
  { name: "fresh_idle", event: "Stop", age: 1_000 },
  { name: "fresh_unknown", event: "SessionStart", age: 1_000 },
  { name: "send_stale_permission", event: "PermissionRequest", age: 90_000 },
  { name: "send_stale_idle", event: "Stop", age: 90_000 },
  { name: "display_stale_permission", event: "PermissionRequest", age: 330_000 },
] as const;

describe("current Claude question picker", () => {
  it.each(Object.entries(shapes))("classifies %s", (_name, { content, state }) => {
    expect(classifyPaneActivity(content).state).toBe(state);
  });

  it("keeps the selector guard across the former twelve-line boundary", () => {
    for (const [content, distance] of [[picker12, 12], [picker13, 13]] as const) {
      const lines = content.split("\n").filter(line => line.trim());
      expect(lines.length - lines.findIndex(line => line.startsWith("❯ 1."))).toBe(distance);
      expect(classifyPaneActivity(content)).toMatchObject({ state: "attention", reason: "selection_prompt" });
    }
  });

  it.each([100, 160])("handles selection changes and rejects quoted or interrupted blocks at %i columns", width => {
    const content = native[`picker${width}`]!;
    for (const option of [2, 5, 6]) {
      const selected = content.replace("❯ 1.", "  1.").replace(`  ${option}.`, `❯ ${option}.`);
      expect(classifyPaneActivity(selected).reason).toBe("selection_prompt");
    }
    expect(classifyPaneActivity(content + "\n\n").reason).toBe("selection_prompt");
    expect(classifyPaneActivity(content + "\n" + framed("❯ ")).state).toBe("agent_idle");
    expect(classifyPaneActivity("❯ draft\n" + content.split("\n").map(line => "  " + line).join("\n")).state).toBe("unknown");
  });

  it("does not join a footer to an unrelated distant selector", () => {
    expect(classifyPaneActivity(picker13.replace("     First region description", "unrelated output")).state).toBe("unknown");
    expect(classifyPaneActivity(picker13.replace("❯ 1.", "  1.")).state).toBe("unknown");
    expect(classifyPaneActivity("❯ 1. Yes\n  2. No\n" + framed("❯ ")).reason).toBe("selection_prompt");
  });

  it("shares native picker recognition with the structural consumer", async () => {
    const service = new SeatStructuralActivityService({ capturePaneContent: async () => native.picker100! });
    expect(await service.pollSeat("seat@rig")).toMatchObject({ state: "attention", reason: "selection_prompt" });
  });
});

describe("ordinary transport under current and historical questions", () => {
  for (const [shape, { content, state }] of Object.entries(shapes)) {
    for (const hook of hooks) it(`${shape} / ${hook.name}`, async () => {
      const db = createFullTestDb();
      try {
        const repo = new RigRepository(db), registry = new SessionRegistry(db), rig = repo.createRig("picker-test");
        const node = repo.addNode(rig.id, "worker.a", { runtime: "claude-code", role: "worker" });
        const name = "worker-a@picker-test";
        const session = registry.registerSession(node.id, name);
        registry.updateStatus(session.id, "running");
        registry.updateBinding(node.id, { tmuxSession: name });
        const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
        const now = new Date("2026-10-04T22:40:00Z");
        const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now: () => now,
          resolveOccupantGeneration: id => registry.currentOccupantTenure(id)?.generationUuid ?? null,
          isRegisteredOccupantGeneration: (id, g) => Boolean(db.prepare(
            "SELECT 1 FROM occupant_tenures WHERE node_id=? AND generation_uuid=?"
          ).get(id, g)),
        });
        if (hook.event) expect(store.recordHookEvent({ runtime: "claude-code", sessionName: name,
          hookEvent: hook.event, generation, occurredAt: new Date(now.getTime() - hook.age).toISOString(),
        }).ok).toBe(true);
        const paste = vi.fn(async () => ({ ok: true as const })), enter = vi.fn(async () => ({ ok: true as const }));
        const capture = vi.fn(async () => content);
        const adapter = { hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
          getPaneCommand: async () => "claude", getPanePid: async () => null, listPanes: async () => [],
          hasSessionEnv: async () => false, capturePaneContent: capture, sendText: paste, sendKeys: enter,
        } as unknown as TmuxAdapter;
        const transport = new SessionTransport({ db, rigRepo: repo, sessionRegistry: registry, tmuxAdapter: adapter,
          agentActivityStore: store, now: () => now, sleep: async () => undefined, activityEndpointFile: () => null });
        const result = await transport.send(name, "Ordinary synthetic peer message");

        const sent = hook.name === "fresh_permission" ? false
          : hook.name.startsWith("fresh_") ? true : state !== "attention";
        expect(result.ok).toBe(sent);
        expect(paste).toHaveBeenCalledTimes(sent ? 1 : 0);
        expect(enter).toHaveBeenCalledTimes(sent ? 1 : 0);
        if (!sent) expect(result.reason).toBe("target_needs_input");
        expect(capture).toHaveBeenCalledTimes(hook.name.startsWith("fresh_") ? 0 : 1);
      } finally { db.close(); }
    });
  }
});
