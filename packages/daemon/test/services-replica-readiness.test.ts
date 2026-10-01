import { describe, expect, it } from "vitest";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { evaluateWaitTargets } from "../src/domain/services-readiness.js";

describe("Compose replica readiness", () => {
  it.each([
    [["healthy", "healthy"], "healthy"],
    [["healthy", "unhealthy"], "unhealthy"],
    [["unhealthy", "healthy"], "unhealthy"],
    [["healthy", "starting"], "pending"],
    [["starting", "healthy"], "pending"],
    [["starting", "unhealthy"], "unhealthy"],
    [["healthy", ""], "unhealthy"],
    [[], "unhealthy"],
  ] as const)("aggregates replicas %j as %s", async (healths, expected) => {
    // The adapter retains one status per Compose ps JSON row, including replicas.
    const output = healths.map((Health, index) => JSON.stringify({
      Service: "fixture", Name: `owned-fixture-${index + 1}`, State: "running", Status: "Up", Health,
    })).join("\n");
    const adapter = new ComposeServicesAdapter(async () => output);
    const status = await adapter.status({ composeFile: "/owned/compose.yaml", projectName: "owned" });
    const result = await evaluateWaitTargets([{ service: "fixture", condition: "healthy" }], adapter, status.services);
    expect(result[0]!.status).toBe(expected);
    if (expected === "unhealthy" && healths.length === 0) expect(result[0]!.detail).toContain("not found");
  });
});
