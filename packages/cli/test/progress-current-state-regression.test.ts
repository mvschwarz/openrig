import { describe, expect, it } from "vitest";
import { setCurrentState } from "../src/lib/scope/progress-edit.js";

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
