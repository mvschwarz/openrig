import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { deriveRelayEvents } from "../src/domain/claude-activity-hooks.js";

describe("restore-check Claude activity-hook contract", () => {
  it("derives the required event set from the daemon-shipped Claude plugin manifest", () => {
    const manifestPath = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/claude.json");
    const events = deriveRelayEvents({
      exists: existsSync,
      readFile: (file) => readFileSync(file, "utf-8"),
    }, manifestPath).map(({ event }) => event);

    expect(events).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "Notification"]);
  });

  it("does not claim hook readiness when the canonical manifest is unavailable", () => {
    expect(deriveRelayEvents({ exists: () => false, readFile: () => "{}" }, "/missing/claude.json")).toEqual([]);
  });
});
