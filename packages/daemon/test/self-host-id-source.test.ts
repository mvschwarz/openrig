// Slice 14 §2c — where THIS host's identity came from, derived honestly.
//
// `self_host_identity` stores host_id / minted_at / reconciled_at and NOTHING about provenance, so
// there is no record to read. What can be derived is derived; what cannot is named INDETERMINATE
// rather than guessed — an unknown that reads as a known state is the exact defect this slice is
// about, and a machine someone DID name must never be reported as `generated`.

import { describe, it, expect } from "vitest";
import { deriveSelfHostIdSource } from "../src/domain/seat-identity-reconciler.js";

describe("deriveSelfHostIdSource", () => {
  it("reports named when the configured host.name IS the live id", () => {
    expect(deriveSelfHostIdSource("mm2-openrig1", "mm2-openrig1")).toBe("named");
    expect(deriveSelfHostIdSource("mm2-openrig1", "  mm2-openrig1  ")).toBe("named");
  });

  it("reports generated when nobody named the host and the id carries the fallback shape", () => {
    expect(deriveSelfHostIdSource("host-84c37990", null)).toBe("generated");
    expect(deriveSelfHostIdSource("host-84c37990", "   ")).toBe("generated");
  });

  // THE CASE THAT MUST NOT LIE. The reconciler keeps the minted id when an operator sets host.name
  // afterwards (a durable identity is never silently re-keyed) and warns. From then on the name and
  // the id disagree — that machine WAS named, so `generated` would be a false claim about it.
  it("reports indeterminate when a configured name disagrees with the live id", () => {
    expect(deriveSelfHostIdSource("host-84c37990", "mm2-openrig1")).toBe("indeterminate");
  });

  it("reports indeterminate for an unnamed host whose id fits neither story", () => {
    expect(deriveSelfHostIdSource("some-legacy-id", null)).toBe("indeterminate");
    expect(deriveSelfHostIdSource("host-NOTHEX0", null)).toBe("indeterminate");
  });

  it("reports nothing at all when there is no id yet (pre-boot-reconcile)", () => {
    expect(deriveSelfHostIdSource(null, "mm2-openrig1")).toBeNull();
    expect(deriveSelfHostIdSource("", "mm2-openrig1")).toBeNull();
    expect(deriveSelfHostIdSource(undefined, undefined)).toBeNull();
  });
});
