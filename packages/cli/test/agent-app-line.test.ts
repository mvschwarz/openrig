import { describe, expect, it } from "vitest";
import { formatAgentAppLine } from "../src/commands/ps.js";

const app = { app: "synth", maintainer: "Example Maintainer", limits: ["one turn per line"], identity: "not confirmed", needsInput: "from the screen only: no app prompt pattern" };

describe("rig ps line for a community agent app seat", () => {
  it("says whether the preset declares resume", () => {
    expect(formatAgentAppLine("w@r", { ...app, resume: "declared" })).toBe(
      "Community app (w@r): synth, maintained by Example Maintainer, not tested by OpenRig. Identity not confirmed; needs-input from the screen only: no app prompt pattern; resume declared; declared limits: one turn per line.");
  });
  it("keeps the old line when the daemon doesn't send resume", () => {
    expect(formatAgentAppLine("w@r", app)).toBe(
      "Community app (w@r): synth, maintained by Example Maintainer, not tested by OpenRig. Identity not confirmed; needs-input from the screen only: no app prompt pattern; declared limits: one turn per line.");
  });
});
