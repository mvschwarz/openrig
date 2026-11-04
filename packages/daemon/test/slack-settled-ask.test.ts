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
  const logs: string[] = [];

  function start() {
    wire = buildSlackGatewayWire({ home, queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, log: (m) => logs.push(m),
      fetchImpl: async (url, init) => {
        const api = new URL(url);
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
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
    messages = []; updates = []; postCount = 0; logs.length = 0;
    start();
  });
  afterEach(() => { wire.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  async function postAsk(detail?: string) {
    const item = await repo.create({ sourceSession: "author@rig", destinationSession: human,
      summary: "Ship the change?", body: "Original **brief** with its evidence.", humanDetail: detail,
      humanQuestions: [{ id: "ship", question: "Ship now?", options: [{ id: "yes", label: "Ship" }, { id: "hold", label: "Hold" }] }], nudge: false });
    const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    expect(alert?.qitemId).toBe(item.qitemId);
    expect(wire.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(repo.currentHumanRequiredEpisode(item.qitemId)?.receipt?.messageTs).toBe("1.000001"));
    expect(messages[0]!.blocks.some((b) => b.type === "actions")).toBe(true);
    expect(messages[0]!.text).toContain("Reply in this thread after this question");
    return item;
  }

  it.each(["done", "canceled"] as const)("edits the original primary after a CLI-style %s transition, preserving its content and marker", async (state) => {
    const item = await postAsk();
    const original = structuredClone(messages[0]!);
    repo.update({ qitemId: item.qitemId, actorSession: "author@rig", state,
      closureReason: "superseded", transitionNote: "Handled in the pane after the merge." });
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
});
