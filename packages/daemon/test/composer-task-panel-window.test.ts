import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ComposerSnapshot } from "../src/domain/composer-prompts.js";
import { classifyPaneActivity, inspectComposerInput } from "../src/domain/session-transport.js";

// #2700, beyond the two captured shapes in composer-statusline-panel.test.ts: a taller task panel, and a gap row in
// another harness's prompt shape. Screens are edited from the captured fixtures, each with a comment.
const load = (name: string): ComposerSnapshot =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const F1 = load("claude-statusline-composer.json");
const F2 = load("claude-task-panel-composer.json");
const plain = (screen: string) => screen.replace(/\x1b\[[0-9;:]*m/g, "");

function edit(base: ComposerSnapshot, change: (rows: string[]) => void, cursor: Partial<ComposerSnapshot["cursor"]> = {}): ComposerSnapshot {
  const rows = base.screen.split("\n");
  change(rows);
  return { screen: rows.join("\n"), cursor: { ...base.cursor, ...cursor }, inMode: base.inMode };
}

describe("Claude composer with a tall task panel (#2700)", () => {
  // Edited: twelve more "◯" task rows after the two captured ones, so the panel alone fills the classifier's
  // 20-row window and the status head ("✻ Waiting for …", row 0) sits above it. The pane height grows to hold them.
  const tall = edit(F2, rows => {
    rows.splice(9, 0, ...Array.from({ length: 12 }, (_, i) => `  ◯ background-task-${String(i).padStart(2, "0")}  ▱▱▱▱  1m0${i % 10}s`));
  }, { height: 40 });

  it("reads the seat as idle: the panel does not push the status head out of the window", () => {
    expect(plain(tall.screen).split("\n").filter(row => /^ {2}◯ /.test(row))).toHaveLength(14);
    expect(classifyPaneActivity(plain(tall.screen), { composerSnapshot: tall, runtime: "claude-code" }))
      .toMatchObject({ state: "agent_idle" });
  });

  it.each([null, "claude-code"] as const)("reads its composer as empty (runtime %s)", runtime => {
    expect(inspectComposerInput(tall, runtime)).toMatchObject({ state: "empty", rows: [""] });
  });
});

describe("Claude composer gap rows in another harness's prompt shape (#2700)", () => {
  it.each([null, "claude-code"] as const)("keeps a \"»\" row between the closing rule and the footer unrecognized (runtime %s)", runtime => {
    // Edited: the statusLine row replaced by a row in the Codex composer's "»" prompt shape.
    const shaped = edit(F1, rows => { rows[5] = "» draft in another harness"; });
    expect(inspectComposerInput(shaped, runtime)).toMatchObject({ state: "unknown", unknownReason: "unrecognized_composer" });
  });

  it("does not read the same screen as an idle framed composer", () => {
    // Edited: as above; on main this screen had no framed composer, and it still must not become one.
    const shaped = edit(F1, rows => { rows[5] = "» draft in another harness"; });
    expect(classifyPaneActivity(plain(shaped.screen), { composerSnapshot: shaped, runtime: "claude-code" }).state).not.toBe("agent_idle");
  });
});

describe("Claude composer under a tall statusLine (#2700)", () => {
  // Edited: the captured statusLine row followed by more statusLine rows, so the gap between the closing rule and the
  // footer is `rows` tall. The pane height grows to hold them.
  const tallStatusLine = (rows: number, head?: string) => edit(F1, screen => {
    screen.splice(6, 0, ...Array.from({ length: rows - 1 }, (_, i) => `  \x1b[36mstatus row ${i}\x1b[39m · ${i} items`));
    if (head) screen[0] = head;
  }, { height: 60 });

  it.each([1, 15, 16, 30])("reads a finished turn as idle with %i statusLine rows", rows => {
    const snapshot = tallStatusLine(rows);
    expect(classifyPaneActivity(plain(snapshot.screen), { composerSnapshot: snapshot, runtime: "claude-code" }))
      .toMatchObject({ state: "agent_idle" });
  });

  it.each([1, 17, 30])("reads a running turn as active with %i statusLine rows", rows => {
    // Edited: the completed status row above the box replaced by a live one.
    const snapshot = tallStatusLine(rows, "\x1b[38;5;246m✻\x1b[39m Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)");
    expect(classifyPaneActivity(plain(snapshot.screen), { composerSnapshot: snapshot, runtime: "claude-code" }))
      .toMatchObject({ state: "agent_active" });
  });
});

describe("Claude composer with a known status row between its footer and the task panel (#2700)", () => {
  it("keeps the warning row as a trailing row: an unframed empty prompt stays not idle, as without the panel", () => {
    // Edited from F2: the box's rules removed (an unframed prompt, now on row 2), and Claude's own-row update banner
    // (#2605) between the footer and the blank row above the panel. Without the panel this reads not idle (a trailing
    // row under an unframed prompt); the panel must not change that.
    const unframed = edit(F2, rows => {
      rows.splice(6, 0, "✔ Update installed · Restart to update");
      rows.splice(4, 1);
      rows.splice(2, 1);
    }, { y: 2 });
    const withoutPanel = edit(unframed, rows => { rows.splice(5); });
    const read = (s: ComposerSnapshot) => classifyPaneActivity(plain(s.screen), { composerSnapshot: s, runtime: "claude-code" }).state;
    expect(read(unframed)).toBe(read(withoutPanel));
  });
});
