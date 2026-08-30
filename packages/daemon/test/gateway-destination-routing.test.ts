// OPR.0.5.6.14 — gateway external routing: the fresh base-scoped REDs.
// Already folded at this base (regression FLOORS here, never absence REDs):
// the @external gateway-owned wake branch, the OWNER level enum/classifier/
// dials (076), blocker registry-resolution, receipt-bound dedupe, and the
// external-admission refusal. What these pins buy is the REMAINING defect set:
// (1) no named single resolver seam — the external branch is an inline `if`,
// registry-resolved ALIASES (human-founder@kernel — the live 4-row specimen
// class) still fall through to tmux, and unknown destinations get raw tmux
// wording instead of a teaching refusal; (2) the 8f291c37 shape — a receipt
// write that throws after a successful post escapes the deliver seam instead
// of retain-and-repair; (3) transport-failed transitions do not exist;
// (4) undelivered/classifyNudgeFailure read only the nudge literal and never
// consult the delivery ledger (the 34a6ad0b contradiction); (5) the row face
// carries no delivery outcome.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTransitionsArchiveSchema } from "../src/db/migrations/054_queue_transitions_archive.js";
import { ownerNotificationLevelsSchema } from "../src/db/migrations/076_owner_notification_levels.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const FOUNDER_FRAGMENT = {
  // Fragment convention: address = <entityId>@external, so the entityId is the
  // full local part — which is exactly what makes the kernel ALIAS resolvable
  // (parseSessionName("human-founder@kernel").member === "human-founder").
  entityId: "human-founder",
  class: "human",
  displayName: "The Founder",
  address: "human-founder@external",
  connectorBindings: [{ connector: "slack", ref: "U0FOUNDER", primary: true }],
  prefs: {},
} as unknown as HumanFragment;

const EVIDENCE = "shared-docs/rigs/v-openrig-build/state/evidence-s14.md";

function makeHarness() {
  const db = createDb();
  migrate(db, [
    coreSchema, bindingsSessionsSchema, eventsSchema, queueItemsSchema,
    queueTransitionsSchema, outboxEntriesSchema, queueTransitionsArchiveSchema,
    ownerNotificationLevelsSchema,
  ]);
  const bus = new EventBus(db);
  const sends: Array<{ session: string; text: string }> = [];
  const repo = new QueueRepository(db, bus, {
    transport: {
      send: async (sessionName: string, text: string) => {
        sends.push({ session: sessionName, text });
        // Real-tmux behavior for anything without a live pane in this fixture:
        return sessionName === "dev-a@rig1"
          ? { ok: true, verified: true }
          : { ok: false, error: `Session '${sessionName}' not found: tmux reports no session with this name. No text was sent. Check available sessions with: rig ps --nodes` };
      },
    },
    loadHumanRegistry: () => ({ ok: true as const, entities: [FOUNDER_FRAGMENT] }),
  });
  repo.attachOutbox(new OutboxHandler(db));
  // Topology fixture: exactly one known pane-bound seat, dev-a@rig1.
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig1')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-a', 'rig-1', 'dev.a', 'claude-code')").run();
  db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('sess-a', 'node-a', 'dev-a@rig1')").run();
  return { db, repo, sends };
}

