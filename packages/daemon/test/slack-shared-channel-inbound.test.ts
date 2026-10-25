// Test-only: the real inbound router, sender admission, queue ports, reply resolver and write contract over migrated
// SQLite, with a real gateway home (person fragments plus the participant file). Slack itself isn't involved.
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { InboundRouter } from "../src/domain/gateway/slack/inbound.js";
import { makeInboundSenderResolver } from "../src/domain/gateway/slack/inbound-admission.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import { addHumanFragment, loadHumanRegistry, projectionPath, resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { participantsPath, setGroup, setOrganization, setSharedChannel, sharedChannelAddresses } from "../src/domain/gateway/participants.js";

// A vetted shared channel is one participant. A customer who isn't registered can write in it: their message reaches the
// support seat as the channel's, with who actually wrote, the channel's organization, groups and policy, and the
// thread. It's correspondence by construction: it never answers, closes or resumes anyone's ask.

const SUPPORT = "support@test-rig", ANA = "ana@external", CHANNEL = "acme-customers@external";
const closes: Array<() => void> = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

async function fixture({ person = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "shared-channel-"));
  if (person) expect(addHumanFragment({ entityId: "ana", class: "human", displayName: "Ana", address: ANA,
    connectorBindings: [{ kind: "slack", connectorRef: "primary", secretsRef: "vault://slack/ana", role: "primary", handle: "UANA" }],
    prefs: { deliveryClass: "B" } }, home)).toMatchObject({ ok: true });
  expect(setOrganization("acme", { name: "Acme", policy: "Be courteous. Never promise a delivery date." }, home).ok).toBe(true);
  expect(setGroup("support", { organization: "acme", name: "Support", policy: "Billing questions go to Ana." }, home).ok).toBe(true);
  expect(setSharedChannel("acme-customers", { displayName: "Acme customers", organization: "acme", groups: ["support"], policy: "Customers of Acme.",
    channel: { connector: "slack", connectorRef: "primary", secretsRef: "vault://slack/bot", channelId: "CACME" } }, {}, home).ok).toBe(true);

  const db = new Database(join(home, "queue.sqlite")); migrate(db, ALL_MIGRATIONS); const bus = new EventBus(db);
  const registry = () => loadHumanRegistry(home);
  const repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: registry, sharedChannels: () => sharedChannelAddresses(home),
    transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
  const contract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: new MissionControlActionLog(db) });
  let correlation: string | undefined;
  const resolveHumanReply = vi.fn(makeHumanReplyResolver(repo, contract));
  const recordHumanAnswer = vi.fn((input: Parameters<QueueRepository["recordHumanAnswer"]>[0]) => repo.recordHumanAnswer(input));
  const router = new InboundRouter({ queue: makeQueuePorts(repo), destination: "orchestrator@test-rig", seen: new SeenStore(join(home, "seen.jsonl")),
    deadLetter: new DeadLetterStore(join(home, "dead.jsonl")),
    resolveSender: makeInboundSenderResolver({ loadHumanRegistry, resolveSlackHandle }, home),
    resolveRoute: (ev) => ({ destination: SUPPORT, tags: ["founder-slack", "inbound"], ...((ev as { thread_ts?: string }).thread_ts && correlation ? { correlationQitemId: correlation } : {}) }),
    acknowledgeAnswer: async () => {}, recordHumanAnswer, resolveHumanReply });
  closes.push(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const message = (user: string, channel: string, ts: string, text: string, threadTs?: string) =>
    router.route({ type: "message", user, channel, ts, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
  const rows = () => repo.list({ limit: 100 }).filter((row) => row.destinationSession === SUPPORT);
  const alerts = () => makeQueuePorts(repo, { loadHumanRegistry: registry, sharedChannels: () => sharedChannelAddresses(home) }).listHumanAlerts({});
  return { home, repo, router, message, rows, alerts, resolveHumanReply, recordHumanAnswer, correlate: (id: string) => { correlation = id; } };
}

describe("an unregistered sender in a registered shared channel", () => {
  it("reaches the support seat as the channel, with who wrote, the organization, groups, policy and the thread", async () => {
    const f = await fixture();
    expect(await f.message("UCUSTOMER", "CACME", "1.1", "Where is my invoice?")).toMatchObject({ disposition: "accepted" });
    const [row] = f.rows();
    expect(row).toMatchObject({ sourceSession: CHANNEL, destinationSession: SUPPORT });
    expect(row!.tags).toEqual(expect.arrayContaining(["participant:acme-customers", "shared-channel", "slack-sender:UCUSTOMER"]));
    expect(row!.body).toContain("Where is my invoice?");
    expect(row!.body).toContain("Shared channel: Acme customers (acme-customers@external), organization Acme, groups Support");
    expect(row!.body).toContain("Sent by: Slack user <@UCUSTOMER> (not a registered person)");
    expect(row!.body).toContain("organization acme (Acme): Be courteous. Never promise a delivery date.");
    expect(row!.body).toContain("group support (Support): Billing questions go to Ana.");
    expect(row!.body).toContain("participant: Customers of Acme.");
  });

  it("is still refused anywhere else, and in the shared channel once the participant file can't be read", async () => {
    const f = await fixture();
    expect(await f.message("UCUSTOMER", "COTHER", "1.1", "hello")).toMatchObject({ disposition: "refused", reason: "unregistered" });
    writeFileSync(participantsPath(f.home), "version: 1\norganizations: [broken]\n");
    expect(await f.message("UCUSTOMER", "CACME", "1.2", "hello")).toMatchObject({ disposition: "refused", reason: "unregistered" });
    // People are admitted from their own fragments, whatever the participant file says.
    expect(await f.message("UANA", "CACME", "1.3", "I'm here")).toMatchObject({ disposition: "accepted" });
    expect(f.rows().map((row) => row.sourceSession)).toEqual([ANA]);
  });
});

describe("an empty person registry isn't a broken one: a channel-only setup converses", () => {
  it("still admits the channel's customers; anyone else is still told to register a person", async () => {
    const f = await fixture({ person: false });
    expect(await f.message("UCUSTOMER", "CACME", "1.1", "Where is my invoice?")).toMatchObject({ disposition: "accepted" });
    expect(f.rows().map((row) => row.sourceSession)).toEqual([CHANNEL]);
    expect(await f.message("UCUSTOMER", "COTHER", "1.2", "hello")).toMatchObject({ disposition: "refused", reason: "unregistered" });
  });

  it("still posts an update to the channel: it's a notice selected for delivery", async () => {
    const f = await fixture({ person: false });
    const notice = await f.repo.create({ sourceSession: SUPPORT, destinationSession: CHANNEL, humanIntent: "update",
      summary: "Maintenance tonight", body: "Billing is offline 22:00-23:00.", nudge: false });
    expect(f.repo.listTransitions(notice.qitemId).at(-1)).toMatchObject({ ownerNotificationKind: "human-update", ownerNotificationLevel: "NOTICE" });
    expect((await f.alerts()).map((item) => item.qitemId)).toEqual([notice.qitemId]);
  });

  it("a broken person registry still refuses everyone, the shared channel included (fail-closed)", async () => {
    const f = await fixture();
    writeFileSync(projectionPath(f.home), `${readFileSync(projectionPath(f.home), "utf8")}# hand edit\n`);
    expect(await f.message("UCUSTOMER", "CACME", "1.1", "hello")).toMatchObject({ disposition: "refused" });
    expect(f.rows()).toEqual([]);
  });
});

describe("a registered person writing in a shared channel", () => {
  it("stays themselves, and the row says which shared channel it came from", async () => {
    const f = await fixture();
    await f.message("UANA", "CACME", "1.1", "Looking into it.");
    const [row] = f.rows();
    expect(row!.sourceSession).toBe(ANA);
    expect(row!.tags).toEqual(expect.arrayContaining(["participant:acme-customers", "shared-channel"]));
    expect(row!.body).toContain("Shared channel: Acme customers (acme-customers@external)");
    expect(row!.body).not.toContain("not a registered person");
  });
});

describe("a shared channel's message never settles anyone's ask", () => {
  it("a customer's reply in the thread of Ana's pending ask lands as correspondence; the ask stays Ana's to answer", async () => {
    const f = await fixture();
    const ask = await f.repo.create({ sourceSession: "requester@test-rig", destinationSession: ANA, body: "Refund?", summary: "Refund?",
      humanIntent: "decision", humanQuestions: [{ id: "choice", question: "Refund?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }],
      evidenceRef: "/fixture/refund", nudge: false });
    f.correlate(ask.qitemId);
    await f.message("UCUSTOMER", "CACME", "2.2", "Yes please refund me", "1.1");
    expect(f.repo.getById(ask.qitemId)).toMatchObject({ state: "pending" });
    expect(f.repo.getById(ask.qitemId)?.humanAnswers ?? null).toBeNull();
    expect(f.resolveHumanReply).not.toHaveBeenCalled();
    const reply = f.rows().find((row) => row.replyTo === ask.qitemId);
    expect(reply).toMatchObject({ sourceSession: CHANNEL });
    expect(reply!.tags).not.toContain("human-answer");
  });

  it("even an ask addressed to the channel itself isn't answered or closed by a customer's reply: it's read, not settled", async () => {
    const f = await fixture();
    const ask = await f.repo.create({ sourceSession: SUPPORT, destinationSession: CHANNEL, body: "Which plan are you on?", summary: "Which plan?",
      humanIntent: "decision", humanQuestions: [{ id: "plan", question: "Which plan?", options: [{ id: "basic", label: "Basic" }, { id: "pro", label: "Pro" }] }],
      evidenceRef: "/fixture/plan", nudge: false });
    f.correlate(ask.qitemId);
    await f.message("UCUSTOMER", "CACME", "4.4", "Pro", "1.1");
    expect(f.repo.getById(ask.qitemId)).toMatchObject({ state: "pending" });
    expect(f.repo.getById(ask.qitemId)?.humanAnswers ?? null).toBeNull();
    expect(f.resolveHumanReply).not.toHaveBeenCalled();
    expect(f.rows().find((row) => row.replyTo === ask.qitemId)?.tags).not.toContain("human-answer");
  });

  it("a customer's button click records nothing", async () => {
    const f = await fixture();
    const ask = await f.repo.create({ sourceSession: "requester@test-rig", destinationSession: ANA, body: "Refund?", summary: "Refund?",
      humanIntent: "decision", humanQuestions: [{ id: "choice", question: "Refund?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }],
      evidenceRef: "/fixture/refund", nudge: false });
    f.correlate(ask.qitemId);
    const result = await f.router.routeAction({ type: "block_actions", user: { id: "UCUSTOMER" }, channel: { id: "CACME" },
      container: { type: "message", message_ts: "1.1", channel_id: "CACME" }, message: { ts: "1.1" },
      actions: [{ type: "button", block_id: "or-q:choice", action_id: "or-opt:yes", value: "yes", action_ts: "3.3" }] });
    expect(result.status).not.toBe("accepted");
    expect(f.recordHumanAnswer).not.toHaveBeenCalled();
    expect(f.repo.getById(ask.qitemId)).toMatchObject({ state: "pending" });
  });
});
