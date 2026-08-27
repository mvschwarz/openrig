// S10 FIX ROUND 1 (R2 B1) — the mention-injection posted-byte discriminator, driven through the
// REAL subsystemSlackDeliver seam. Contract (mini-req 4): "escalations mention, all else
// quiet-threaded" is a POSTED-BYTE property of untrusted content, not just of what the renderer
// adds. Queue-controlled fields must be structurally inert in Slack's parser (the documented
// three-character neutralization — &, <, > — under which EVERY control form <@U…>, <!here>,
// <!channel>, <!subteam^…> requires a literal "<" and therefore cannot survive), while the one
// deliberate escalation mention is composed by the renderer AFTER neutralization.
//
// RED at pre-fix bytes: the negative fails (all four forms ride into text + mrkdwn active) and
// the positive fails (quoted forms in the body stay active beside the deliberate mention).
import { describe, it, expect } from "vitest";
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
const clock = () => new Date("2026-08-27T02:00:00.000Z");

/** The four active control forms the row names. An ACTIVE form is the literal sequence with a
 *  real "<" — an escaped occurrence ("&lt;@U012AB3CD&gt;") is inert and must NOT match. */
const ACTIVE_FORMS = ["<@U012AB3CD>", "<!here>", "<!channel>", "<!subteam^S012AB3CD>"];
const INJECTED = `mentioning <@U012AB3CD> then <!here> then <!channel> then <!subteam^S012AB3CD> end`;

function capture(): { fetchImpl: FetchImpl; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, ts: "2.2" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

function makeDeliver(fetchImpl: FetchImpl, mention?: string) {
  const fsx = memFs();
  return subsystemSlackDeliver({
    botToken: "xoxb-EXAMPLE-fake",
    channel: "C1",
    sourceLabel: "vm",
    fetchImpl,
    delivered: new SeenStore("/del.jsonl", fsx, clock),
    attempted: new SeenStore("/att.jsonl", fsx, clock),
    outboundSeen: new SeenStore("/seen.jsonl", fsx, clock),
    resolveMentionUserId: () => mention,
  });
}

const decision = (payload: Record<string, unknown>, id = "d-inj"): OutboundDecision => ({
  kind: "outbound_decision", decisionId: id, op: "post_message", entityBindingRef: "mike#slack", payload,
});

/** Every posted-byte surface: top-level text plus every string anywhere in blocks. */
function allSurfaces(body: Record<string, unknown>): string {
  return `${String(body.text ?? "")}\n${JSON.stringify(body.blocks ?? [])}`;
}
function activeCount(surfaces: string, form: string): number {
  return surfaces.split(form).length - 1;
}

describe("R2 B1 — queue-controlled content must be structurally INERT in posted bytes", () => {
  it("NEGATIVE: a ROUTINE row carrying all four control forms in summary+body emits ZERO active control syntax on any posted surface — and the content stays honestly visible, not dropped", async () => {
    const { fetchImpl, bodies } = capture();
    const out = await makeDeliver(fetchImpl /* routine: no mention resolved */)(decision({
      qitemId: "q-inj-neg",
      summary: `routine ${INJECTED}`,
      body: `please check ${INJECTED}`,
      destinationSession: "human-founder@kernel",
      sourceSession: "dev-driver@v-openrig-build",
      tier: "routine",
    }));
    expect(out.ok).toBe(true);
    const surfaces = allSurfaces(bodies[0]!);
    for (const form of ACTIVE_FORMS) {
      expect(activeCount(surfaces, form), `active form ${form} must not survive into posted bytes`).toBe(0);
    }
    // Honest representation: the quoted content is still READABLE (escaped, never silently dropped).
    expect(surfaces).toContain("&lt;@U012AB3CD&gt;");
    expect(surfaces).toContain("&lt;!channel&gt;");
    expect(surfaces).toContain("&lt;!here&gt;");
    expect(surfaces).toContain("&lt;!subteam^S012AB3CD&gt;");
  });

  it("POSITIVE: a true ESCALATION emits EXACTLY ONE deliberately composed mention while the same four quoted forms stay inert", async () => {
    const { fetchImpl, bodies } = capture();
    const out = await makeDeliver(fetchImpl, "U012AB3CD" /* the registry-resolved escalation mention */)(decision({
      qitemId: "q-inj-pos",
      summary: `URGENT ${INJECTED}`,
      body: `decide now ${INJECTED}`,
      destinationSession: "mike@external",
      sourceSession: "dev-driver@v-openrig-build",
      tier: "human-gate",
    }, "d-inj-pos"));
    expect(out.ok).toBe(true);
    const surfaces = allSurfaces(bodies[0]!);
    // Exactly ONE active user mention — the renderer's own, composed after neutralization.
    expect(activeCount(surfaces, "<@U012AB3CD>"), "exactly one deliberate mention").toBe(2);
    // NOTE ON THE COUNT: the deliberate mention appears in BOTH notification-fallback text and
    // the summary section block (one logical mention, two posted surfaces of the same message).
    // The quoted copies in summary+body would add 4+ more per surface — the bound proves those
    // are gone. Group/channel controls must never be renderer-composed at all:
    expect(activeCount(surfaces, "<!here>")).toBe(0);
    expect(activeCount(surfaces, "<!channel>")).toBe(0);
    expect(activeCount(surfaces, "<!subteam^S012AB3CD>")).toBe(0);
    // and the quoted user-mention text is still honestly visible in escaped form:
    expect(surfaces).toContain("&lt;@U012AB3CD&gt;");
  });

  it("SANITY: ordinary formatting in queue content survives (no over-neutralization of plain text)", async () => {
    const { fetchImpl, bodies } = capture();
    await makeDeliver(fetchImpl)(decision({
      qitemId: "q-inj-plain",
      summary: "plain *bold* _italic_ summary",
      body: "a normal body with a URL https://example.invalid/x and 5 > 3 comparisons",
      destinationSession: "human-founder@kernel",
      sourceSession: "dev-driver@v-openrig-build",
    }, "d-inj-plain"));
    const surfaces = allSurfaces(bodies[0]!);
    expect(surfaces).toContain("*bold*"); // mrkdwn styling is not control syntax; it survives
    expect(surfaces).toContain("https://example.invalid/x");
    expect(surfaces).toContain("5 &gt; 3"); // the comparison renders as ">" in Slack — visible, inert
  });
});
