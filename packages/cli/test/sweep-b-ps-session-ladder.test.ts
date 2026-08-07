// SWEEP-b (shape f2576102) — `--session` on the rig tier is accept-and-drop today:
// accepted at the option, never read by the rig-tier render → silent all-rigs listing.
import { describe, it, expect } from "vitest";
import { validatePsLadder } from "../src/commands/ps.js";

describe("SWEEP-b — ps --session ladder clause", () => {
  it("--session without --nodes rejects with a teaching error naming the valid form", () => {
    const err = validatePsLadder({ session: "dev@rig" } as never, "rig");
    expect(err).not.toBeNull();
    expect(err).toMatch(/--session/);
    expect(err).toMatch(/--nodes/); // the valid form is taught
  });
  it("--nodes --session (the consumed form) stays green", () => {
    expect(validatePsLadder({ session: "dev@rig", nodes: true } as never, "rig")).toBeNull();
  });
});
