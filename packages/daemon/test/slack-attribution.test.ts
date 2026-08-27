// S10 — identity policy receipts (A1.2): the structured attribution header (rig/host/seat/
// session) rides every outbound post in ONE honest bot identity; ZERO per-message
// username/icon overrides (customize ABSENCE pinned at the posted-bytes level); the interim
// loudness rule mentions ONLY escalations.
import { describe, it, expect } from "vitest";
import { buildOutboundMessage, attributionFromSession } from "../src/domain/gateway/slack/message.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

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
const clock = () => new Date("2026-08-27T00:00:00.000Z");

describe("attributionFromSession — the stamped triple parses into the four fields", () => {
  it("three-part triple: seat, rig, host, session", () => {
    expect(attributionFromSession("dev-driver@v-openrig-build@host-84c37990")).toEqual({
      seat: "dev-driver@v-openrig-build",
      rig: "v-openrig-build",
      host: "host-84c37990",
      session: "dev-driver@v-openrig-build@host-84c37990",
    });
  });
  it("two-part ref: seat + rig, no host", () => {
    expect(attributionFromSession("dev-driver@v-openrig-build")).toMatchObject({ seat: "dev-driver@v-openrig-build", rig: "v-openrig-build" });
  });
  it("bare/absent degrade honestly", () => {
    expect(attributionFromSession("daemon")).toMatchObject({ seat: "daemon", session: "daemon" });
    expect(attributionFromSession(null)).toBeUndefined();
  });
});

describe("buildOutboundMessage — attribution header + loudness rule", () => {
  const q = { qitemId: "q1", summary: "Decide X", body: "b", destinationSession: "mike@external" };

  it("the attribution header is the LEADING context block and carries all four fields", () => {
    const m = buildOutboundMessage(q, {
      sourceLabel: "vm",
      attribution: { seat: "dev-driver@v-openrig-build", rig: "v-openrig-build", host: "host-84c37990", session: "dev-driver@v-openrig-build@host-84c37990" },
    });
    const first = m.blocks[0] as { type: string; elements: { text: string }[] };
    expect(first.type).toBe("context");
    const line = first.elements[0]!.text;
    expect(line).toContain("dev-driver@v-openrig-build");
    expect(line).toContain("rig v-openrig-build");
    expect(line).toContain("host host-84c37990");
    expect(line).toContain("session dev-driver@v-openrig-build@host-84c37990");
    expect(m.text).toContain("from *dev-driver@v-openrig-build*"); // notification fallback carries it too
  });

  it("ESCALATION mentions the human by USER ID; routine stays quiet", () => {
    const loud = buildOutboundMessage(q, { sourceLabel: "vm", mentionUserId: "U012AB3CD" });
    expect(loud.text.startsWith("<@U012AB3CD> ")).toBe(true);
    const quiet = buildOutboundMessage(q, { sourceLabel: "vm" });
    expect(quiet.text).not.toContain("<@");
  });
});

describe("customize ABSENCE — posted bytes carry the app identity ONLY", () => {
  function capture(): { fetchImpl: FetchImpl; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    return {
      bodies,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, ts: "1.1" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
  }
  const decision = (payload: Record<string, unknown>): OutboundDecision => ({
    kind: "outbound_decision", decisionId: "d1", op: "post_message", entityBindingRef: "mike#slack", payload,
  });

  it("a full delivery (escalation, attribution, image) posts ZERO username/icon_url/icon_emoji keys", async () => {
    const fsx = memFs();
    const { fetchImpl, bodies } = capture();
    const deliver = subsystemSlackDeliver({
      botToken: "xoxb-EXAMPLE-fake",
      channel: "C1",
      sourceLabel: "vm",
      fetchImpl,
      delivered: new SeenStore("/del.jsonl", fsx, clock),
      attempted: new SeenStore("/att.jsonl", fsx, clock),
      outboundSeen: new SeenStore("/seen.jsonl", fsx, clock),
      resolveMentionUserId: () => "U012AB3CD", // even at maximum loudness…
    });
    const out = await deliver(decision({
      qitemId: "q-esc",
      summary: "URGENT decide",
      body: "please",
      destinationSession: "mike@external",
      sourceSession: "dev-driver@v-openrig-build@host-84c37990",
      evidenceRef: "https://example.invalid/x.png",
      tier: "human-gate",
    }));
    expect(out.ok).toBe(true);
    const body = bodies[0]!;
    // …the identity stays the app's own: the customize keys are structurally absent.
    expect(Object.keys(body)).not.toContain("username");
    expect(Object.keys(body)).not.toContain("icon_url");
    expect(Object.keys(body)).not.toContain("icon_emoji");
    expect(JSON.stringify(body)).not.toMatch(/"username"|"icon_url"|"icon_emoji"/);
    // and the attribution + mention arrived as CONTENT, not identity
    expect(String(body.text)).toContain("<@U012AB3CD>");
    expect(JSON.stringify(body.blocks)).toContain("dev-driver@v-openrig-build");
  });
});
