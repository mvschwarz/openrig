import { describe, expect, it } from "vitest";
import {
  filterNodesForRigId,
  selectCurrentRigSummary,
} from "../src/domain/demo-rig-selector.js";

describe("demo rig selector", () => {
  it("returns the unique current rig summary for a given name", () => {
    expect(
      selectCurrentRigSummary(
        [
          { rigId: "rig-1", name: "demo-rig" },
          { rigId: "rig-2", name: "other-rig" },
        ],
        "demo-rig"
      )
    ).toEqual({ rigId: "rig-1", name: "demo-rig" });
  });

  it("returns null when the rig name is absent", () => {
    expect(selectCurrentRigSummary([{ rigId: "rig-1", name: "demo-rig" }], "missing")).toBeNull();
  });

  it("fails loudly when multiple running rigs share the same name", () => {
    expect(() =>
      selectCurrentRigSummary(
        [
          { rigId: "rig-1", name: "demo-rig" },
          { rigId: "rig-2", name: "demo-rig" },
        ],
        "demo-rig"
      )
    ).toThrow(/ambiguous/);
  });

  it("prefers the unique running rig over stopped rigs with the same name", () => {
    expect(
      selectCurrentRigSummary(
        [
          { rigId: "old", name: "demo-rig", status: "stopped" },
          { rigId: "new", name: "demo-rig", status: "running" },
        ],
        "demo-rig"
      )
    ).toEqual({ rigId: "new", name: "demo-rig", status: "running" });
  });

  it("filters node inventory by rig id rather than rig name", () => {
    expect(
      filterNodesForRigId(
        [
          { rigId: "old", logicalId: "dev.impl" },
          { rigId: "new", logicalId: "dev.impl" },
          { rigId: "new", logicalId: "dev.qa" },
        ],
        "new"
      )
    ).toEqual([
      { rigId: "new", logicalId: "dev.impl" },
      { rigId: "new", logicalId: "dev.qa" },
    ]);
  });
});
