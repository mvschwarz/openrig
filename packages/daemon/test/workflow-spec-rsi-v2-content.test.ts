import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";

const SPEC_PATH = join(
  process.cwd(),
  "src/builtins/workflow-specs/rsi-v2-hot-potato.yaml",
);

describe("built-in rsi-v2-hot-potato workflow spec", () => {
  it("lets Discovery park no-follow-on loopback signal with done", () => {
    const spec = parseWorkflowSpec(readFileSync(SPEC_PATH, "utf8"), SPEC_PATH);
    const discovery = spec.steps.find((step) => step.id === "discovery");

    expect(discovery?.objective).toContain("close as no-op");
    expect(discovery?.allowed_exits).toContain("done");
  });

  it("declares QA handoff back to Discovery through next_hop", () => {
    const spec = parseWorkflowSpec(readFileSync(SPEC_PATH, "utf8"), SPEC_PATH);
    const qa = spec.steps.find((step) => step.id === "qa");

    expect(qa?.allowed_exits).toContain("handoff");
    expect(qa?.next_hop?.suggested_roles).toContain("discovery-router");
  });
});
