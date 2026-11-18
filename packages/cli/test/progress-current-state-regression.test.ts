import { describe, expect, it } from "vitest";
import { setCurrentState } from "../src/lib/scope/progress-edit.js";

it("preserves an indented following heading and its body", () => {
  const input = "## Current state\n\nOld\n\n  ## Outcomes\n\nKeep\n";
  expect(setCurrentState(input, "Ready").content).toBe("## Current state\n\nReady\n\n  ## Outcomes\n\nKeep\n");
});

describe("current-state heading", () => {
  it("preserves closing hashes, unrelated sections, and repeated updates", () => {
    const input = "# Progress\n\n## Current state ##\n\nOld\n\n## Other\n\nKeep\n";
    const first = setCurrentState(input, "Ready");
    expect(first.changed).toBe(true);
    expect(first.content).toContain("## Current state ##\n\nReady");
    expect(first.content).toContain("## Other\n\nKeep");
    const again = setCurrentState(first.content, "Ready");
    expect(again.changed).toBe(false);
    expect(again.content).toBe(first.content);
  });
});
