import { describe, expect, it } from "vitest";
import { probeSessionActivity } from "../src/domain/session-transport.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ObservationInput } from "../src/domain/capture-observer.js";

// Leaf-only regression: no test-app, startup, DB, terminal or provider effects.
describe("P2 probe capture uses its entry context", () => {
  for (const mutation of ["target", "adapter", "all"] as const) {
    it.each([true, false])(`${mutation} changes during hasSession (observer=%s)`, async (enabled) => {
      const calls: unknown[][] = [];
      const observations: ObservationInput[] = [];
      const successor: ObservationInput[] = [];
      let release!: (value: boolean) => void;
      const originalAdapter = {
        hasSession: (name: string) => {
          calls.push(["hasSession", name]);
          return new Promise<boolean>((resolve) => { release = resolve; });
        },
        capturePaneContent: async (name: string, lines: number) => {
          calls.push(["originalCapture", name, lines]);
          return `bytes from ${name}\n❯ `;
        },
      } as unknown as TmuxAdapter;
      const input: Parameters<typeof probeSessionActivity>[0] = {
        sessionName: "original@rig", runtime: "codex", attachmentType: "tmux", now: new Date(0),
        tmuxAdapter: originalAdapter,
        captureObserver: enabled ? { record: (r) => { observations.push(r); } } : undefined,
        binding: { nodeId: "n-original", occupant: "o-original", pane: "%7" },
      };
      const pending = probeSessionActivity(input);
      if (mutation !== "adapter") input.sessionName = "successor@rig";
      if (mutation !== "target") input.tmuxAdapter = {
        capturePaneContent: async (name: string, lines: number) => {
          calls.push(["successorCapture", name, lines]);
          return "successor adapter bytes\n❯ ";
        },
      } as unknown as TmuxAdapter;
      if (mutation === "all") {
        input.runtime = "terminal"; input.attachmentType = "external_cli"; input.now = new Date(9999);
        input.binding = { nodeId: "n-new", occupant: "o-new", pane: "%99" };
        input.captureObserver = { record: (r) => { successor.push(r); } };
      }
      release(true);
      const value = await pending;
      expect(calls).toEqual([["hasSession", "original@rig"], ["originalCapture", "original@rig", 20]]);
      expect(value).toMatchObject({ sampledAt: new Date(0).toISOString(), reason: "idle_prompt" });
      expect(successor).toHaveLength(0);
      expect(observations).toHaveLength(enabled ? 1 : 0);
      if (enabled) expect(observations[0]).toMatchObject({
        binding: { sessionName: "original@rig", nodeId: "n-original", occupant: "o-original", pane: "%7" },
        runtime: "codex", pre: { content: "bytes from original@rig\n❯ " },
      });
    });
  }
});
