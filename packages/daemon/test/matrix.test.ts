import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MatrixClient, MatrixApiError, MatrixTokenError, type FetchImpl, type MatrixEvent } from "../src/domain/gateway/matrix/matrix-api.js";
import { MatrixOutboundDriver, splitMessage, MESSAGE_CHUNK_BYTES } from "../src/domain/gateway/matrix/outbound-driver.js";
import { MatrixInbound } from "../src/domain/gateway/matrix/inbound.js";
import { ThreadSeatMap } from "../src/domain/gateway/matrix/thread-seat-map.js";
import { renderQuestion, reactionAnswer, OPTION_EMOJI } from "../src/domain/gateway/matrix/reactions.js";
import { routeMessage } from "../src/domain/gateway/matrix/thread-routing.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig, parseMatrixBinding } from "../src/domain/gateway/matrix/config.js";
import { resolveAccessToken, saveAccessToken } from "../src/domain/gateway/matrix/secrets.js";
import { JsonStore } from "../src/domain/gateway/matrix/state-store.js";
import { parseBindingSpec, validateHumanFragment } from "../src/domain/gateway/human-registry.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";

let home: string;
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "matrix-test-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); vi.useRealTimers(); });
const room = "!room:example.org", human = "alice@external", sender = "@alice:example.org", bot = "@bot:example.org";
const question = { id: "choice", question: "Which colour?", options: [{ id: "red", label: "Red" }, { id: "blue", label: "Blue", recommended: true }] };
const response = (json: unknown, status = 200) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
function api(fetchImpl: FetchImpl, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>) {
  return new MatrixClient({ homeserverUrl: "https://matrix.example.org", accessToken: "test-secret", deviceId: "DEVICE" }, { fetchImpl, sleep });
}
function decision(payload: unknown, decisionId = "decision-1"): OutboundDecision {
  return { kind: "outbound_decision", decisionId, op: "post_message", entityBindingRef: human, payload };
}
const message = (id: string, body = "Hello", user = sender, root?: string): MatrixEvent => ({
  type: "m.room.message", event_id: id, sender: user,
  content: { msgtype: "m.text", body, ...(root ? { "m.relates_to": { rel_type: "m.thread", event_id: root } } : {}) },
});
const reaction = (id = "$reaction", key = "2️⃣", target = "$question", user = sender): MatrixEvent => ({
  type: "m.reaction", event_id: id, sender: user, content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } },
});
function seedSync(since = "page-0") { new JsonStore(path.join(home, "state", "matrix-sync.json"), {}).write({ since, seen: [] }); }
function inbound(client: MatrixClient, extra: Partial<ConstructorParameters<typeof MatrixInbound>[0]> = {}) {
  return new MatrixInbound({ home, client, map: new ThreadSeatMap(home), destination: "operator-agent@kernel",
    queue: { createQitem: vi.fn().mockResolvedValue("qitem-1") }, resolveSender: (user, target) => user === sender && target === room ? human : null, ...extra });
}

