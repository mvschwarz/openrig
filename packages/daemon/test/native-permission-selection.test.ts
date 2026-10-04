import { describe, expect, it } from "vitest";
import { validateNativePermissionSelection, permissionBindingOverride } from "../src/domain/native-permission-selection.js";

describe("cursor native permission selection", () => {
  it.each(["floor", "full_bypass", "auto_review"])("accepts %s", (mode) => {
    expect(validateNativePermissionSelection("cursor", mode)).toEqual({ runtime: "cursor", mode });
  });
  it("refuses other modes with the accepted list", () => {
    expect(() => validateNativePermissionSelection("cursor", "plan")).toThrow(/floor, full_bypass or auto_review/);
  });
  it("binds auto_review as a native mode and the postures as postures", () => {
    expect(permissionBindingOverride({ runtime: "cursor", mode: "auto_review" })).toEqual({ permissionMode: "auto_review" });
    expect(permissionBindingOverride({ runtime: "cursor", mode: "full_bypass" })).toEqual({ launchPosture: "full_bypass" });
  });
  it("still refuses runtimes without native modes", () => {
    expect(() => validateNativePermissionSelection("pi", "floor")).toThrow(/unsupported for runtime 'pi'/);
  });
});
