import { describe, it, expect } from "vitest";
import { InboundRouter, type SlackEvent } from "../src/slack/inbound.js";
import { makeInboundSenderResolver, type RegistrySurface } from "../src/slack/inbound-admission.js";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/slack/state-store.js";
import { resolveSlackHandle } from "@openrig/daemon/gateway-human-registry";
import type { HumanFragment } from "@openrig/daemon/gateway-human-registry";

// M1 A6 v3 — the inbound REGISTRATION gate. admit-iff-registered: an inbound Slack message
// becomes a human-provenance qitem ONLY when its sender resolves to a REGISTERED human; the
// source is that human's canonical @external address (never a raw platform id). An unregistered
// sender — or a registry that failed to load — is REFUSED (never a fabricated seat).

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (a, b) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-08-07T00:00:00Z");
const ev = (user: string, ts = "200.1"): SlackEvent => ({ type: "message", user, text: "hi", ts, channel: "C1" });

function makeRouter(resolveSender: (u: string) => { admitted: true; source: string } | { admitted: false; teaching: string }) {
  const fs = memFs();
  const calls: string[][] = [];
  const logs: string[] = [];
  const runner = async (args: string[]) => { calls.push(args); return { ok: true, stdout: "created qitem-in-9", stderr: "", code: 0 }; };
  const dead = new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock);
  const router = new InboundRouter({ runner, seen: new SeenStore("/s.jsonl", fs, clock), deadLetter: dead, destination: "operator-agent@kernel", resolveSender, log: (m) => logs.push(m) });
  return { router, calls, logs, dead };
}
const srcOf = (calls: string[][]): string | undefined => {
  const c = calls.find((a) => a[1] === "create");
  return c ? c[c.indexOf("--source") + 1] : undefined;
};

describe("A6 v3 inbound registration gate (InboundRouter)", () => {
  it("REGISTERED sender lands with the entity @external address as source (never the raw Slack id)", async () => {
    const { router, calls } = makeRouter((u) => (u === "U012" ? { admitted: true, source: "mike@external" } : { admitted: false, teaching: "no" }));
    const r = await router.route(ev("U012"));
    expect(r.landed).toBe(true);
    expect(srcOf(calls)).toBe("mike@external");
    expect(srcOf(calls)).not.toContain("U012"); // provenance is the registered ref, not the platform id
  });

  it("UNREGISTERED sender is REFUSED — no qitem created, no dead-letter, LOUD teaching logged", async () => {
    const { router, calls, logs, dead } = makeRouter((u) => ({ admitted: false, teaching: `'${u}' is not a registered human — rig gateway human add …` }));
    const r = await router.route(ev("USTRANGER"));
    expect(r.landed).toBe(false);
    expect(calls.find((a) => a[1] === "create")).toBeUndefined(); // never attempted a create
    expect(dead.readAll()).toHaveLength(0); // a policy refusal is NOT dead-lettered (retry can't help)
    expect(logs.some((l) => /REFUSED.*unregistered.*USTRANGER/.test(l))).toBe(true);
  });
});

describe("A6 v3 makeInboundSenderResolver (registry wiring; real resolveSlackHandle)", () => {
  const mike: HumanFragment = {
    entityId: "mike", class: "human", displayName: "Mike", address: "mike@external",
    connectorBindings: [{ kind: "slack", connectorRef: "slack-main", secretsRef: "vault://slack/mike", role: "primary", handle: "U012" }],
    prefs: { deliveryClass: "B" },
  };
  const mkSurface = (loaded: ReturnType<RegistrySurface["loadHumanRegistry"]>): RegistrySurface => ({ loadHumanRegistry: () => loaded, resolveSlackHandle });

  it("registered handle -> admitted with the entity address", () => {
    const resolve = makeInboundSenderResolver(mkSurface({ ok: true, entities: [mike] }));
    expect(resolve("U012")).toEqual({ admitted: true, source: "mike@external" });
  });

  it("unknown handle -> refused with the resolver's teaching", () => {
    const resolve = makeInboundSenderResolver(mkSurface({ ok: true, entities: [mike] }));
    const r = resolve("UNOPE");
    expect(r.admitted).toBe(false);
    if (!r.admitted) expect(r.teaching).toMatch(/not a registered human/i);
  });

  it("registry LOAD FAILURE -> refused, fail-CLOSED, surfacing reg.error (r1 A4b follow-on)", () => {
    const resolve = makeInboundSenderResolver(mkSurface({ ok: false, error: "projection DRIFTED from the fragments" }));
    const r = resolve("U012");
    expect(r.admitted).toBe(false);
    if (!r.admitted) {
      expect(r.teaching).toMatch(/fail-closed/i);
      expect(r.teaching).toMatch(/projection DRIFTED/); // the distinct broken-registry cause is surfaced
    }
  });
});