describe("Matrix v3 client (hermetic fetch)", () => {
  it("sends plain and HTML messages with m.thread + reply fallback", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => response({ event_id: "$sent" }));
    const client = api(fetchImpl);
    await client.sendMessage(room, "Hello", { transactionId: "txn" });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://matrix.example.org/_matrix/client/v3/rooms/!room%3Aexample.org/send/m.room.message/txn");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ msgtype: "m.text", body: "Hello" });
    await client.sendMessage(room, "Reply", { formattedBody: "<b>Reply</b>", threadRootEventId: "$root" });
    const init = fetchImpl.mock.calls[1][1];
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe("Bearer test-secret");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toMatchObject({ format: "org.matrix.custom.html", formatted_body: "<b>Reply</b>",
      "m.relates_to": { rel_type: "m.thread", event_id: "$root", is_falling_back: true, "m.in_reply_to": { event_id: "$root" } } });
  });
  it("uses retry_after_ms and the same transaction for rate-limited sends", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ errcode: "M_LIMIT_EXCEEDED", error: "wait", retry_after_ms: 17 }, 429))
      .mockResolvedValueOnce(response({ event_id: "$sent" }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await api(fetchImpl, sleep).sendMessage(room, "Hello");
    expect(sleep).toHaveBeenCalledWith(17, undefined);
    expect(fetchImpl.mock.calls[0][0]).toBe(fetchImpl.mock.calls[1][0]);
    expect(fetchImpl.mock.calls[0][1].body).toBe(fetchImpl.mock.calls[1][1].body);
  });
  it("bounds repeated rate limits and surfaces Matrix errors", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => response({ errcode: "M_LIMIT_EXCEEDED", error: "wait", retry_after_ms: 1 }, 429));
    await expect(api(fetchImpl, async () => {}).whoami()).rejects.toBeInstanceOf(MatrixApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await expect(api(async () => response({ errcode: "M_FORBIDDEN", error: "denied test-secret" }, 403)).joinRoom(room)).rejects.toThrow("denied [redacted]");
  });
  it("reports invalid/expired tokens with a typed actionable error", async () => {
    const client = api(async () => response({ errcode: "M_UNKNOWN_TOKEN", error: "invalid" }, 401));
    await expect(client.whoami()).rejects.toBeInstanceOf(MatrixTokenError);
    await expect(client.whoami()).rejects.toThrow("rig matrix setup");
  });
  it("implements whoami, join, joined rooms, state and sync query encoding", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/sync?")) return response({ next_batch: "next" });
      if (url.endsWith("/account/whoami")) return response({ user_id: bot });
      if (url.endsWith("/joined_rooms")) return response({ joined_rooms: [room] });
      if (url.endsWith("/state")) return response([]);
      if (url.includes("/send/")) return response({ event_id: "$sent" });
      return response({ room_id: room });
    });
    const client = api(fetchImpl);
    expect(await client.whoami()).toEqual({ user_id: bot });
    expect(await client.joinRoom("#room:example.org")).toEqual({ room_id: room });
    expect(await client.getJoinedRooms()).toEqual({ joined_rooms: [room] });
    expect(await client.getRoomState(room)).toEqual([]);
    await client.sync({ since: "token&more", timeoutMs: 30000 });
    expect(fetchImpl.mock.calls.at(-1)![0]).toContain("/sync?timeout=30000&since=token%26more");
    await client.sendReaction(room, "$event", "1️⃣");
    expect(JSON.parse(fetchImpl.mock.calls.at(-1)![1].body)).toEqual({ "m.relates_to": { rel_type: "m.annotation", event_id: "$event", key: "1️⃣" } });
  });
  it("rejects malformed endpoint responses before they can enter connector state", async () => {
    const client = api(async () => response({}));
    await expect(client.sendMessage(room, "hello")).rejects.toThrow("missing event_id");
    await expect(client.whoami()).rejects.toThrow("missing user_id");
    await expect(client.joinRoom(room)).rejects.toThrow("missing room_id");
    await expect(client.getJoinedRooms()).rejects.toThrow("response is invalid");
    await expect(client.getRoomState(room)).rejects.toThrow("response is invalid");
    await expect(client.sync({ timeoutMs: 0 })).rejects.toThrow("missing next_batch");
    await expect(client.messages(room, { from: "a", to: "b" })).rejects.toThrow("response is invalid");
    await expect(api(async () => new Response("not JSON")).whoami()).rejects.toThrow("non-JSON response");
  });
  it("does not send when already aborted and interrupts rate-limit sleep on stop", async () => {
    const fetchImpl = vi.fn(async () => response({ errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 30000 }, 429));
    const client = api(fetchImpl);
    await expect(client.sendMessage(room, "hello", { signal: AbortSignal.abort(new Error("stopped")) })).rejects.toThrow("stopped");
    expect(fetchImpl).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = client.sendMessage(room, "hello", { signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow("stopped");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort(new Error("stopped"));
    await rejection;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("Matrix outbound and thread/reaction mapping", () => {
  it("opens a root, sends questions in its thread, reuses the conversation and survives restart", async () => {
    const bodies: Record<string, unknown>[] = [];
    let serial = 0;
    const fetchImpl = vi.fn().mockImplementation(async (_url, init) => { bodies.push(JSON.parse(init.body)); return response({ event_id: `$sent-${++serial}` }); });
    const map = new ThreadSeatMap(home);
    const driver = new MatrixOutboundDriver({ home, client: api(fetchImpl), map, roomFor: async () => room });
    await driver.deliver(decision({ qitemId: "ask", sourceSession: "seat@rig", destinationSession: human, summary: "Choose", humanQuestions: [question] }));
    expect(bodies[0]["m.relates_to"]).toBeUndefined();
    expect(bodies[1]).toMatchObject({ body: expect.stringContaining("1️⃣ Red"), "m.relates_to": { event_id: "$sent-1", rel_type: "m.thread" } });
    const reloaded = new ThreadSeatMap(home);
    expect(reloaded.resolveByConversation(human, "seat@rig", "ask", room)?.threadRootEventId).toBe("$sent-1");
    expect(reloaded.question(room, "$sent-2")?.emojiOptions).toEqual({ "1️⃣": "red", "2️⃣": "blue" });
    await driver.deliver(decision({ qitemId: "ask", sourceSession: "seat@rig", destinationSession: human, text: "More" }, "decision-2"));
    expect(bodies[2]["m.relates_to"]).toMatchObject({ event_id: "$sent-1" });
    await new MatrixOutboundDriver({ home, client: api(fetchImpl), map: reloaded, roomFor: async () => room }).deliver(decision({ qitemId: "ask" }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    reloaded.close(room, "$sent-1");
    expect(routeMessage(reloaded, room, message("$reply", "yes", sender, "$sent-1"), "fallback").destination).toBe("seat@rig");
    expect(routeMessage(reloaded, "!other:example.org", message("$reply", "yes", sender, "$sent-1"), "fallback").destination).toBe("fallback");
  });
  it("splits Unicode safely, supplies valid HTML, and sends later chunks in the root thread", async () => {
    const text = "😀<&\n".repeat(3000);
    const chunks = splitMessage(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= MESSAGE_CHUNK_BYTES && !chunk.includes("\uFFFD"))).toBe(true);
    const bodies: Record<string, unknown>[] = [];
    const client = api(async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return response({ event_id: `$part-${bodies.length}` }); });
    await new MatrixOutboundDriver({ home, client, map: new ThreadSeatMap(home), roomFor: async () => room }).deliver(decision({ text, formattedBody: "<b>unsafe to slice</b>" }));
    expect(bodies).toHaveLength(chunks.length);
    expect(bodies[1]["m.relates_to"]).toMatchObject({ event_id: "$part-1" });
    expect(bodies.every((body) => !String(body.formatted_body).includes("unsafe to slice"))).toBe(true);
  });
  it("resumes a partially sent ask without resending its root", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ event_id: "$root" })).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response({ event_id: "$question" }));
    const opts = { home, client: api(fetchImpl), map: new ThreadSeatMap(home), roomFor: async () => room };
    const ask = decision({ qitemId: "ask", summary: "choose", humanQuestions: [question] });
    await expect(new MatrixOutboundDriver(opts).deliver(ask)).rejects.toThrow("offline");
    await new MatrixOutboundDriver({ ...opts, map: new ThreadSeatMap(home) }).deliver(ask);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1][0]).toBe(fetchImpl.mock.calls[2][0]);
    expect(fetchImpl.mock.calls[1][1].body).toBe(fetchImpl.mock.calls[2][1].body);
  });
  it("maps explicit emoji to options only for the asked human in the exact room", () => {
    const rendered = renderQuestion(question);
    expect(rendered.text).toContain("2️⃣ Blue (recommended)");
    const map = new ThreadSeatMap(home);
    map.recordQuestion({ roomId: room, threadRootEventId: "$root", eventId: "$question", human, seat: "seat@rig", conversationId: "ask", questionId: question.id, emojiOptions: rendered.emojiOptions });
    expect(reactionAnswer(map, room, reaction(), human)).toMatchObject({ qitemId: "ask", questionId: "choice", optionId: "blue" });
    expect(reactionAnswer(map, room, reaction("$r", "2⃣"), human)?.optionId).toBe("blue");
    expect(reactionAnswer(map, "!other:example.org", reaction(), human)).toBeNull();
    expect(reactionAnswer(map, room, reaction(), "other@external")).toBeNull();
    expect(reactionAnswer(map, room, reaction("$r", "👍"), human)).toBeNull();
    expect(OPTION_EMOJI).toHaveLength(4);
  });
  it("uses the same per-part transaction across producers of one notification episode", async () => {
    const fetchImpl = vi.fn(async () => response({ event_id: "$posted" }));
    const payload = { qitemId: "ask", notificationKey: "ask:episode", summary: "One alert", humanQuestions: [question] };
    await new MatrixOutboundDriver({ home, client: api(fetchImpl), map: new ThreadSeatMap(home), roomFor: async () => room }).deliver(decision(payload, "producer-1"));
    await new MatrixOutboundDriver({ home, client: api(fetchImpl), map: new ThreadSeatMap(home), roomFor: async () => room }).deliver(decision(payload, "producer-2"));
    expect(fetchImpl).toHaveBeenCalledTimes(2); // root + question, recovered from the posted-part store on replay
  });
});

