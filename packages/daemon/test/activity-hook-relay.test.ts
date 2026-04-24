import { createRequire } from "node:module";
import nodePath from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const relay = require(nodePath.resolve(import.meta.dirname, "../assets/openrig-activity-hook-relay.cjs")) as {
  buildOpenRigPayload: (
    providerPayload: Record<string, unknown>,
    env?: Record<string, string | undefined>,
    now?: () => Date,
  ) => Record<string, unknown> | null;
  parseJson: (value: string) => Record<string, unknown>;
};

describe("OpenRig activity hook relay", () => {
  it("maps provider hook stdin fields to the authenticated OpenRig hook payload", () => {
    const payload = relay.buildOpenRigPayload(
      {
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
        session_id: "provider-session",
      },
      {
        OPENRIG_SESSION_NAME: "dev-qa@test-rig",
        OPENRIG_NODE_ID: "node-123",
        OPENRIG_RUNTIME: "claude-code",
      },
      () => new Date("2026-04-24T21:45:00.000Z")
    );

    expect(payload).toEqual({
      sessionName: "dev-qa@test-rig",
      nodeId: "node-123",
      runtime: "claude-code",
      hookEvent: "Notification",
      subtype: "idle_prompt",
      occurredAt: "2026-04-24T21:45:00.000Z",
    });
  });

  it("returns null when required OpenRig hook env is absent", () => {
    expect(relay.buildOpenRigPayload({ hook_event_name: "Stop" }, {})).toBeNull();
  });

  it("parses malformed provider stdin as an empty object", () => {
    expect(relay.parseJson("not json")).toEqual({});
  });
});
