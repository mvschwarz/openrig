import { createRequire } from "node:module";
import { evidenceFromHookActivity } from "../src/routes/activity.js";
import { describe, expect, it } from "vitest";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { CODEX_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";

describe("Codex pending permission requests", () => {
  function setup() {
    let ms = 0;
    let visible = false;
    let seq = 0;
    const changes: boolean[] = [];
    const service = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => 0 }, defaultWindowSeconds: 3,
      now: () => new Date(ms), permissionPromptReader: async () => visible,
      permissionPromptChanged: (_, confirmed) => changes.push(confirmed),
    });
    service.declareRungInventory({ seatNodeId: "seat", sessionName: "session" }, CODEX_ACTIVITY_RUNG_INVENTORY);
    const request = (id: string, resolved = false) => service.reportEvidence({
      seatNodeId: "seat", sessionName: "session", rung: "lifecycle-hooks", sourceId: "codex:hooks",
      seq: ++seq, observedAt: new Date(ms).toISOString(), permissionRequest: { id, resolved },
    });
    return { service, request, changes, advance: (value: number) => { ms = value; }, visible: (value: boolean) => { visible = value; }, count: () => service.getSeatState("seat")!.needsInput.count };
  }
  it.each(["approve", "deny"])("automatic %s never produces attention", async () => {
    const s = setup(); s.request("one"); expect(s.count()).toBe(0);
    s.request("one", true); s.advance(4000); await s.service.pollSeat("session");
    expect(s.count()).toBe(0); expect(s.changes).toEqual([]);
  });
  it("confirms a human prompt after grace and clears resolution mid-turn", async () => {
    const s = setup(); s.request("one"); s.visible(true); s.advance(2999);
    await s.service.pollSeat("session"); expect(s.count()).toBe(0);
    s.advance(3000); await s.service.pollSeat("session"); expect(s.count()).toBe(1);
    s.visible(false); await s.service.pollSeat("session"); expect(s.count()).toBe(0);
    expect(s.changes).toEqual([true, false]);
  });
  it("keeps observing a delayed prompt and a turn end clears it", async () => {
    const s = setup(); s.request("one"); s.advance(3000);
    await s.service.pollSeat("session"); expect(s.count()).toBe(0);
    s.visible(true); s.advance(4000); await s.service.pollSeat("session"); expect(s.count()).toBe(1);
    s.service.reportEvidence({ seatNodeId: "seat", sessionName: "session", rung: "lifecycle-hooks",
      sourceId: "codex:hooks", seq: 99, observedAt: new Date(4000).toISOString(), activity: "idle-at-prompt" });
    expect(s.count()).toBe(0);
  });
  it("resolving one request preserves another outstanding prompt", async () => {
    const s = setup(); s.request("one"); s.request("two"); s.visible(true); s.advance(3000);
    await s.service.pollSeat("session"); expect(s.count()).toBe(2);
    s.request("one", true); expect(s.count()).toBe(1);
    s.request("two", true); expect(s.count()).toBe(0);
  });
});

it("preserves correlation through relay and pending evidence without attention", () => {
  const require = createRequire(import.meta.url);
  const { buildOpenRigPayload } = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
  const payload = buildOpenRigPayload({ hook_event_name: "PermissionRequest", approvals_reviewer: "auto_review",
    turn_id: "turn", tool_use_id: "tool", decision: "deny" }, { OPENRIG_SESSION_NAME: "session", OPENRIG_RUNTIME: "codex" });
  expect(payload).toMatchObject({ reviewer: "auto_review", turnId: "turn", toolUseId: "tool", decision: "deny" });
  const evidence = evidenceFromHookActivity({ seatNodeId: "seat", sessionName: "session", runtime: "codex", seq: 1,
    activity: { ...payload, state: "unknown", reason: "permission_request_pending", evidenceSource: "runtime_hook",
      sampledAt: payload.occurredAt, evidence: null } });
  expect(evidence?.permissionRequest).toEqual({ id: "tool", resolved: true });
  expect(evidence?.needsInput).toBeUndefined();
});
