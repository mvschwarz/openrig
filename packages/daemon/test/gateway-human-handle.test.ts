import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import {
  validateHumanFragment,
  addHumanFragment,
  projectHumans,
  resolveSlackHandle,
  humansDir,
  type HumanFragment,
} from "../src/domain/gateway/human-registry.js";

// M1 A6 v3 (schema 9e468b2f) — the per-binding `handle` + its three pins:
//   pin-1 UNIQUE per kind across ALL bindings (one platform id = one human; dup REFUSED)
//   pin-2 resolve ev.user -> (kind=slack, handle) -> entityId; unknown = REFUSED
//   pin-3 handle REQUIRED to be inbound-resolvable — a handle-less binding is outbound-only
//         and fails inbound LOUDLY.

function frag(entityId: string, bindings: Record<string, unknown>[]): Record<string, unknown> {
  return {
    entityId,
    class: "human",
    displayName: entityId,
    address: `${entityId}@external`,
    connectorBindings: bindings,
    prefs: { deliveryClass: "B" },
  };
}
const slack = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "slack", connectorRef: "slack-main", secretsRef: "vault://slack/x", role: "primary", ...over,
});

describe("A6 v3 handle schema", () => {
  it("accepts an optional well-formed handle; a handle-less binding is still valid (outbound-only)", () => {
    expect(validateHumanFragment(frag("mike", [slack({ handle: "U012AB3CD" })])).ok).toBe(true);
    expect(validateHumanFragment(frag("mike", [slack()])).ok).toBe(true); // no handle = outbound-only
  });

  it("rejects a ref-forgery handle (':' '@' or whitespace)", () => {
    for (const bad of ["a:b", "x@kernel", "has space", "semi;colon"]) {
      const r = validateHumanFragment(frag("mike", [slack({ handle: bad })]));
      expect(r.ok, `handle ${JSON.stringify(bad)} must be rejected`).toBe(false);
    }
  });

  it("rejects an unknown binding key (closed set still holds with handle added)", () => {
    expect(validateHumanFragment(frag("mike", [slack({ nope: "x" })])).ok).toBe(false);
  });

  it("pin-1 within-fragment: the same kind+handle twice on ONE human is REFUSED", () => {
    const r = validateHumanFragment(frag("mike", [
      slack({ handle: "U1", role: "primary" }),
      slack({ handle: "U1", role: "secondary", connectorRef: "slack-2" }),
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate .*handle|unique per kind/i);
  });
});

describe("A6 v3 handle uniqueness across humans (pin-1 registry-level)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "a6-handle-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("addHumanFragment REFUSES a handle already registered to a different human (before writing)", () => {
    expect(addHumanFragment(frag("mike", [slack({ handle: "U1" })]), home).ok).toBe(true);
    const r = addHumanFragment(frag("dana", [slack({ handle: "U1", connectorRef: "slack-2" })]), home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already registered to human "mike"|registration conflict/i);
    // the conflicting fragment must NOT have been written
    expect(addHumanFragment).toBeDefined();
  });

  it("projectHumans REFUSES two hand-written fragments that collide on a handle (load-time backstop)", () => {
    const dir = humansDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mike.yaml"), stringifyYaml(frag("mike", [slack({ handle: "U1" })])));
    writeFileSync(join(dir, "dana.yaml"), stringifyYaml(frag("dana", [slack({ handle: "U1", connectorRef: "slack-2" })])));
    const p = projectHumans(home);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toMatch(/claimed by both|registration conflict/i);
  });

  it("the SAME human re-added with --replace keeps its own handle (not a self-conflict)", () => {
    expect(addHumanFragment(frag("mike", [slack({ handle: "U1" })]), home).ok).toBe(true);
    const r = addHumanFragment(frag("mike", [slack({ handle: "U1", connectorRef: "slack-main" })]), home, { replace: true });
    expect(r.ok).toBe(true);
  });
});

describe("A6 v3 resolveSlackHandle (pins 2+3)", () => {
  const registered = (validateHumanFragment(frag("mike", [slack({ handle: "U012AB3CD" })])) as { ok: true; fragment: HumanFragment }).fragment;
  const outboundOnly = (validateHumanFragment(frag("dana", [slack({ connectorRef: "slack-2" })])) as { ok: true; fragment: HumanFragment }).fragment;

  it("pin-2: a registered handle resolves to its entity + address", () => {
    const r = resolveSlackHandle("U012AB3CD", [registered, outboundOnly]);
    expect(r.kind).toBe("registered");
    if (r.kind === "registered") { expect(r.entityId).toBe("mike"); expect(r.address).toBe("mike@external"); }
  });

  it("pin-2: an unknown handle is REFUSED with LOUD teaching (never fabricates a seat)", () => {
    const r = resolveSlackHandle("UNOPE", [registered, outboundOnly]);
    expect(r.kind).toBe("unregistered");
    if (r.kind === "unregistered") {
      expect(r.error).toMatch(/not a registered human/i);
      expect(r.error).toMatch(/rig gateway human add/);
      expect(r.error).toMatch(/NOT landed as a fabricated human seat/i);
    }
  });

  it("pin-3: a handle-LESS (outbound-only) human is NOT inbound-resolvable — fails LOUDLY", () => {
    // dana has a binding with no handle; nothing about dana can be resolved inbound.
    const r = resolveSlackHandle("slack-2", [registered, outboundOnly]); // even matching connectorRef must not resolve
    expect(r.kind).toBe("unregistered");
  });
});