describe("Matrix sync custody and pipeline", () => {
  it("establishes an initial floor, persists since and ignores the bot, edits and non-text events", async () => {
    const createQitem = vi.fn().mockResolvedValue("qitem");
    const fetchImpl = vi.fn().mockResolvedValueOnce(response({ next_batch: "floor", rooms: { join: { [room]: { timeline: { events: [message("$old")] } } } } }))
      .mockResolvedValueOnce(response({ next_batch: "next", rooms: { join: { [room]: { timeline: { events: [message("$bot", "self", bot), message("$new"), message("$new"),
        { ...message("$edit"), content: { msgtype: "m.text", body: "edit", "m.relates_to": { rel_type: "m.replace", event_id: "$new" } } },
        { ...message("$encrypted"), type: "m.room.encrypted" }] } } } } }));
    const opts = { queue: { createQitem } };
    await inbound(api(fetchImpl), opts).syncOnce(bot);
    expect(createQitem).not.toHaveBeenCalled();
    await inbound(api(fetchImpl), opts).syncOnce(bot);
    expect(fetchImpl.mock.calls[1][0]).toContain("since=floor");
    expect(createQitem).toHaveBeenCalledTimes(1);
    expect(createQitem.mock.calls[0][0]).toMatchObject({ source: human, destination: "operator-agent@kernel", tags: ["matrix", "inbound", "unrouted-signal"] });
    expect(JSON.parse(readFileSync(path.join(home, "state", "matrix-sync.json"), "utf8"))).toMatchObject({ since: "next", lastSync: expect.any(String) });
  });
  it("retains the page on pipeline failure and dedups events landed before it", async () => {
    seedSync();
    const createQitem = vi.fn().mockResolvedValueOnce("first").mockRejectedValueOnce(new Error("disk full")).mockResolvedValue("second");
    const fetchImpl = vi.fn().mockImplementation(async () => response({ next_batch: "next", rooms: { join: { [room]: { timeline: { events: [message("$one"), message("$two")] } } } } }));
    const sync = inbound(api(fetchImpl), { queue: { createQitem } });
    await expect(sync.syncOnce(bot)).rejects.toThrow("disk full");
    expect(JSON.parse(readFileSync(path.join(home, "state", "matrix-sync.json"), "utf8")).since).toBe("page-0");
    await sync.syncOnce(bot);
    expect(createQitem).toHaveBeenCalledTimes(3);
    expect(createQitem.mock.calls[1][0].qitemId).toBe(createQitem.mock.calls[2][0].qitemId);
  });
  it("lands reactions as structured answers and thread text on the mapped seat", async () => {
    seedSync();
    const map = new ThreadSeatMap(home);
    map.open({ roomId: room, threadRootEventId: "$root", human, seat: "seat@rig", conversationId: "ask" });
    map.recordQuestion({ roomId: room, threadRootEventId: "$root", eventId: "$question", human, seat: "seat@rig", conversationId: "ask", questionId: "choice", emojiOptions: renderQuestion(question).emojiOptions });
    const createQitem = vi.fn().mockResolvedValue("reply");
    const recordHumanAnswer = vi.fn().mockReturnValue({ status: "recorded", complete: true, questions: [question], answers: { choice: "blue" } });
    const resolveHumanReply = vi.fn().mockResolvedValue("resolved");
    const fetchImpl = vi.fn().mockImplementation(async () => response({ next_batch: "next", rooms: { join: { [room]: { timeline: { events: [reaction(), message("$reply", "yes", sender, "$root"), reaction("$other", "1️⃣", "$question", "@other:example.org")] } } } } }));
    await inbound(api(fetchImpl), { map, queue: { createQitem }, recordHumanAnswer, resolveHumanReply }).syncOnce(bot);
    expect(recordHumanAnswer).toHaveBeenCalledExactlyOnceWith({ qitemId: "ask", actorSession: human, questionId: "choice", optionId: "blue" });
    expect(createQitem).toHaveBeenCalledTimes(2);
    expect(createQitem.mock.calls[0][0]).toMatchObject({ destination: "seat@rig", inReplyTo: "ask", tags: ["matrix", "inbound", "human-answer"] });
    expect(resolveHumanReply).toHaveBeenCalledTimes(2);
  });
  it("reconnects with backoff and stops on token failure", async () => {
    seedSync();
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => url.endsWith("whoami") ? response({ user_id: bot }) : response({ errcode: "M_UNKNOWN_TOKEN", error: "expired" }, 401));
    fetchImpl.mockRejectedValueOnce(new Error("offline"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const sync = inbound(api(fetchImpl), { sleep });
    sync.start();
    await vi.waitFor(() => expect(sync.status().state).toBe("failed"));
    expect(sleep).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
    expect(sync.status().reconnects).toBe(1);
    await sync.stop();
  });
  it("aborts an outstanding long poll on stop", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("whoami")) return response({ user_id: bot });
      return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    });
    const sync = inbound(api(fetchImpl));
    sync.start();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    await sync.stop();
    expect(sync.status().state).toBe("stopped");
  });
  it("reports limited incremental timelines without advancing the cursor", async () => {
    seedSync();
    const sync = inbound(api(async () => response({ next_batch: "gap", rooms: { join: { [room]: { timeline: { limited: true, events: [] } } } } })));
    await expect(sync.syncOnce(bot)).rejects.toThrow("missing prev_batch");
    expect(JSON.parse(readFileSync(path.join(home, "state", "matrix-sync.json"), "utf8")).since).toBe("page-0");
  });
  it("backfills a limited timeline in order, retaining custody through a failed history page", async () => {
    seedSync();
    const landed: string[] = [];
    let fail = true;
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/sync?")) return response({ next_batch: "next", rooms: { join: { [room]: { timeline: { limited: true, prev_batch: "start", events: [message("$three", "three")] } } } } });
      if (url.includes("from=page-0")) return response({ chunk: [message("$one", "one")], end: "middle" });
      if (fail) { fail = false; throw new Error("history offline"); }
      return response({ chunk: [message("$two", "two")], end: "start" });
    });
    const opts = { queue: { createQitem: vi.fn(async (input) => { landed.push(input.body); return input.qitemId; }) } };
    await expect(inbound(api(fetchImpl), opts).syncOnce(bot)).rejects.toThrow("history offline");
    expect(JSON.parse(readFileSync(path.join(home, "state", "matrix-sync.json"), "utf8")).since).toBe("page-0");
    await inbound(api(fetchImpl), opts).syncOnce(bot);
    expect(landed).toEqual(["one", "two", "three"]);
    expect(fetchImpl.mock.calls.find(([url]) => url.includes("/messages?"))![0]).toContain("to=start&dir=f&limit=100");
  });
  it("rejects stalled history pagination without advancing the cursor", async () => {
    seedSync();
    const client = api(async (url) => response(url.includes("/sync?")
      ? { next_batch: "next", rooms: { join: { [room]: { timeline: { limited: true, prev_batch: "start" } } } } }
      : { chunk: [], end: "page-0" }));
    await expect(inbound(client).syncOnce(bot)).rejects.toThrow("pagination stalled");
    expect(JSON.parse(readFileSync(path.join(home, "state", "matrix-sync.json"), "utf8")).since).toBe("page-0");
  });
  it("routes ordinary replies to a posted question and removes the quoted fallback", async () => {
    seedSync();
    const map = new ThreadSeatMap(home);
    map.open({ roomId: room, threadRootEventId: "$root", human, seat: "seat@rig", conversationId: "ask" });
    map.recordQuestion({ roomId: room, threadRootEventId: "$root", eventId: "$question", human, seat: "seat@rig", conversationId: "ask", questionId: "choice", emojiOptions: {} });
    const reply = { ...message("$reply"), content: { msgtype: "m.text", body: "> <@bot:example.org> Choose\n> Red or blue\n\nBlue please", "m.relates_to": { "m.in_reply_to": { event_id: "$question" } } } };
    const createQitem = vi.fn().mockResolvedValue("reply");
    const resolveHumanReply = vi.fn().mockResolvedValue("resolved");
    await inbound(api(async () => response({ next_batch: "next", rooms: { join: { [room]: { timeline: { events: [reply] } } } } })), { map, queue: { createQitem }, resolveHumanReply }).syncOnce(bot);
    expect(createQitem).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ destination: "seat@rig", body: "Blue please", inReplyTo: "ask" }));
    expect(resolveHumanReply).toHaveBeenCalledWith({ qitemId: "ask", actorSession: human, decision: "Blue please" });
  });
  it("retries answer continuation with the same queue identity after a resolver failure", async () => {
    seedSync();
    const map = new ThreadSeatMap(home);
    map.recordQuestion({ roomId: room, threadRootEventId: "$root", eventId: "$question", human, seat: "seat@rig", conversationId: "ask", questionId: "choice", emojiOptions: renderQuestion(question).emojiOptions });
    const createQitem = vi.fn().mockResolvedValue("reply");
    const recordHumanAnswer = vi.fn().mockReturnValue({ status: "recorded", complete: true, questions: [question], answers: { choice: "blue" } });
    const resolveHumanReply = vi.fn().mockRejectedValueOnce(new Error("resolve offline")).mockResolvedValue("resolved");
    const client = api(async () => response({ next_batch: "next", rooms: { join: { [room]: { timeline: { events: [reaction()] } } } } }));
    const opts = { map, queue: { createQitem }, recordHumanAnswer, resolveHumanReply };
    await expect(inbound(client, opts).syncOnce(bot)).rejects.toThrow("resolve offline");
    await inbound(client, opts).syncOnce(bot);
    expect(createQitem.mock.calls[0][0]).toEqual(createQitem.mock.calls[1][0]);
    expect(resolveHumanReply).toHaveBeenCalledTimes(2);
  });
});

