// The relay runs for every cursor-agent run on the machine, because OpenRig's Cursor hooks are
// user-scope. A nested `cursor-agent -p` inside a Claude or Codex seat inherits that seat's
// OPENRIG_* env, so a Cursor payload must only be relayed from a Cursor seat.
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { relayPayloads, buildOpenRigPayload, buildSessionIdentityPayload } = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");

const NOW = () => new Date("2026-10-01T10:00:00.000Z");
const seatEnv = (runtime: string) => ({ OPENRIG_SESSION_NAME: "dev@rig", OPENRIG_NODE_ID: "node-1", OPENRIG_RUNTIME: runtime });
const cursorPayload = (event: string) => ({
  hook_event_name: event, cursor_version: "2026.09.28-64d2043", conversation_id: "167733b3-080d-4eb0-a30a-7d22c40b5195", session_id: "167733b3-080d-4eb0-a30a-7d22c40b5195",
});

describe("activity relay — Cursor payload provenance", () => {
  it("posts nothing for a Cursor payload under a claude-code seat's env", () => {
    for (const event of ["sessionStart", "beforeSubmitPrompt", "stop"]) {
      expect(relayPayloads(cursorPayload(event), seatEnv("claude-code"), NOW)).toEqual([]);
      expect(buildOpenRigPayload(cursorPayload(event), seatEnv("claude-code"), NOW)).toBeNull();
      expect(buildSessionIdentityPayload(cursorPayload(event), seatEnv("claude-code"), NOW)).toBeNull();
    }
  });

  it("posts nothing for a Cursor payload under a codex seat or the legacy RIGGED_RUNTIME", () => {
    expect(relayPayloads(cursorPayload("stop"), seatEnv("codex"), NOW)).toEqual([]);
    expect(relayPayloads(cursorPayload("stop"), { RIGGED_SESSION_NAME: "dev@rig", RIGGED_RUNTIME: "claude-code" }, NOW)).toEqual([]);
  });

  it("posts a Cursor payload from a Cursor seat as before", () => {
    expect(relayPayloads(cursorPayload("beforeSubmitPrompt"), seatEnv("cursor"), NOW)).toEqual([
      { sessionName: "dev@rig", nodeId: "node-1", runtime: "cursor", generation: null, hookEvent: "beforeSubmitPrompt", subtype: null, occurredAt: "2026-10-01T10:00:00.000Z" },
    ]);
  });

  it("leaves a Claude payload under claude-code unchanged, including its session identity", () => {
    const claude = { hook_event_name: "SessionStart", session_id: "abc-123", source: "startup" };
    expect(relayPayloads(claude, seatEnv("claude-code"), NOW)).toEqual([
      { sessionName: "dev@rig", nodeId: "node-1", runtime: "claude-code", generation: null, hookEvent: "SessionStart", subtype: "startup", occurredAt: "2026-10-01T10:00:00.000Z" },
      { eventFamily: "session_identity", sessionName: "dev@rig", nodeId: "node-1", runtime: "claude-code", hookEvent: "SessionStart", sessionId: "abc-123", occurredAt: "2026-10-01T10:00:00.000Z" },
    ]);
  });
});
