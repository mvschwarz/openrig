import { describe, expect, it } from "vitest";
import {
  OPENRIG_CURSOR_HOOK_EVENTS, cursorRelayCommand, upsertCursorActivityHooks, stripCursorActivityHooks,
} from "../src/adapters/cursor-activity-hooks.js";

const RELAY = "/opt/openrig/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
const OLD_RELAY = "/old/install/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";

describe("upsertCursorActivityHooks", () => {
  it("creates the file content from nothing", () => {
    const next = JSON.parse(upsertCursorActivityHooks("", RELAY));
    expect(next.version).toBe(1);
    for (const event of OPENRIG_CURSOR_HOOK_EVENTS) {
      expect(next.hooks[event]).toEqual([{ command: cursorRelayCommand(RELAY) }]);
    }
  });

  it("keeps the operator's own entries and settings", () => {
    const existing = JSON.stringify({ version: 1, hooks: { stop: [{ command: "~/bin/notify.sh" }], afterFileEdit: [{ command: "prettier" }] } });
    const next = JSON.parse(upsertCursorActivityHooks(existing, RELAY));
    expect(next.hooks.stop).toEqual([{ command: "~/bin/notify.sh" }, { command: cursorRelayCommand(RELAY) }]);
    expect(next.hooks.afterFileEdit).toEqual([{ command: "prettier" }]);
  });

  it("is idempotent and replaces a stale OpenRig relay path", () => {
    const once = upsertCursorActivityHooks(upsertCursorActivityHooks("", OLD_RELAY), RELAY);
    expect(upsertCursorActivityHooks(once, RELAY)).toBe(once);
    expect(once).not.toContain("/old/install/");
  });

  it("subscribes only to turn events, never to sessionStart or sessionEnd", () => {
    expect([...OPENRIG_CURSOR_HOOK_EVENTS]).toEqual(["beforeSubmitPrompt", "preToolUse", "stop"]);
  });

  it("removes OpenRig's entries left on sessionStart/sessionEnd by the earlier five-event version", () => {
    const relay = cursorRelayCommand(OLD_RELAY);
    const old = JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: relay }],
        sessionEnd: [{ command: "~/bin/log-end.sh" }, { command: relay }],
        beforeSubmitPrompt: [{ command: relay }],
        preToolUse: [{ command: relay }],
        stop: [{ command: "~/bin/notify.sh" }, { command: relay }],
      },
    });
    const next = JSON.parse(upsertCursorActivityHooks(old, RELAY));
    expect(next.hooks.sessionStart).toBeUndefined();
    expect(next.hooks.sessionEnd).toEqual([{ command: "~/bin/log-end.sh" }]);
    expect(next.hooks.stop).toEqual([{ command: "~/bin/notify.sh" }, { command: cursorRelayCommand(RELAY) }]);
    expect(next.hooks.beforeSubmitPrompt).toEqual([{ command: cursorRelayCommand(RELAY) }]);
    expect(JSON.stringify(next)).not.toContain("/old/install/");
  });

  it("keeps an operator's empty hook list on an event OpenRig does not use", () => {
    const next = JSON.parse(upsertCursorActivityHooks(JSON.stringify({ version: 1, hooks: { afterFileEdit: [] } }), RELAY));
    expect(next.hooks.afterFileEdit).toEqual([]);
  });

  it("refuses to rewrite a file that is not valid JSON", () => {
    expect(() => upsertCursorActivityHooks("{ not json", RELAY)).toThrow(/not valid JSON/);
  });
});

describe("hand-edited files", () => {
  it("strip keeps a non-array hook value as is and never throws", () => {
    const odd = '{"version":1,"hooks":{"stop":"x"}}';
    expect(stripCursorActivityHooks(odd)).toBe(odd);
    const mixed = '{"version":1,"hooks":{"stop":null,"afterFileEdit":[{"command":"prettier"}]}}';
    expect(() => stripCursorActivityHooks(mixed)).not.toThrow();
  });
  it("upsert refuses a non-array hook value cleanly", () => {
    expect(() => upsertCursorActivityHooks('{"hooks":{"stop":"x"}}', RELAY)).toThrow(/left it unchanged/);
  });
  it("an unknown top-level key survives upsert and strip", () => {
    const withKey = upsertCursorActivityHooks('{"x-operator":true,"hooks":{"afterFileEdit":[{"command":"p"}]}}', RELAY);
    expect(JSON.parse(withKey)["x-operator"]).toBe(true);
    expect(JSON.parse(stripCursorActivityHooks(withKey)!)["x-operator"]).toBe(true);
  });
});

describe("stripCursorActivityHooks", () => {
  it("removes only OpenRig's entries", () => {
    const withBoth = upsertCursorActivityHooks(JSON.stringify({ version: 1, hooks: { stop: [{ command: "~/bin/notify.sh" }] } }), RELAY);
    expect(JSON.parse(stripCursorActivityHooks(withBoth)!)).toEqual({ version: 1, hooks: { stop: [{ command: "~/bin/notify.sh" }] } });
  });
  it("signals deletion when nothing else remains", () => {
    expect(stripCursorActivityHooks(upsertCursorActivityHooks("", RELAY))).toBeNull();
  });
  it("leaves unrelated or unparseable files alone", () => {
    const mine = JSON.stringify({ version: 1, hooks: { stop: [{ command: "x" }] } });
    expect(stripCursorActivityHooks(mine)).toBe(mine);
    expect(stripCursorActivityHooks("{ not json")).toBe("{ not json");
  });
});