describe("Matrix configuration, credentials and human bindings", () => {
  it("accepts room IDs, aliases and optional role/user suffixes through the registry", () => {
    expect(parseMatrixBinding("matrix:!abc:example.org")).toMatchObject({ connectorRef: "!abc:example.org", role: "primary", secretsRef: "matrix-config" });
    const parsed = parseBindingSpec("matrix:#room:example.org:8448;role=primary;handle=@alice:example.org");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const validation = validateHumanFragment({ entityId: "alice", class: "human", displayName: "Alice", address: human, connectorBindings: [parsed.binding], prefs: { deliveryClass: "B" } });
    expect(validation.ok).toBe(true);
    if (validation.ok) expect(validation.fragment.connectorBindings[0].kind).toBe("matrix");
    expect(parseBindingSpec("matrix:invalid").ok).toBe(false);
    expect(parseBindingSpec("matrix:!room:server;handle=alice").ok).toBe(false);
    expect(parseBindingSpec("matrix:!room:server;role=other").ok).toBe(false);
  });
  it("saves config separately from 0600 token file and resolves env precedence", () => {
    expect(loadConfig(home)).toEqual(DEFAULT_CONFIG);
    const file = saveAccessToken("secret-value", home);
    const cfg = { ...DEFAULT_CONFIG, homeserverUrl: "https://matrix.example.org", defaultRoom: room, deviceId: "DEVICE", secretsEnvFile: file };
    const configFile = saveConfig(cfg, home);
    expect(loadConfig(home)).toEqual(cfg);
    expect(readFileSync(configFile, "utf8")).not.toContain("secret-value");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(resolveAccessToken({ envFile: file, env: {} })).toBe("secret-value");
    expect(resolveAccessToken({ envFile: file, env: { OPENRIG_MATRIX_ACCESS_TOKEN: "env-token" } })).toBe("env-token");
    expect(resolveAccessToken({ envFile: "/tmp/absent-matrix-file", env: {} })).toBeNull();
    expect(() => saveAccessToken("token\ninjected=secret", home)).toThrow("single-line");
    expect(() => saveConfig({ ...cfg, homeserverUrl: "https://user:pass@server" }, home)).toThrow("without credentials");
    writeFileSync(configFile, "broken");
    expect(() => loadConfig(home)).toThrow();
  });
  it("rotates only the Matrix entry in a shared secrets file, preserving comments and blank lines", () => {
    const file = path.join(home, "shared.env");
    const other = "# Shared connector credentials\nSLACK_BOT_TOKEN=slack-bot\n\nSLACK_APP_TOKEN=slack-app";
    writeFileSync(file, `MATRIX_ACCESS_TOKEN=old\n${other}\n MATRIX_ACCESS_TOKEN = duplicate\n`);
    saveAccessToken("new-token", home, file);
    expect(readFileSync(file, "utf8")).toBe(`${other}\nMATRIX_ACCESS_TOKEN=new-token\n`);
    expect(resolveAccessToken({ envFile: file, env: {} })).toBe("new-token");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, other);
    saveAccessToken("next-token", home, file);
    expect(readFileSync(file, "utf8")).toBe(`${other}\nMATRIX_ACCESS_TOKEN=next-token\n`);
    expect(() => saveAccessToken("unused", home, home)).toThrow();
  });
});
