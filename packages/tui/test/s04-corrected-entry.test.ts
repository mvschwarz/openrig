import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { defaultSections } from "../src/state.js";
import { scopesExplorerRows } from "../src/scopes/scopes-model.js";

describe("founder-corrected Slice 4 entry point", () => {
  it("has no standalone execution section and opens execution from a SCOPES mission row", () => {
    expect(defaultSections().map((section) => section.name)).not.toContain("execution");
    const mission = demoSnapshot().scopes![0]!.mission;
    const row = scopesExplorerRows(demoSnapshot().scopes, new Set(), "").find((item) => item.key === `scopes-mission:${mission}`)!;
    expect(row.action).toEqual({ type: "scopes-mission-open", mission });
  });
});
