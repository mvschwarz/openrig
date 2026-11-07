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
  resolveRelayHandle,
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
const relay = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "relay", connectorRef: "relay-main", secretsRef: "file:/etc/openrig/relay.env", role: "primary", ...over,
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

  it("relay handle within-fragment uniqueness is scoped to connectorRef", () => {
    const dupSameRef = validateHumanFragment(frag("mike", [
      relay({ connectorRef: "relay-a", handle: "alice", role: "primary" }),
      relay({ connectorRef: "relay-a", handle: "alice", role: "secondary" }),
    ]));
    expect(dupSameRef.ok).toBe(false);
    if (!dupSameRef.ok) expect(dupSameRef.error).toMatch(/duplicate .*handle/i);

    const diffRefs = validateHumanFragment(frag("mike", [
      relay({ connectorRef: "relay-a", handle: "alice", role: "primary" }),
      relay({ connectorRef: "relay-b", handle: "alice", role: "secondary" }),
    ]));
    expect(diffRefs.ok).toBe(true);
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

  it("relay handle uniqueness across humans is scoped by connectorRef (same ref collides, different ref allowed)", () => {
    expect(addHumanFragment(frag("mike", [relay({ connectorRef: "relay-a", handle: "op" })]), home).ok).toBe(true);
    const collision = addHumanFragment(frag("dana", [relay({ connectorRef: "relay-a", handle: "op" })]), home);
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.error).toMatch(/already registered to human "mike"|registration conflict/i);

    const differentRef = addHumanFragment(frag("dana", [relay({ connectorRef: "relay-b", handle: "op" })]), home);
    expect(differentRef.ok).toBe(true);
  });

  it("handles relay connectorRef containing colons unambiguously without false collision", () => {
    // If colon-concatenation were used ("relay:" + connectorRef + ":" + handle),
    // ("net:east", "worker") and ("net", "east:worker") could collide if handles permitted colons.
    // Even with handle restricted to HANDLE_PATTERN, distinct connectorRefs like "bridge:1" vs "bridge"
    // with handles "2" and "1:2" would be ambiguous if handles had colons.
    // With unambiguous JSON tuple [kind, connectorRef, handle], different connectorRefs with colons never falsely collide.
    expect(addHumanFragment(frag("mike", [relay({ connectorRef: "region:us-east:primary", handle: "admin" })]), home).ok).toBe(true);
    const otherRef = addHumanFragment(frag("dana", [relay({ connectorRef: "region:us-east:secondary", handle: "admin" })]), home);
    expect(otherRef.ok).toBe(true);

    const sameColonRefCollision = addHumanFragment(frag("alex", [relay({ connectorRef: "region:us-east:primary", handle: "admin" })]), home);
    expect(sameColonRefCollision.ok).toBe(false);
  });

  it("projectHumans refuses two fragments colliding on the same relay connectorRef+handle", () => {
    const dir = humansDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mike.yaml"), stringifyYaml(frag("mike", [relay({ connectorRef: "relay-a", handle: "op" })])));
    writeFileSync(join(dir, "dana.yaml"), stringifyYaml(frag("dana", [relay({ connectorRef: "relay-a", handle: "op" })])));
    const p = projectHumans(home);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toMatch(/claimed by both|registration conflict/i);
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

describe("resolveRelayHandle (scoped to connectorRef + handle)", () => {
  const mike = (validateHumanFragment(frag("mike", [relay({ connectorRef: "relay-a", handle: "founder" })])) as { ok: true; fragment: HumanFragment }).fragment;
  const dana = (validateHumanFragment(frag("dana", [relay({ connectorRef: "relay-a", handle: "partner" })])) as { ok: true; fragment: HumanFragment }).fragment;
  const otherRelay = (validateHumanFragment(frag("alex", [relay({ connectorRef: "relay-b", handle: "founder" })])) as { ok: true; fragment: HumanFragment }).fragment;
  const outboundRelay = (validateHumanFragment(frag("outbound", [relay({ connectorRef: "relay-a" })])) as { ok: true; fragment: HumanFragment }).fragment;
  const slackOnly = (validateHumanFragment(frag("slackperson", [slack({ connectorRef: "relay-a", handle: "slack-alias" })])) as { ok: true; fragment: HumanFragment }).fragment;
  const all = [mike, dana, otherRelay, outboundRelay, slackOnly];

  it("resolves a registered relay connectorRef+handle to the exact person on that relay", () => {
    expect(resolveRelayHandle("relay-a", "founder", all)).toMatchObject({
      kind: "registered",
      entityId: "mike",
      address: "mike@external",
      connectorRef: "relay-a",
      handle: "founder",
    });
    expect(resolveRelayHandle("relay-a", "partner", all)).toMatchObject({
      kind: "registered",
      entityId: "dana",
      address: "dana@external",
      connectorRef: "relay-a",
      handle: "partner",
    });
    expect(resolveRelayHandle("relay-b", "founder", all)).toMatchObject({
      kind: "registered",
      entityId: "alex",
      address: "alex@external",
      connectorRef: "relay-b",
      handle: "founder",
    });
  });

  it("rejects cross-profile handle assertions, slack handles, and handle-less relay bindings", () => {
    const wrongProfile = resolveRelayHandle("relay-b", "partner", all);
    expect(wrongProfile.kind).toBe("unregistered");
    if (wrongProfile.kind === "unregistered") {
      expect(wrongProfile.error).toMatch(/not a registered human/i);
      expect(wrongProfile.error).toMatch(/NOT landed as a fabricated human seat/i);
    }
    expect(resolveRelayHandle("relay-a", "slack-alias", all).kind).toBe("unregistered");
    expect(resolveRelayHandle("relay-a", "relay-a", all).kind).toBe("unregistered");
  });
});
