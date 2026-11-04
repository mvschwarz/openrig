// Real queue transitions and gateway; Slack HTTP is an in-memory conversation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";

const human = "person@external";
const registry = { ok: true as const, entities: [{ entityId: "person", class: "human" as const,
  displayName: "Person", address: human, connectorBindings: [{ kind: "slack" as const,
    connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UPERSON" }],
  prefs: { deliveryClass: "A" as const } }] };
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
type Message = { channel: string; ts: string; text: string; blocks: Array<Record<string, unknown>>; thread_ts?: string };

describe("posted asks follow settlement outside Slack", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let wire: ReturnType<typeof buildSlackGatewayWire>;
  let messages: Message[];
  let updates: Array<Record<string, unknown>>;
  let postCount: number;
  let apiHook: ((method: string, body: Record<string, unknown>) => Response | undefined) | undefined;
  let methods: string[];
  const logs: string[] = [];

  function start() {
    wire = buildSlackGatewayWire({ home, queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, log: (m) => logs.push(m),
      fetchImpl: async (url, init) => {
        const api = new URL(url);
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        const method = api.pathname.split("/").at(-1)!;
        methods.push(method);
        const override = apiHook?.(method, body);
        if (override) return override;
        if (api.pathname.endsWith("chat.postMessage")) {
          postCount++;
          const message = { ...body, ts: `${postCount}.000001` } as Message;
          messages.push(message);
          return response({ ok: true, ts: message.ts });
        }
        if (api.pathname.endsWith("chat.update")) {
          updates.push(body);
          const message = messages.find((m) => m.ts === body.ts && m.channel === body.channel)!;
          Object.assign(message, body);
          return response({ ok: true, ts: body.ts, channel: body.channel });
        }
        if (api.pathname.endsWith("conversations.history") || api.pathname.endsWith("conversations.replies")) {
          const ts = api.searchParams.get("latest") ?? api.searchParams.get("oldest") ?? api.searchParams.get("ts");
          return response({ ok: true, messages: messages.filter((m) => m.channel === api.searchParams.get("channel") && (!ts || m.ts === ts)) });
        }
        return response({ ok: true, messages: [] });
      },
    });
    wire.startServices?.();
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "slack-settled-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-ASKS", secretsEnvFile: secrets }, home);
    messages = []; updates = []; postCount = 0; logs.length = 0; methods = []; apiHook = undefined;
    start();
  });
  afterEach(() => { wire.stop(); vi.useRealTimers(); db.close(); rmSync(home, { recursive: true, force: true }); });

  async function postAsk(detail?: string) {
    const before = postCount;
    const item = await repo.create({ sourceSession: "author@rig", destinationSession: human,
      summary: "Ship the change?", body: "Original **brief** with its evidence.", humanDetail: detail,
      humanQuestions: [{ id: "ship", question: "Ship now?", options: [{ id: "yes", label: "Ship" }, { id: "hold", label: "Hold" }] }], nudge: false });
    const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    expect(alert?.qitemId).toBe(item.qitemId);
    expect(wire.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(repo.currentHumanRequiredEpisode(item.qitemId)?.receipt?.messageTs).toBe(`${before + 1}.000001`));
    expect(messages[before]!.blocks.some((b) => b.type === "actions")).toBe(true);
    expect(messages[before]!.text).toContain("Reply in this thread after this question");
    return item;
  }

  it.each(["done", "canceled"] as const)("edits the original primary after a CLI-style %s transition, preserving its content and marker", async (state) => {
    const item = await postAsk();
    const original = structuredClone(messages[0]!);
    const successor = state === "canceled" ? await repo.create({ sourceSession: "author@rig", destinationSession: "worker@rig",
      summary: "Replacement work", body: "The successor owns the remaining work.", nudge: false }) : undefined;
    repo.update({ qitemId: item.qitemId, actorSession: "author@rig", state,
      closureReason: "superseded", ...(successor ? { closureTarget: successor.qitemId } : {}), transitionNote: "Handled in the pane after the merge." });
    const closed = repo.listTransitions(item.qitemId).at(-1)!;
    expect(repo.getById(item.qitemId)?.state).toBe(state);
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    const edited = updates[0]!;
    expect(edited).toMatchObject({ channel: original.channel, ts: original.ts });
    expect(edited.text).toContain(state === "done" ? "Done" : "Canceled");
    expect(edited.text).toContain("superseded");
    expect(edited.text).toContain(closed.ts);
    expect(edited.text).toContain("author@rig");
    expect(edited.text).toContain("Handled in the pane after the merge.");
    expect(edited.text).toContain(original.text.slice(original.text.lastIndexOf("\n") + 1));
    const keptText = original.text.split("\n").filter((line) => !line.startsWith("Or reply in this thread") && !line.startsWith("Reply in this thread after this question")).join("\n");
    expect(String(edited.text).endsWith(keptText)).toBe(true);
    const blocks = edited.blocks as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(blocks)).not.toMatch(/reply in this thread/i);
    for (const block of original.blocks.filter((b) => b.type !== "actions" && b.type !== "context")) expect(blocks).toContainEqual(block);
    expect(postCount).toBe(1);
    wire.stop(); start();
    await new Promise((r) => setTimeout(r, 25));
    expect(updates).toHaveLength(1);
    expect(postCount).toBe(1);
  });

  it("settles only the primary of a multipart ask", async () => {
    const item = await postAsk("Supplemental evidence, unchanged.");
    expect(messages).toHaveLength(2);
    const supplement = structuredClone(messages[1]!);
    repo.update({ qitemId: item.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on" });
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]!.ts).toBe("1.000001");
    expect(messages[1]).toEqual(supplement);
    expect(postCount).toBe(2);
  });

  it("recovers a closure while the wire was stopped from the existing posted receipt and stamp", async () => {
    const item = await postAsk();
    wire.stop();
    repo.update({ qitemId: item.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on" });
    expect(updates).toHaveLength(0);
    start();
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]!.ts).toBe("1.000001");
    expect(postCount).toBe(1);
  });

  it("keeps an unanswered open ask and ordinary progress notes interactive", async () => {
    const item = await postAsk();
    repo.update({ qitemId: item.qitemId, actorSession: "author@rig", transitionNote: "Still waiting for the person's choice." });
    await new Promise((r) => setTimeout(r, 25));
    expect(updates).toHaveLength(0);
    expect(messages[0]!.blocks.some((b) => b.type === "actions")).toBe(true);
    expect(postCount).toBe(1);
  });

  it("edits the original on a typed answer and names the answering person", async () => {
    const item = await postAsk();
    expect(repo.resolveDirectHumanReply({ qitemId: item.qitemId, actorSession: human, decision: "Ship it" })).toBe(true);
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]!.text).toContain("Answered");
    expect(updates[0]!.text).toContain(`by ${human}`);
    expect(postCount).toBe(1);
  });

  it("retains a refused private-channel read without claiming the edit, then recovers on restart", async () => {
    const item = await postAsk();
    apiHook = (method) => method === "conversations.history" ? response({ ok: false, error: "missing_scope" }) : undefined;
    repo.update({ qitemId: item.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on" });
    await vi.waitFor(() => expect(logs.join("\n")).toContain("missing_scope"));
    expect(methods).not.toContain("chat.update");
    expect(repo.listTransitions(item.qitemId).some((t) => t.transitionNote?.startsWith("slack-ask-settled "))).toBe(false);
    expect(wire.status?.()).toMatchObject({ settlement: { pending: 1, lastFailure: expect.stringContaining("not done") } });
    wire.stop(); apiHook = undefined; start();
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(postCount).toBe(1);
  });

  it("honors a chat.update Retry-After, without a success receipt until the retry succeeds", async () => {
    const item = await postAsk();
    wire.stop(); vi.useFakeTimers();
    let limited = true;
    apiHook = (method) => method === "chat.update" && limited
      ? new Response(JSON.stringify({ ok: false, error: "ratelimited" }), { status: 429, headers: { "retry-after": "60" } }) : undefined;
    repo.update({ qitemId: item.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on" });
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(methods.filter((m) => m === "chat.update")).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(repo.listTransitions(item.qitemId).some((t) => t.transitionNote?.startsWith("slack-ask-settled "))).toBe(false);
    wire.stop(); start(); // Retry-After survives the wire, like the posted receipt.
    await vi.advanceTimersByTimeAsync(0);
    expect(methods.filter((m) => m === "chat.update")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(methods.filter((m) => m === "chat.update")).toHaveLength(1);
    limited = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(updates).toHaveLength(1);
    expect(repo.listTransitions(item.qitemId).some((t) => t.transitionNote?.startsWith("slack-ask-settled "))).toBe(true);
    expect(postCount).toBe(1);
  });

  it("replays an edit whose HTTP result was lost without duplicating status or posting anew", async () => {
    const item = await postAsk();
    apiHook = (method, body) => {
      if (method !== "chat.update") return;
      Object.assign(messages[0]!, body); // Slack applied it, but its answer was lost.
      throw new Error("response lost");
    };
    repo.update({ qitemId: item.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on" });
    await vi.waitFor(() => expect(logs.join("\n")).toContain("response lost"));
    expect(repo.listTransitions(item.qitemId).some((t) => t.transitionNote?.startsWith("slack-ask-settled "))).toBe(false);
    wire.stop(); apiHook = undefined; start();
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(messages[0]!.blocks.filter((b) => b.block_id === "or-settled")).toHaveLength(1);
    expect(messages[0]!.text.match(/^Done/gm)).toHaveLength(1);
    expect(postCount).toBe(1);
  });

  it("bounds a closure burst to the recovery call budget and drains the remaining primary later", async () => {
    const items = [await postAsk(), await postAsk(), await postAsk()];
    wire.stop(); vi.useFakeTimers();
    for (const item of items) repo.update({ qitemId: item.qitemId, actorSession: "author@rig", state: "done", closureReason: "no-follow-on" });
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toHaveLength(2);
    expect(methods.filter((m) => m === "conversations.history")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(updates).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(updates).toHaveLength(3);
    expect(new Set(updates.map((m) => m.ts)).size).toBe(3);
    expect(postCount).toBe(3);
  });

  it("unparks an answered gate and keeps its next thread-primary interactive until that park ends", async () => {
    const item = await repo.create({ sourceSession: "author@rig", destinationSession: "worker@rig",
      summary: "Choose the next step", body: "Original work", nudge: false });
    const park = () => repo.update({ qitemId: item.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: human,
      summary: "May I continue?", evidenceRef: "https://example.com/proof", transitionNote: "Need the person's answer." });
    const send = async (ts: string) => {
      const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
      expect(alert?.qitemId).toBe(item.qitemId);
      expect(wire.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(repo.currentHumanRequiredEpisode(item.qitemId)?.receipt?.messageTs).toBe(ts));
    };
    park(); await send("1.000001");
    expect(messages[0]!.text).toContain("Reply in this thread after this question");
    repo.update({ qitemId: item.qitemId, actorSession: "worker@rig", state: "in-progress", transitionNote: "Answered in the pane; continuing." });
    await vi.waitFor(() => expect(updates).toHaveLength(1));
    park(); await send("2.000001");
    expect(messages[1]!.thread_ts).toBe("1.000001");
    expect(messages[1]!.text).toContain("Reply in this thread after this question");
    expect(updates).toHaveLength(1);
    repo.update({ qitemId: item.qitemId, actorSession: "worker@rig", state: "in-progress", transitionNote: "Second answer received." });
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]!.ts).toBe("2.000001");
    expect(methods).toContain("conversations.replies");
    expect(messages[1]!.text).not.toContain("Reply in this thread after this question");
    expect(postCount).toBe(2);
  });
});
