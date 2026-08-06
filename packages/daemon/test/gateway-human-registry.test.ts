import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import {
  validateHumanFragment,
  addHumanFragment,
  projectHumans,
  writeProjection,
  loadHumanRegistry,
  humansDir,
  projectionPath,
  OPERATOR_HUMAN_DEFAULT_SLOT,
  type HumanFragment,
} from "../src/domain/gateway/human-registry.js";

// M1 A3 — human fragments + generated registry projection. Schema b2a2594b
// (prefs per-ENTITY, role per-BINDING). Proof-5: two fragments -> projection;
// a fragment edit re-projects; the projection hand-edit refuses.

function fragment(over: Partial<HumanFragment> = {}): Record<string, unknown> {
  const entityId = (over.entityId as string) ?? "mike";
  return {
    entityId,
    class: "human",
    displayName: "Mike",
    address: `${entityId}@external`, // the registered convention; override to test the pin
    connectorBindings: [
      { kind: "slack", connectorRef: "slack-main", secretsRef: "vault://slack/mike", role: "primary" },
    ],
    prefs: { deliveryClass: "B" },
    ...over,
  };
}

describe("A3 human-fragment validation (add-time == load-time)", () => {
  it("accepts a well-formed fragment", () => {
    const r = validateHumanFragment(fragment());
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown class (closed enum)", () => {
    const r = validateHumanFragment(fragment({ class: "agent" as HumanFragment["class"] }));
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown connector kind (closed enum)", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [{ kind: "telegram", connectorRef: "x", secretsRef: "v", role: "primary" }] });
    expect(r.ok).toBe(false);
  });

  it("rejects zero connectorBindings (>=1)", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects an entity with NO primary binding (exactly-one-primary)", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [{ kind: "slack", connectorRef: "x", secretsRef: "v", role: "secondary" }] });
    expect(r.ok).toBe(false);
  });

  it("rejects an entity with TWO primary bindings (exactly-one-primary)", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [
      { kind: "slack", connectorRef: "a", secretsRef: "v1", role: "primary" },
      { kind: "slack", connectorRef: "b", secretsRef: "v2", role: "primary" },
    ] });
    expect(r.ok).toBe(false);
  });

  it("accepts multiple bindings with exactly one primary (per-binding routing)", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [
      { kind: "slack", connectorRef: "a", secretsRef: "v1", role: "primary" },
      { kind: "slack", connectorRef: "b", secretsRef: "v2", role: "secondary" },
    ] });
    expect(r.ok).toBe(true);
  });

  it("rejects a bad deliveryClass (A-D closed set)", () => {
    const r = validateHumanFragment(fragment({ prefs: { deliveryClass: "E" } as HumanFragment["prefs"] }));
    expect(r.ok).toBe(false);
  });

  it("rejects an empty secretsRef (pointer required, never the secret)", () => {
    const r = validateHumanFragment({ ...fragment(), connectorBindings: [{ kind: "slack", connectorRef: "x", secretsRef: "", role: "primary" }] });
    expect(r.ok).toBe(false);
  });

  it("rejects a non-slug entityId", () => {
    expect(validateHumanFragment(fragment({ entityId: "Mike Jones" })).ok).toBe(false);
    expect(validateHumanFragment(fragment({ entityId: "../evil" })).ok).toBe(false);
  });

  it("operator-human@kernel is the fallback slot, NOT a fragment", () => {
    expect(OPERATOR_HUMAN_DEFAULT_SLOT).toBe("operator-human@kernel");
  });
});

