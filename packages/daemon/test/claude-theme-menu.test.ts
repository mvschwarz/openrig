// Claude 2.1.312 Theme frame with preceding transcript removed and a synthetic seat label.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyPaneActivity } from "../src/domain/session-transport.js";
const theme = readFileSync(new URL("./fixtures/claude-theme-2.1.312.txt", import.meta.url), "utf8");
const rule = "─".repeat(60);
const composer = `${rule}\n❯ \n${rule}\n  ⏵⏵ accept edits on (shift+tab to cycle)`;
describe("current Claude Theme picker classification", () => {
  it.each([undefined, "claude-code"] as const)("recognizes the real unnumbered menu with runtime %s", runtime => {
    expect(classifyPaneActivity(theme, { runtime })).toMatchObject({ state: "attention", reason: "selection_prompt" });
    expect(classifyPaneActivity(theme, { runtime, currentClaudeDialogueOnly: true }).reason).toBe("selection_prompt");
  });

  it.each([
    ["later empty composer", theme + "\n" + composer],
    ["later draft", theme + "\n" + composer.replace("❯ ", "❯ preserve my draft")],
    ["quoted", theme.split("\n").map(line => "> " + line).join("\n")],
    ["fenced output", "```text\n" + theme + "\n```"],
    ["missing instruction", theme.replace("Choose the text style that looks best with your terminal", "")],
    ["unknown footer", theme.replace("Enter to select · Esc to cancel", "Enter to approve")],
    ["unknown choices", theme.replace("Dark mode (colorblind-friendly)", "Allow all tools")],
    ["partial menu", theme.slice(theme.indexOf("❯"))],
    ["footer only", "Theme\nEnter to select · Esc to cancel"],
  ])("does not turn %s into a current theme selector", (_name, pane) => {
    expect(classifyPaneActivity(pane, { runtime: "claude-code" }).reason).not.toBe("selection_prompt");
  });

  it.each(["codex", "pi"])("does not treat a %s pane as a Claude Theme dialog", runtime => {
    expect(classifyPaneActivity(theme, { runtime }).reason).not.toBe("selection_prompt");
  });
});
