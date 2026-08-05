import { describe, it, expect } from "vitest";
import { wrapPaneEnvelope } from "../src/lib/pane-envelope.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";

// 51-09 increment 3 — the daemon half of the lockstep twin. wrapPaneEnvelope must
// render the SAME always-suffix triple as the CLI's wrapSendBody, BYTE-IDENTICAL
// for the same inputs (the slice-23 parity contract). The literal expected
// strings below are IDENTICAL to packages/cli/test/self-host-triple.test.ts —
// if the two twins ever diverge, one side breaks. RED provenance: at 38512e2d
// wrapPaneEnvelope has no selfHostId param (renders the 2-part From:).

const SENDER = "dev50-driver@v-openrig-build";
const SELF = "mm2-openrig1";

function expectedTriple(sender: string, recipient: string, body: string, self: string): string {
  return [
    `From: ${sender}@${self}`,
    `To: ${recipient}`,
    "---",
    body,
    "---",
    `↩ Reply: rig send ${sender}@${self} "..."`,
  ].join("\n");
}

describe("wrapPaneEnvelope — always-suffix triple (CLI twin, byte-identical)", () => {
  it("renders the triple in From: and the reply hint (byte-identical to the CLI twin's expected literal)", () => {
    const out = wrapPaneEnvelope(SENDER, "peer@rig", "hi", SELF);
    expect(out).toBe(expectedTriple(SENDER, "peer@rig", "hi", SELF));
  });

  it("C1 fail-open: no selfHostId → today's exact two-part form (3-arg legacy call unchanged)", () => {
    const withId = wrapPaneEnvelope(SENDER, "peer@rig", "hi", undefined);
    const legacy3arg = wrapPaneEnvelope(SENDER, "peer@rig", "hi");
    expect(withId).toBe(legacy3arg);
    expect(withId).toContain(`From: ${SENDER}\n`);
    expect(withId).not.toContain(`@${SELF}`);
  });

  it("discriminating pair: same selfId → identical; different selfId → differ ONLY at the host token", () => {
    const a = wrapPaneEnvelope(SENDER, "peer@rig", "hi", "host-aaaa");
    const b = wrapPaneEnvelope(SENDER, "peer@rig", "hi", "host-bbbb");
    expect(a.split("host-aaaa").join("host-bbbb")).toBe(b);
  });
});

describe("/healthz — additive self-host id (FR-7 stamp precedent, arch ruling 2e1b737f)", () => {
  it("ABSENT before boot reconcile (legacy body byte-preserved), PRESENT after; never ownName", async () => {
    setSelfHostId(null); // pre-reconcile: getSelfHostId() → null
    const db = createFullTestDb();
    try {
      const { app } = createTestApp(db);
      const before = (await (await app.request("/healthz")).json()) as Record<string, unknown>;
      expect(before.status).toBe("ok");
      expect(before).not.toHaveProperty("selfHostId"); // absent before reconcile — no invented identity
      setSelfHostId(SELF); // boot reconcile stamps the durable self-id
      const after = (await (await app.request("/healthz")).json()) as Record<string, unknown>;
      expect(after.selfHostId).toBe(SELF); // additive field present after reconcile
      expect(after.status).toBe("ok"); // legacy body preserved (ONE identity source for the CLI edge)
    } finally {
      setSelfHostId(null); // reset the module-global for isolation
      db.close();
    }
  });
});
