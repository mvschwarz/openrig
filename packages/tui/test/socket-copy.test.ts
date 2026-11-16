// The bound socket's status row is copyable, and its click has to win over the startup, palette and
// restore handlers, which otherwise consume a click on the status row. That makes this comparison
// load-bearing: a value that does not equal the bound path sends the operator to another screen
// instead of copying.

import { describe, expect, it } from "vitest";
import { isBoundSocketCopy } from "../src/socket-copy.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";

const snap = demoSnapshot();
const ESC = "\u001b";

function socketCopyAction(controlSocketPath: string) {
  const screen = renderScreen(
    createViewState({ instanceId: "t", getSnapshot: () => snap }).get(),
    snap,
    { cols: 120, rows: 32, controlSocketPath },
  );
  return screen.hitMap.find((h) => h.action?.type === "print-for-copy")?.action as
    { type: string; value?: string } | undefined;
}

describe("isBoundSocketCopy", () => {
  it("recognises the row the renderer built for the bound path", () => {
    const action = socketCopyAction("/tmp/tui.sock");
    expect(isBoundSocketCopy(action, "/tmp/tui.sock")).toBe(true);
  });

  it("still recognises it when the path carries bytes the row cleans for display", () => {
    // The row shows the path cleaned; the action carries it as bound. If the renderer cleaned the
    // action's value too, this would be false and the click would fall through to another screen.
    const hostile = `/tmp/o${ESC}]0;pwned\u0007x.sock`;
    const action = socketCopyAction(hostile);
    expect(action?.value).toBe(hostile);
    expect(isBoundSocketCopy(action, hostile)).toBe(true);
  });

  it("does not claim a copy that belongs to another path or another action", () => {
    expect(isBoundSocketCopy(socketCopyAction("/tmp/a.sock"), "/tmp/b.sock")).toBe(false);
    expect(isBoundSocketCopy({ type: "startup", value: "/tmp/a.sock" }, "/tmp/a.sock")).toBe(false);
    expect(isBoundSocketCopy(undefined, "/tmp/a.sock")).toBe(false);
  });
});