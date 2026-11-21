// Claude Code 2.1.310's workspace trust dialog as a restore met it in a moved project folder, with a synthetic user and
// path. Claude draws the heading before its options, and its focus opens on "No, exit": an Enter there exits Claude.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";

const dialog = readFileSync(new URL("./fixtures/claude-trust-2.1.310.txt", import.meta.url), "utf8");
// The launch line, the rule, the heading and the folder: the frame before the options are drawn.
const heading = dialog.split("\n").slice(0, 6).join("\n");
const yesFocused = dialog.replace(" ❯ No, exit\n   Yes, I trust this folder", "   No, exit\n ❯ Yes, I trust this folder");
const rule = "─".repeat(60);
const composer = `Claude Code v2.1.310\n${rule}\n❯ \n${rule}\n  ⏵⏵ accept edits on (shift+tab to cycle)`;
const frames = [
  { id: "heading-before-options", pane: heading, current: true },
  { id: "dialog-on-no-exit", pane: dialog, current: true },
  { id: "dialog-on-yes", pane: yesFocused, current: true },
  { id: "dialog-answered-composer-below", pane: `${dialog}\n${composer}`, current: false },
  { id: "reply-quoting-the-heading", pane: `● The restore stopped at:\n  Accessing workspace:\n  /home/user\n\n${composer}`, current: false },
  // A resume redraws history before its composer: a reply quoting the heading, with no composer drawn under it yet.
  { id: "reply-quoting-the-heading-before-a-composer", pane: "● The restore stopped at:\n  Accessing workspace:\n  /home/user", current: false },
  { id: "dialog-drawn-after-an-earlier-reply", pane: `● Done.\n\n${heading}`, current: true },
];

describe("Claude's workspace trust dialog, from its heading on", () => {
  it.each(frames)("$id: the resume probe", ({ pane, current }) => {
    const probe = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude", paneContent: pane });
    expect(probe).toMatchObject(current ? { status: "inconclusive", code: "trust_gate" } : { status: "resumed" });
  });
});
