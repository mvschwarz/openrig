import { describe, it, expect } from "vitest";
import { resolveStartup, type StartupLayerInputs } from "../src/domain/startup-resolver.js";
import type { StartupBlock, StartupFile } from "../src/domain/types.js";

function makeFile(path: string): StartupFile {
  return { path, deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] };
}

function makeBlock(paths: string[]): StartupBlock {
  return { files: paths.map(makeFile), actions: [] };
}

describe("Startup resolver", () => {
  // T9: startup files ordered: agent base → profile → culture → rig overlay → pod shared → member
  it("startup files ordered correctly across all layers", () => {
    const inputs: StartupLayerInputs = {
      specStartup: makeBlock(["startup/base.md"]),
      profileStartup: makeBlock(["startup/profile.md"]),
      rigCultureFile: "culture.md",
      rigStartup: makeBlock(["startup/rig-overlay.md"]),
      podStartup: makeBlock(["pods/dev/shared.md"]),
      memberStartup: makeBlock(["pods/dev/overlays/impl.md"]),
    };

    const result = resolveStartup(inputs);
    const paths = result.files.map((f) => f.path);

    expect(paths).toEqual([
      "startup/base.md",        // 1. agent base
      "startup/profile.md",     // 2. profile
      "culture.md",             // 3. rig culture
      "startup/rig-overlay.md", // 4. rig overlay
      "pods/dev/shared.md",     // 5. pod shared
      "pods/dev/overlays/impl.md", // 6. member
    ]);
  });

  // T10: operator startup append happens last
  it("operator startup append happens last", () => {
    const inputs: StartupLayerInputs = {
      specStartup: makeBlock(["startup/base.md"]),
      profileStartup: makeBlock(["startup/profile.md"]),
      rigCultureFile: "culture.md",
      rigStartup: makeBlock(["startup/rig.md"]),
      podStartup: makeBlock(["pods/dev/shared.md"]),
      memberStartup: makeBlock(["pods/dev/overlays/impl.md"]),
      operatorStartup: makeBlock(["debug/operator-debug.md"]),
    };

    const result = resolveStartup(inputs);
    const paths = result.files.map((f) => f.path);

    // Operator debug is always last
    expect(paths[paths.length - 1]).toBe("debug/operator-debug.md");
    expect(paths).toHaveLength(7);
    expect(paths.indexOf("debug/operator-debug.md")).toBe(6);
  });

  it("empty layers are skipped without gaps", () => {
    const inputs: StartupLayerInputs = {
      specStartup: makeBlock(["base.md"]),
      // no profile, no culture, no rig, no pod
      memberStartup: makeBlock(["member.md"]),
    };

    const result = resolveStartup(inputs);
    expect(result.files.map((f) => f.path)).toEqual(["base.md", "member.md"]);
  });
});
