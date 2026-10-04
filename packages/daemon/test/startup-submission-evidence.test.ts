import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectStartupStagedText } from "../src/domain/startup-submission-evidence.js";

// Composer-only crops from Claude Code 2.1.289; no transcript or seat identity.
const frames = JSON.parse(readFileSync(new URL("./fixtures/claude-startup-paste-2.1.289.json", import.meta.url), "utf8")) as Array<{
  name: string; pane: string; expected: "clear" | "unverified";
}>;
const expected = "the expected startup prompt";
const composer = (body: string, footer = "paste again to expand") => `❯ ${body}\n────────────────────\n  ${footer}\n`;

describe("Claude transient startup composer", () => {
  it.each(frames)("recognizes the $name capture as $expected", frame => {
    expect(inspectStartupStagedText(frame.pane, expected)).toBe(frame.expected);
  });

  it("recognizes a queued placeholder under the plain paste hint", () => {
    expect(inspectStartupStagedText(composer("Press up to edit queued messages"), expected)).toBe("clear");
  });

  it.each(["? for shortcuts", "paste again to expand", "paste again to expand  ◐ medium · /effort"])("keeps an exact expected placeholder staged under %s", footer => {
    const placeholder = "Press up to edit queued messages";
    expect(inspectStartupStagedText(composer(placeholder, footer), placeholder)).toBe("staged");
    expect(inspectStartupStagedText(composer("Press up\nto edit queued messages", footer), ` ${placeholder} `)).toBe("staged");
  });

  it.each(["[Pasted text #2 +29 lines]", "an unrelated draft", "Try fixing the tests", "Press up to edit queued messages\nadditional draft"])("keeps opaque or unrelated input unverified: %s", body => {
    expect(inspectStartupStagedText(composer(body), expected)).toBe("unverified");
  });

  it.each([
    "paste again to expand later", "prefix paste again to expand", "paste again to expand · /effort", "Working…",
    "paste again to expand  ordinary text · /effort", "paste again to expand  ❯ unfinished draft · /effort",
    "paste again to expand  medium · /effort", "paste again to expand  ◐ unknown · /effort",
    "paste again to expand  ◐ medium extra · /effort", "paste again to expand  ◐ medium · /effort trailing",
  ])("does not accept an approximate hint: %s", footer => {
    expect(inspectStartupStagedText(composer("", footer), expected)).toBe("unverified");
  });

  it.each(["", " \n "])("keeps an empty composer clear with empty expected text: %j", text => {
    expect(inspectStartupStagedText(composer(""), text)).toBe("clear");
  });

  it.each([null, "", "❯\n────────────────────\n"])("keeps an unavailable or incomplete capture unverified: %j", pane => {
    expect(inspectStartupStagedText(pane, expected)).toBe("unverified");
  });

  it("still identifies the complete expected prompt as staged", () => {
    expect(inspectStartupStagedText(composer(expected), expected)).toBe("staged");
  });
});
