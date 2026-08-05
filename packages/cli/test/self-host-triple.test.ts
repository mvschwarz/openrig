import { describe, it, expect } from "vitest";
import { wrapSendBody } from "../src/commands/send.js";
import { resolveCrossHostTarget } from "../src/cross-host-target.js";
import { fetchSelfHostId } from "../src/daemon-lifecycle.js";

// 51-09 increment 3 — always-suffix sender triple (ruling cb19867f Q2) + the
// reverse-dead-letter self-strip (ruling 2e1b737f). RED provenance: at 38512e2d
// wrapSendBody has no selfHostId param (renders the 2-part From:) and
// resolveCrossHostTarget has no self-strip (a self-suffix falls through to
// unknown_destination_rig), so every triple/self-strip assertion below fails.

const SENDER = "dev50-driver@v-openrig-build";
const SELF = "mm2-openrig1";

describe("wrapSendBody — always-suffix sender triple", () => {
  it("renders the <member>@<rig>@<selfHostId> triple in BOTH From: and the reply hint (always, local included)", () => {
    const out = wrapSendBody(SENDER, "peer@rig", "hi", SELF);
    expect(out).toContain(`From: ${SENDER}@${SELF}`);
    expect(out).toContain(`↩ Reply: rig send ${SENDER}@${SELF} "..."`);
  });

  it("C1 fail-open: with no selfHostId it renders EXACTLY today's two-part form", () => {
    const withId = wrapSendBody(SENDER, "peer@rig", "hi", undefined);
    const legacy3arg = wrapSendBody(SENDER, "peer@rig", "hi");
    expect(withId).toBe(legacy3arg);
    expect(withId).toContain(`From: ${SENDER}\n`);
    expect(withId).not.toContain(`@${SELF}`);
  });

  it("discriminating pair (rider): same selfId → byte-identical; different selfId → differ ONLY at the host token", () => {
    const a1 = wrapSendBody(SENDER, "peer@rig", "hi", "host-aaaa");
    const a2 = wrapSendBody(SENDER, "peer@rig", "hi", "host-aaaa");
    const b = wrapSendBody(SENDER, "peer@rig", "hi", "host-bbbb");
    expect(a1).toBe(a2); // same in → byte-identical out
    expect(a1).not.toBe(b); // param is LIVE
    // differ ONLY at the host token:
    expect(a1.split("host-aaaa").join("host-bbbb")).toBe(b);
  });

  it("never suffixes the <unknown sender> fallback", () => {
    const out = wrapSendBody(undefined, "peer@rig", "hi", SELF);
    expect(out).toContain("From: <unknown sender>");
    expect(out).not.toContain(`@${SELF}`);
  });

  it("--from relay: a sender ALREADY carrying an origin triple is preserved verbatim, never re-stamped with THIS host", () => {
    const originTriple = `${SENDER}@origin-host`;
    const out = wrapSendBody(originTriple, "peer@rig", "hi", "relay-host");
    expect(out).toContain(`From: ${originTriple}\n`); // origin host preserved
    expect(out).not.toContain("@relay-host"); // NOT re-stamped (origin not forged)
    expect(out).toContain(`↩ Reply: rig send ${originTriple} "..."`); // reply routes to the ORIGIN
  });
});

describe("fetchSelfHostId — best-effort /healthz self-id (rider-b one source, C1 fail-open)", () => {
  const deps = (fetch: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>) =>
    ({ fetch } as unknown as Parameters<typeof fetchSelfHostId>[0]);

  it("reads selfHostId from /healthz on the SAME resolved url the send uses (one source, no second resolution)", async () => {
    let seen = "";
    const id = await fetchSelfHostId(
      deps(async (url) => { seen = url; return { ok: true, json: async () => ({ selfHostId: SELF }) }; }),
      "http://127.0.0.1:7433",
    );
    expect(id).toBe(SELF);
    expect(seen).toBe("http://127.0.0.1:7433/healthz");
  });

  it("C1 negative — the TIMEOUT leg: a hung /healthz times out (~250ms bound) → undefined (send falls open to 2-part)", async () => {
    const id = await fetchSelfHostId(deps(() => new Promise(() => {})), "http://127.0.0.1:7433");
    expect(id).toBeUndefined();
  }, 3000);

  it("C1 fail-open: fetch error, non-ok, and a body WITHOUT selfHostId (pre-reconcile) all → undefined", async () => {
    expect(await fetchSelfHostId(deps(async () => { throw new Error("ECONNREFUSED"); }), "http://x")).toBeUndefined();
    expect(await fetchSelfHostId(deps(async () => ({ ok: false })), "http://x")).toBeUndefined();
    expect(await fetchSelfHostId(deps(async () => ({ ok: true, json: async () => ({}) })), "http://x")).toBeUndefined();
  });
});

describe("resolveCrossHostTarget — self-id self-strip (reverse dead-letter fix)", () => {
  const noHosts = () => ({ ok: true as const, registry: { hosts: [] } });

  it("a suffix == the literal self-id STRIPS and routes home (target=base, no sugarHost)", () => {
    const r = resolveCrossHostTarget(`peer@rig@${SELF}`, undefined, noHosts, SELF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("peer@rig");
      expect(r.sugarHost).toBeUndefined();
      expect(r.hint).toBeUndefined();
    }
  });

  it("rider (a) discriminating pair: a NON-self UNREGISTERED suffix still fails LOUD (never falls through to local)", () => {
    const r = resolveCrossHostTarget("peer@rig@not-me", undefined, noHosts, SELF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe("peer@rig@not-me"); // unchanged — NOT stripped to local
      expect(r.sugarHost).toBeUndefined();
      expect(r.hint).toMatch(/no registered host 'not-me'/);
    }
  });

  it("C2 case-sensitive: a case-only divergence is NOT the self-id (not stripped)", () => {
    const r = resolveCrossHostTarget(`peer@rig@${SELF.toUpperCase()}`, undefined, noHosts, SELF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe(`peer@rig@${SELF.toUpperCase()}`); // unchanged
      expect(r.hint).toBeTruthy(); // loud
    }
  });

  it("C1 fail-open: with no selfHostId a self-suffixed target passes through EXACTLY as today", () => {
    const r = resolveCrossHostTarget(`peer@rig@${SELF}`, undefined, noHosts, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe(`peer@rig@${SELF}`); // unchanged (today's behavior)
      expect(r.hint).toBeTruthy();
    }
  });
});
