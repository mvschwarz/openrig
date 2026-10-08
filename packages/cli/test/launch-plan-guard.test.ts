import { describe, it, expect } from "vitest";
import { isPlanAnswer, planSupportRefusal } from "../src/launch-plan-guard.js";

describe("launch --plan guard", () => {
  it.each(["0.5.9", "0.5.10", "0.6.0", "0.6.8-rc.1", "1.0.0"])("allows a plan on daemon %s", async (version) => {
    expect(await planSupportRefusal(async () => ({ version }))).toBeNull();
  });

  it.each(["0.5.8", "0.5.9-rc.1", "0.4.9", "0.3.4"])("refuses before sending on daemon %s, which ignores plan", async (version) => {
    const refusal = await planSupportRefusal(async () => ({ version }));
    expect(refusal).toContain(`reports version ${version}`);
    expect(refusal).toContain("0.5.9 or later");
  });

  it.each([
    ["unknown", { version: "unknown" }],
    ["no body (the route is absent before 0.4.1)", undefined],
    ["no version field", {}],
  ])("refuses when the version is %s", async (_label, body) => {
    expect(await planSupportRefusal(async () => body)).toContain("Not sent");
  });

  it("refuses when the version read throws", async () => {
    expect(await planSupportRefusal(async () => { throw new Error("connection refused"); })).toContain("did not report its version");
  });

  it("accepts only an answer that says planOnly: true", () => {
    expect(isPlanAnswer({ ok: true, planOnly: true })).toBe(true);
    expect(isPlanAnswer({ ok: true, launched: [] })).toBe(false);
    expect(isPlanAnswer({ planOnly: "true" })).toBe(false);
    expect(isPlanAnswer(undefined)).toBe(false);
  });
});