describe("A3 proof-5 — fragments -> generated projection; re-project; hand-edit refuses", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "a3-humans-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("two fragments (founder + one) -> projection lists BOTH, sorted, DO-NOT-EDIT header", () => {
    expect(addHumanFragment(fragment({ entityId: "mike", address: "mike@external" }), home).ok).toBe(true);
    expect(addHumanFragment(fragment({ entityId: "founder", displayName: "Founder", address: "founder@external" }), home).ok).toBe(true);

    // both fragment files exist
    expect(existsSync(join(humansDir(home), "mike.yaml"))).toBe(true);
    expect(existsSync(join(humansDir(home), "founder.yaml"))).toBe(true);

    const proj = readFileSync(projectionPath(home), "utf8");
    expect(proj).toContain("GENERATED FILE — DO NOT EDIT");

    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.entities.map((e) => e.entityId)).toEqual(["founder", "mike"]); // sorted
    }
  });

  it("a fragment EDIT re-projects (projection tracks the fragment = truth)", () => {
    addHumanFragment(fragment({ entityId: "mike", prefs: { deliveryClass: "B" } }), home);
    const before = readFileSync(projectionPath(home), "utf8");
    // edit the fragment via the EXPLICIT replace path (deliveryClass B -> D) + re-project
    expect(addHumanFragment(fragment({ entityId: "mike", prefs: { deliveryClass: "D" } }), home, { replace: true }).ok).toBe(true);
    const after = readFileSync(projectionPath(home), "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain("deliveryClass: D");
    expect(loadHumanRegistry(home).ok).toBe(true);
  });

  it("a HAND-EDIT of the projection is REFUSED at load (fragment is truth)", () => {
    addHumanFragment(fragment({ entityId: "mike" }), home);
    expect(loadHumanRegistry(home).ok).toBe(true); // clean
    // hand-edit the generated projection
    const p = projectionPath(home);
    writeFileSync(p, readFileSync(p, "utf8") + "\n# sneaky hand edit\n");
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/HAND-EDITED|DRIFT/i);
  });

  it("an INVALID fragment on disk fails projection LOUD (load-time == add-time)", () => {
    addHumanFragment(fragment({ entityId: "mike" }), home);
    // plant a structurally-invalid fragment beside the valid one
    writeFileSync(join(humansDir(home), "bad.yaml"), "entityId: bad\nclass: human\n"); // missing bindings/prefs
    const proj = projectHumans(home);
    expect(proj.ok).toBe(false);
  });

  it("a filename != <entityId>.yaml is refused (collision-free key)", () => {
    addHumanFragment(fragment({ entityId: "mike" }), home); // creates humansDir + mike.yaml
    // a valid-content fragment under the WRONG filename (entityId "mike" in wrongname.yaml)
    writeFileSync(join(humansDir(home), "wrongname.yaml"), stringifyYaml(fragment({ entityId: "mike" })));
    const proj = projectHumans(home);
    expect(proj.ok).toBe(false);
  });

  // pt2 r1 MUST — no silent clobber (managed-config data-safety; mirror addHostEntry).
  it("addHumanFragment REFUSES an existing entityId (no silent overwrite)", () => {
    expect(addHumanFragment(fragment({ entityId: "founder", displayName: "Founder" }), home).ok).toBe(true);
    const dup = addHumanFragment(fragment({ entityId: "founder", displayName: "Impostor" }), home);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toMatch(/exists|already/i);
    // the on-disk fragment is UNCHANGED (no clobber)
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok && loaded.entities[0]!.displayName).toBe("Founder");
  });

  it("addHumanFragment { replace: true } is the EXPLICIT update path", () => {
    addHumanFragment(fragment({ entityId: "founder", displayName: "Founder" }), home);
    const r = addHumanFragment(fragment({ entityId: "founder", displayName: "Founder Renamed" }), home, { replace: true });
    expect(r.ok).toBe(true);
    const loaded = loadHumanRegistry(home);
    expect(loaded.ok && loaded.entities[0]!.displayName).toBe("Founder Renamed");
  });
});

describe("A3 pt2 — hardening (r1 pooled notes)", () => {
  it("rejects UNKNOWN top-level keys (a typo must not silently degrade)", () => {
    expect(validateHumanFragment({ ...fragment(), bogus: 1 }).ok).toBe(false);
  });
  it("rejects an unknown key inside prefs (awya: typo)", () => {
    expect(validateHumanFragment(fragment({ prefs: { deliveryClass: "B", awya: true } as unknown as HumanFragment["prefs"] })).ok).toBe(false);
  });
  it("rejects an unknown key inside a connectorBinding", () => {
    expect(validateHumanFragment({ ...fragment(), connectorBindings: [{ kind: "slack", connectorRef: "x", secretsRef: "v", role: "primary", bogus: 1 }] }).ok).toBe(false);
  });
  it("pins address to <entityId>@external (mike@externalx is NOT a registered ref)", () => {
    expect(validateHumanFragment(fragment({ entityId: "mike", address: "mike@externalx" })).ok).toBe(false);
    expect(validateHumanFragment(fragment({ entityId: "mike", address: "mike@external" })).ok).toBe(true);
    expect(validateHumanFragment(fragment({ entityId: "mike", address: "other@external" })).ok).toBe(false); // must match entityId
  });
});

// (the `rig gateway human add` VERB integration tests moved to cli/test/
// gateway-human-registry-verb.test.ts — the verb lives in the cli package and
// lazy-imports this module via the @openrig/daemon/gateway-human-registry subpath.)
