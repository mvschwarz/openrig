import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectStartupStagedText, startupOwnCollapsedPaste } from "../src/domain/startup-submission-evidence.js";

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

// Claude 2.1.289's label counts the pasted text's newlines: the four startup prompts of one native run read +95,
// +70, +84 and +61 with exactly that many newlines, and a 29-newline file ending in one read +29.
describe("our own collapsed startup paste", () => {
  const prompt = Array.from({ length: 96 }, (_, i) => `line ${i}`).join("\n"); // 95 newlines, none trailing
  const file = `${Array.from({ length: 29 }, (_, i) => `line ${i}`).join("\n")}\n`; // 29 newlines, one trailing

  it.each([
    ["the live composer's no-break space", `\u276f\u00a0[Pasted text #1 +95 lines]\n${"\u2500".repeat(80)}\n  paste again to expand\n`],
    ["a plain space and the effort hint", composer("[Pasted text #1 +95 lines]", "paste again to expand  \u25d0 medium \u00b7 /effort")],
    ["the mode bar", composer("[Pasted text #3 +95 lines]", "\u23f5\u23f5 bypass permissions on (shift+tab to cycle)")],
  ])("recognizes the label for a paste with the prompt's newline count (%s)", (_name, pane) => {
    expect(startupOwnCollapsedPaste(pane, prompt)).toBe(true);
  });

  it("counts a trailing newline, as Claude does", () => {
    expect(startupOwnCollapsedPaste(composer("[Pasted text #2 +29 lines]"), file)).toBe(true);
    expect(startupOwnCollapsedPaste(composer("[Pasted text #2 +28 lines]"), file)).toBe(false);
  });

  // A transcript above the composer can hold another harness's glyph (a quoted Codex line); the seat's
  // runtime scopes the region so the last Claude prompt line is still read as ours. Without a runtime
  // the union glyph walk stays ambiguous and keeps the unknown-runtime refusal.
  it.each(["›", "»"])("reads a Claude seat's own paste with an earlier %s transcript line", glyph => {
    const pane = `${glyph} an earlier line from another harness\n${composer("[Pasted text #1 +95 lines]")}`;
    expect(startupOwnCollapsedPaste(pane, prompt, "claude-code")).toBe(true);
    expect(startupOwnCollapsedPaste(pane, prompt)).toBe(false);
  });

  it.each([
    "[Pasted text #1 +94 lines]", "[Pasted text #1 +96 lines]", "[Pasted text #1]", "[Pasted text +95 lines]",
    "a person's draft [Pasted text #1 +95 lines]", "[Pasted text #1 +95 lines] and more", "a person's draft", "",
  ])("does not treat %j as our pending paste", body => {
    expect(startupOwnCollapsedPaste(composer(body), prompt)).toBe(false);
  });

  it.each([null, "", "\u276f [Pasted text #1 +95 lines]\n"])("needs a recognized composer: %j", pane => {
    expect(startupOwnCollapsedPaste(pane, prompt)).toBe(false);
  });
});
