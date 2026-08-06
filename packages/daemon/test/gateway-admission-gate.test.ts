import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { destinationRefusalTeaching, externalAdmissionTeaching } from "../src/domain/queue-repository.js";
import { addHumanFragment } from "../src/domain/gateway/human-registry.js";
import { resolveExternal } from "../src/domain/gateway/external-admission.js";

// M1 A4b — @external entity-admission at the queue-destination gate. proof-2: BOTH refusal
// texts — the ENTITY-level teaching (unregistered @external, here) + the DOMAIN-level bounce
// (a token NOT in the closed set falls through to unknown_destination_rig, A1/A2). Admission
// resolves @external against the A3 registry (loadHumanRegistry); registered/scheme admit,
// unregistered refuses LOUD.

describe("A4b @external gate admission + proof-2 teaching", () => {
  let home: string;
  let prevHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "a4b-gate-"));
    prevHome = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = home;
    // register one human so the resolve has a real hit
    addHumanFragment({
      entityId: "mike", class: "human", displayName: "Mike", address: "mike@external",
      connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://x", role: "primary" }],
      prefs: { deliveryClass: "B" },
    }, home);
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  // The admission decision (what topologyValidateRig returns for kind:external).
  it("admits a REGISTERED @external, refuses an UNREGISTERED one (the gate boolean)", () => {
    const admit = (local: string) => {
      const entities = [{ entityId: "mike", address: "mike@external" }];
      return resolveExternal(local, entities).kind !== "unregistered";
    };
    expect(admit("mike")).toBe(true);            // registered
    expect(admit("slack:U0123")).toBe(true);     // literal scheme (one-off address)
    expect(admit("stranger")).toBe(false);       // unregistered -> refused
  });

  // proof-2 text #1 — ENTITY-level teaching for an unregistered @external destination.
  it("an unregistered @external destination refuses with ENTITY teaching (register-how + not-an-agent)", () => {
    const t = destinationRefusalTeaching("stranger@external");
    expect(t).toBeDefined();
    expect(t!.unregisteredEntity).toBe("stranger");
    expect(t!.externalDomain).toBe("external");
    expect(String(t!.hint)).toMatch(/no registered human|rig gateway human add/);
    expect(String(t!.hint)).toMatch(/NOT downgraded to an agent seat/i);
  });

  it("a REGISTERED @external destination is admitted (no refusal teaching)", () => {
    expect(externalAdmissionTeaching("mike@external")).toBeUndefined();
    expect(destinationRefusalTeaching("mike@external")).toBeUndefined();
  });

  // proof-2 text #2 — DOMAIN-level: a non-'external' domain is NOT an entity concern; it
  // falls through to the host/unknown_destination_rig path (no entity teaching).
  it("a non-external domain gets NO entity teaching (domain-bounce path is A1/A2's)", () => {
    expect(externalAdmissionTeaching("mike@notexternal")).toBeUndefined();
    // 3-part host-suffix still gets the HOST teaching via the dispatch (unchanged 4b)
    const host = destinationRefusalTeaching("member@rig@somehost");
    expect(host).toBeDefined();
    expect(host!.hint).toMatch(/--host/);
  });
});