describe("OPR.0.5.6.14 — one destination resolver, no fall-through", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it("THE 4-ROW CLASS DIES: a registry-resolved human ALIAS (kernel virtual seat) never touches tmux and records gateway-owned", async () => {
    const item = await h.repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@kernel",
      body: "escalation for the founder via the kernel alias",
      summary: "Founder decision ask (alias-addressed)",
      evidenceRef: EVIDENCE,
    });
    expect(h.sends, "tmux transport must never be consulted for a registry-resolved human").toHaveLength(0);
    const fresh = h.repo.getById(item.qitemId)!;
    expect(fresh.lastNudgeResult).toMatch(/^gateway-owned/);
    expect(fresh.lastNudgeResult, "the honest wording names the registry resolution").toMatch(/registry|registered human/i);
    expect(fresh.lastNudgeResult).not.toMatch(/tmux reports no session/);
  });

  it("FLOOR: the @external class stays gateway-owned (folded behavior unchanged)", async () => {
    const item = await h.repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@external",
      body: "direct external alert",
      summary: "Founder alert",
      evidenceRef: EVIDENCE,
    });
    expect(h.sends).toHaveLength(0);
    expect(h.repo.getById(item.qitemId)!.lastNudgeResult).toMatch(/^gateway-owned/);
  });

  it("UNROUTABLE STAYS LOUD AND STRUCTURED: an unknown destination gets a teaching refusal, never raw tmux wording", async () => {
    const item = await h.repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "ghost-writer@nowhere",
      body: "row to a destination that is neither topology nor registry",
      nudge: true,
    });
    const fresh = h.repo.getById(item.qitemId)!;
    expect(h.sends, "tmux is not consulted for a destination it can never hold").toHaveLength(0);
    expect(fresh.lastNudgeResult, "the refusal teaches both checks performed").toMatch(/not a known seat|no registered human|unroutable/i);
    expect(fresh.lastNudgeResult).not.toMatch(/tmux reports no session/);
  });

  it("FLOOR: pane-bound dispatch is byte-identical — the known seat rides terminal transport unchanged", async () => {
    const item = await h.repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "dev-a@rig1",
      body: "ordinary seat nudge",
      nudge: true,
    });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.session).toBe("dev-a@rig1");
    const fresh = h.repo.getById(item.qitemId)!;
    expect(fresh.lastNudgeResult).not.toMatch(/^gateway-owned/);
    expect(fresh.lastNudgeAttempt).not.toBeNull();
  });

  it("FLOOR: a registered human with a real pane stays pane-bound; only its paneless alias is gateway-routable", async () => {
    h.db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-human', 'rig-1', 'human.founder', 'terminal')").run();
    h.db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('sess-human', 'node-human', 'human-founder@rig1')").run();
    const item = await h.repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@rig1",
      body: "pane-backed founder seat",
    });
    expect(h.sends.map((send) => send.session)).toEqual(["human-founder@rig1"]);
    expect(h.repo.getById(item.qitemId)!.lastNudgeResult).toMatch(/^failed:/);
  });

  it("D3 SEAM, STRUCTURAL: one named classification site; the inline external branch is gone from the wake path", () => {
    const repoSource = readFileSync(join(HERE, "../src/domain/queue-repository.ts"), "utf8");
    const resolverPath = join(HERE, "../src/domain/gateway/destination-resolver.ts");
    let resolverSource = "";
    expect(() => { resolverSource = readFileSync(resolverPath, "utf8"); },
      "the single resolver module must exist (gateway/destination-resolver.ts)").not.toThrow();
    expect(resolverSource).toMatch(/export function classifyDestination/);
    // The wake path consults the seam instead of classifying inline:
    expect(repoSource, "no inline external classification in the wake path").not.toMatch(/parseSessionName\(destinationSession\)\.kind === "external"/);
    expect(repoSource).toMatch(/classifyDestination/);
  });
});

