import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DispatchBuffer, dispatchBufferPath } from "../src/domain/gateway/dispatch-buffer.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";

// M1 A4a — the durable dispatch buffer (proof-9 no-loss/ack-gated-drain mechanism).

const dec = (id: string): OutboundDecision => ({
  kind: "outbound_decision", decisionId: id, op: "post_message", entityBindingRef: "mike#slack-1", payload: { text: id },
});

describe("A4a DispatchBuffer (durable, ack-gated drain)", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "a4a-buf-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("enqueue persists a decision (durable-first) + pending() reads it back across a fresh instance (restart-survival)", () => {
    new DispatchBuffer(home).enqueue(dec("d1"));
    expect(existsSync(dispatchBufferPath(home))).toBe(true);
    // a FRESH instance (simulates restart) sees the pending decision
    expect(new DispatchBuffer(home).pending().map((d) => d.decisionId)).toEqual(["d1"]);
  });

  it("ack DRAINS a decision (and only that one); no ack -> stays (connector outage = no loss)", () => {
    const b = new DispatchBuffer(home);
    b.enqueue(dec("d1")); b.enqueue(dec("d2"));
    b.ack("d1");
    expect(b.pending().map((d) => d.decisionId)).toEqual(["d2"]); // d2 un-Acked -> retained
  });

  it("enqueue is IDEMPOTENT on decisionId (a re-dispatch keeps ONE record — byte-identical dup, not two)", () => {
    const b = new DispatchBuffer(home);
    b.enqueue(dec("d1")); b.enqueue(dec("d1"));
    expect(b.pending()).toHaveLength(1);
  });

  it("ack of an unknown decisionId is a no-op (idempotent drain)", () => {
    const b = new DispatchBuffer(home);
    b.enqueue(dec("d1"));
    b.ack("nope");
    expect(b.pending().map((d) => d.decisionId)).toEqual(["d1"]);
  });

  it("A5b: a MEDIA-bearing decision retains + replays byte-identical (media survives like text — no-loss)", () => {
    // The buffer is payload-agnostic: an image attachment on the decision is retained + replayed
    // exactly like text (proof-4's screenshot must not be lost on a failed delivery).
    const media: OutboundDecision = {
      kind: "outbound_decision", decisionId: "m1", op: "post_message", entityBindingRef: "mike#slack-1",
      payload: { qitemId: "q9", summary: "chart", body: "see attached", media: [{ imageUrl: "https://ok.example.com/shot.png", altText: "the screenshot" }] },
    };
    new DispatchBuffer(home).enqueue(media);
    // restart-surviving read: the media payload comes back byte-identical (retained for replay).
    const pending = new DispatchBuffer(home).pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(media); // full payload incl. media — nothing dropped or special-cased
  });
});
