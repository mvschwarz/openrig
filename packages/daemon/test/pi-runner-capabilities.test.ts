import { describe, expect, it } from "vitest";
import { piLaunchCapabilityError } from "../src/adapters/pi-runner.js";

describe("Pi pane capability check", () => {
  it.each(["approve", "no-approve"] as const)("names the invocation and rejected managed flag (%s)", trust => {
    const error = piLaunchCapabilityError("/pane/old/pi", trust,
      `\x1b[31mError: Unknown options: --name, --${trust}\x1b[0m`, () => "0.73.1\n");
    expect(error).toContain("/pane/old/pi (version 0.73.1; exact executable path unknown)");
    expect(error).toContain("@earendil-works/pi-coding-agent");
    expect(error).toContain("command -v pi");
  });

  it.each(["custom Pi startup", "config failed", "Unknown option: --help", "Unknown option: --names"])(
    "leaves unrecognised diagnostics alone: %s", line => {
      expect(piLaunchCapabilityError("/pane/pi", "approve", line, () => { throw new Error("must not probe"); }))
        .toBeUndefined();
    });

  it("keeps a timed-out version diagnostic nonfatal", () => {
    expect(piLaunchCapabilityError("/pane/pi", "approve", "Unknown option: --name", () => {
      throw { code: "ETIMEDOUT" };
    })).toContain("unknown version");
  });

});