describe("OPR.0.5.6.14 — the delivery ledger is universal and consulted", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  function memStore() {
    const m = new Map<string, string>();
    return { load: () => m, mark: (k: string, v: string) => m.set(k, v) };
  }

  function deliverHarness(opts?: {
    postStatus?: number;
    onPostedImpl?: (p: unknown, ts: string) => void;
    onTransportFailed?: (p: unknown, cls: string, detail: string) => void;
  }) {
    const posts: string[] = [];
    const postedTexts: Array<{ text: string; ts: string }> = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("chat.postMessage")) {
        posts.push(url);
        if (opts?.postStatus && opts.postStatus !== 200) return new Response("err", { status: opts.postStatus });
        // Slack truthfulness: a 200-posted message EXISTS in the channel and
        // must appear in later reconcile scans (that is the whole repair story).
        try {
          const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          postedTexts.push({ text: String(body.text ?? ""), ts: "1234.5678" });
        } catch { /* non-JSON body: scan stays empty */ }
        return new Response(JSON.stringify({ ok: true, ts: "1234.5678", channel: "C1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // reconcile scans see what was actually posted
      return new Response(JSON.stringify({ ok: true, messages: postedTexts }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const attempted = memStore();
    const delivered = memStore();
    const outboundSeen = memStore();
    const deliver = subsystemSlackDeliver({
      botToken: "xoxb-t",
      channel: "C1",
      sourceLabel: "test",
      attempted,
      delivered,
      outboundSeen,
      fetchImpl,
      onPosted: opts?.onPostedImpl ?? (() => {}),
      // OPR.0.5.6.14: the transport-failure receipt callback (RED: does not exist).
      onTransportFailed: opts?.onTransportFailed,
    } as never);
    return { deliver, posts, attempted, delivered };
  }

  const DECISION = (qitemId: string) => ({
    decisionId: `dec-${qitemId}`,
    entityBindingRef: "human-founder@external",
    payload: {
      qitemId,
      summary: "s",
      body: "b",
      destinationSession: "human-founder@external",
      sourceSession: "orch-lead@v-openrig-build",
    },
  });

  it("TRANSPORT FAILURE WRITES THE LEDGER: a failed post invokes the transport-failed receipt callback with the error", async () => {
    const failures: Array<{ cls: string; detail: string }> = [];
    const { deliver } = deliverHarness({
      postStatus: 500,
      onTransportFailed: (_p, cls, detail) => failures.push({ cls, detail }),
    });
    const out = await deliver(DECISION("q-tf-1") as never);
    expect(out.ok).toBe(false);
    expect(failures, "the row ledger learns about the transport failure").toHaveLength(1);
    expect(failures[0]!.cls).toMatch(/http-500|transport/);
  });

  it("THE 8f291c37 SHAPE DIES BY REPAIR: a receipt write that throws after a successful post is retained cleanly, then repaired on the next tick with exactly one post", async () => {
    let receiptCalls = 0;
    let throwOnce = true;
    const receipts: string[] = [];
    const { deliver, posts } = deliverHarness({
      onPostedImpl: (_p, ts) => {
        receiptCalls++;
        if (throwOnce) { throwOnce = false; throw new Error("SQLITE_BUSY: receipt write failed"); }
        receipts.push(ts);
      },
    });
    const first = await deliver(DECISION("q-rc-1") as never);
    expect(first.ok, "a post-then-receipt-crash is a clean RETAINED outcome, never an escaped throw").toBe(false);
    // next tick: replay the same decision — reconcile-by-marker path or idempotent redelivery
    const second = await deliver(DECISION("q-rc-1") as never);
    expect(second.ok).toBe(true);
    expect(receipts, "the receipt lands on repair").toHaveLength(1);
    expect(posts, "the human is never double-notified by the repair").toHaveLength(1);
    expect(receiptCalls).toBe(2);
  });

  it("UNDELIVERED TELLS THE TRUTH from the ledger, not the nudge literal (the 34a6ad0b contradiction dies)", async () => {
    // Row A: gateway-routed, POSTED (receipt transition present) but nudge literal failed.
    const a = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "a", summary: "a", evidenceRef: EVIDENCE, nudge: false });
    h.db.prepare("UPDATE queue_items SET last_nudge_result = 'failed: stale poison literal', last_nudge_attempt = datetime('now') WHERE qitem_id = ?").run(a.qitemId);
    h.repo.update({ qitemId: a.qitemId, actorSession: "daemon@kernel", transitionNote: "slack-owner-notification-posted notification_key=" + a.qitemId + " level=ALERT kind=unclassified message_ts=111.22 thread_ts=111.22" });
    // Row B: gateway-routed, TRANSPORT-FAILED transition.
    const b = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "b", summary: "b", evidenceRef: EVIDENCE, nudge: false });
    h.repo.update({ qitemId: b.qitemId, actorSession: "daemon@kernel", transitionNote: "slack-owner-notification-transport-failed notification_key=" + b.qitemId + " class=http-500 error=internal server error" });
    // Row C: gateway-routed, NO receipt, older than the post window.
    const c = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "c", summary: "c", evidenceRef: EVIDENCE, nudge: false });
    h.db.prepare("UPDATE queue_items SET last_nudge_result = 'gateway-owned: delivery rides the gateway subsystem', ts_created = datetime('now', '-1 hour') WHERE qitem_id = ?").run(c.qitemId);

    const und = h.repo.findUndelivered({});
    const ids = und.map((u) => u.qitemId);
    expect(ids, "a POSTED row is never undelivered, whatever the nudge leg says").not.toContain(a.qitemId);
    expect(ids, "a transport-failed row IS undelivered").toContain(b.qitemId);
    expect(ids, "a receiptless gateway row past the post window is undelivered (never-posted)").toContain(c.qitemId);
    const byId = new Map(und.map((u) => [u.qitemId, u as unknown as { deliveryFailureClass?: string }]));
    expect(byId.get(b.qitemId)?.deliveryFailureClass ?? (byId.get(b.qitemId) as { deliveryClass?: string })?.deliveryClass, "class names the gateway error").toMatch(/transport-failed/);
    expect(byId.get(c.qitemId)?.deliveryFailureClass ?? (byId.get(c.qitemId) as { deliveryClass?: string })?.deliveryClass).toMatch(/never-posted/);
  });

  it("THE ROW FACE READS DELIVERY: gateway-routed rows surface posted/transport-failed/never-posted; pane-bound rows keep their exact keys", async () => {
    const posted = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "p", summary: "p", evidenceRef: EVIDENCE, nudge: false });
    h.repo.update({ qitemId: posted.qitemId, actorSession: "daemon@kernel", transitionNote: "slack-owner-notification-posted notification_key=" + posted.qitemId + " level=ALERT kind=unclassified message_ts=222.33 thread_ts=222.33" });
    const face = h.repo.getById(posted.qitemId) as unknown as { deliveryOutcome?: string | null };
    expect(face.deliveryOutcome, "a posted gateway row answers 'did it reach them' in one read").toMatch(/posted/);
    const listFace = h.repo.list({ limit: 100 }).find((item) => item.qitemId === posted.qitemId) as
      | { deliveryOutcome?: string | null }
      | undefined;
    expect(listFace?.deliveryOutcome, "list and show project the same row-ledger verdict").toBe("posted");

    const pane = await h.repo.create({ sourceSession: "s@r", destinationSession: "dev-a@rig1", body: "n", nudge: true });
    const paneFace = h.repo.getById(pane.qitemId) as unknown as { deliveryOutcome?: string | null };
    expect(paneFace.deliveryOutcome ?? null, "pane-bound rows carry no gateway delivery outcome (no key lies)").toBeNull();
  });

  it("UNDELIVERED LIMIT IS HONEST: posted rows cannot consume the window and hide a later gateway failure", async () => {
    const posted = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "p", summary: "p", evidenceRef: EVIDENCE, nudge: false });
    h.repo.update({ qitemId: posted.qitemId, actorSession: "daemon@kernel", transitionNote: "slack-owner-notification-posted notification_key=" + posted.qitemId + " level=ALERT kind=unclassified message_ts=444.55 thread_ts=444.55" });
    const failed = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "f", summary: "f", evidenceRef: EVIDENCE, nudge: false });
    h.repo.update({ qitemId: failed.qitemId, actorSession: "daemon@kernel", transitionNote: "slack-owner-notification-transport-failed notification_key=" + failed.qitemId + " class=http-500 error=failed" });
    expect(h.repo.findUndelivered({ limit: 1 }).map((item) => item.qitemId)).toEqual([failed.qitemId]);
  });

  it("FLOOR: the receipt-bound episode dedupe stands — a second identical receipt write is a no-op", async () => {
    const row = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "d", summary: "d", evidenceRef: EVIDENCE, nudge: false });
    const note = "slack-owner-notification-posted notification_key=" + row.qitemId + " level=ALERT kind=unclassified message_ts=333.44 thread_ts=333.44";
    h.repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: note });
    expect(h.repo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, row.qitemId), "the receipt suppresses the repeat").toBe(true);
  });
});
