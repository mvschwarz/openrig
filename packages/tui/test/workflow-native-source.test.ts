import { describe, expect, it } from "vitest";
import { workflowDetail } from "../src/execution/workflow-model.js";

describe("workflow bound source navigation", () => {
  it.each([
    "/workspace/scopes/release/slices/12-native/SPEC.yaml",
    String.raw`C:\工作 projects\scopes\release\slices\12-native\SPEC.yaml`,
    String.raw`\\server\workspace\scopes\release\slices\12-native\SPEC.yaml`,
  ])("opens the slice from daemon filesystem path %s", (path) => {
    const lines = workflowDetail({
      mission: "release", derived_at: "2026-10-30T00:00:00Z",
      lifecycle_instances: [{ instance_id: "run", status: "running", sources: [{ kind: "slice", path }] }],
    } as never, "workflow:run", 200)!;
    expect(lines.find((line) => line.action?.type === "scopes-open")?.action).toEqual({
      type: "scopes-open", mission: "release", slice: "12-native",
    });
    expect(lines.map((line) => line.text).join("\n")).toContain(path);
  });
});
