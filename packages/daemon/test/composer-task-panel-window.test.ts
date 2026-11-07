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
