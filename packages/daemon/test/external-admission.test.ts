import { describe, it, expect } from "vitest";
import { resolveExternal, OPERATOR_HUMAN_DEFAULT_SLOT, type RegisteredEntity } from "../src/domain/gateway/external-admission.js";

// M1 A4b — @external entity-admission resolver. Contract 2a57d099. The four ruled
// outcomes; proof-2's ENTITY-level teaching refusal text lives here (the DOMAIN-level
// bounce is A1/A2's unknown_destination_rig fall-through).

const REG: RegisteredEntity[] = [
  { entityId: "mike", address: "mike@external" },
  { entityId: "founder", address: "founder@external" },
];

describe("A4b resolveExternal", () => {
  it("registered mike@external -> { registered }", () => {
    const r = resolveExternal("mike", REG);
    expect(r.kind).toBe("registered");
    if (r.kind === "registered") expect(r.entityId).toBe("mike");
  });

  it("literal scheme slack:U012AB3CD -> { scheme } one-off address (never a registry lookup)", () => {
    const r = resolveExternal("slack:U012AB3CD", REG);
    expect(r.kind).toBe("scheme");
    if (r.kind === "scheme") { expect(r.scheme).toBe("slack"); expect(r.handle).toBe("U012AB3CD"); }
  });

  it("unregistered stranger@external -> LOUD teaching refusal, NEVER agent-class downgrade", () => {
    const r = resolveExternal("stranger", REG);
    expect(r.kind).toBe("unregistered");
    if (r.kind === "unregistered") {
      expect(r.error).toMatch(/not.*registered|no registered/i);
      expect(r.error).toMatch(/rig gateway human add/);            // teaching: how to fix
      expect(r.error).toMatch(/NOT downgraded to an agent seat/i); // never a silent agent-class fall
    }
  });

  it("scheme form is NOT resolved against the registry (a registered-looking scheme stays scheme)", () => {
    const r = resolveExternal("mike:extra", REG);
    expect(r.kind).toBe("scheme");
  });

  it("the default inbound slot is operator-human@kernel", () => {
    expect(OPERATOR_HUMAN_DEFAULT_SLOT).toBe("operator-human@kernel");
  });
});
