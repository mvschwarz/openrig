import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  contextUsageDirectory,
  providerUsageDirectory,
  telemetrySidecarFilename,
} from "../src/domain/telemetry-state-paths.js";

describe("OpenRig-owned telemetry paths", () => {
  it("owns both telemetry roots beneath state", () => {
    expect(contextUsageDirectory("/openrig-home")).toBe("/openrig-home/state/context-usage");
    expect(providerUsageDirectory("/openrig-home")).toBe("/openrig-home/state/provider-usage");
  });

  it("owns the sidecar filename rule used by readers", () => {
    expect(telemetrySidecarFilename("dev/impl @ test")).toBe("dev_impl_@_test.json");
  });

  it("keeps the projected CJS collector filename rule in parity", () => {
    const collector = fs.readFileSync(
      path.join(import.meta.dirname, "../assets/claude-statusline-context.cjs"),
      "utf8",
    );
    const sessionName = "dev/impl @ test";
    const collectorRule = sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_") + ".json";
    expect(telemetrySidecarFilename(sessionName)).toBe(collectorRule);
    expect(collector).toContain("/[^a-zA-Z0-9@._-]/g");
  });
});
