import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { ChatRepository } from "../domain/chat-repository.js";

export function chatRoutes(): Hono {
  const app = new Hono();

  function getChatRepo(c: { get: (key: string) => unknown }): ChatRepository {
    return c.get("chatRepo" as never) as ChatRepository;
  }

  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  // POST /send — persist message + emit event
  app.post("/send", async (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "Missing rigId" }, 400);

    const body = await c.req.json<{ sender?: string; body?: string }>().catch(() => ({} as { sender?: string; body?: string }));
    if (!body.body) return c.json({ error: "Missing body" }, 400);

    const sender = body.sender ?? "anonymous";
    const chatRepo = getChatRepo(c);
    const eventBus = getEventBus(c);

    const msg = chatRepo.send(rigId, sender, body.body);

    eventBus.emit({
      type: "chat.message",
      rigId,
      messageId: msg.id,
      sender: msg.sender,
      kind: msg.kind,
      body: msg.body,
    });

    return c.json(msg, 201);
  });

  // GET /history — query messages
  app.get("/history", (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "Missing rigId" }, 400);

    const topic = c.req.query("topic");
    const limitStr = c.req.query("limit");
    const after = c.req.query("after");
    const since = c.req.query("since");
    const sender = c.req.query("sender");
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    const chatRepo = getChatRepo(c);
    const messages = chatRepo.history(rigId, { topic, limit, after, since, sender });

    return c.json(messages);
  });

  // GET /watch — SSE stream of chat messages
  app.get("/watch", (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "Missing rigId" }, 400);

    const chatRepo = getChatRepo(c);
    const eventBus = getEventBus(c);

    return streamSSE(c, async (stream) => {
      // Subscribe FIRST to avoid race between initial batch and new messages
      const pendingMessages: Array<{ id: string; data: string }> = [];
      let initialDone = false;
      const unsubscribe = eventBus.subscribe((event) => {
        if (event.type === "chat.message" && "rigId" in event && (event as { rigId: string }).rigId === rigId) {
          const chatEvent = event as { messageId: string; sender: string; kind: string; body: string; topic?: string; rigId: string };
          const msg = {
            id: chatEvent.messageId,
            rigId: chatEvent.rigId,
            sender: chatEvent.sender,
            kind: chatEvent.kind,
            body: chatEvent.body,
            topic: chatEvent.topic ?? null,
            createdAt: event.createdAt,
          };
          const sseMsg = { id: msg.id, data: JSON.stringify(msg) };
          if (initialDone) {
            stream.writeSSE(sseMsg).catch(() => {});
          } else {
            pendingMessages.push(sseMsg);
          }
        }
      });

      // Send initial batch
      const initial = chatRepo.latest(rigId, 20);
      const sentIds = new Set<string>();
      for (const msg of initial) {
        await stream.writeSSE({ id: msg.id, data: JSON.stringify(msg) });
        sentIds.add(msg.id);
      }

      // Flush any messages received during initial batch, dedup by ID
      initialDone = true;
      for (const pending of pendingMessages) {
        if (!sentIds.has(pending.id)) {
          await stream.writeSSE(pending);
        }
      }

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        unsubscribe();
      }
    });
  });

  // POST /topic — create topic marker
  app.post("/topic", async (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "Missing rigId" }, 400);

    const body = await c.req.json<{ sender?: string; topic?: string; body?: string }>().catch(() => ({} as { sender?: string; topic?: string; body?: string }));
    if (!body.topic) return c.json({ error: "Missing topic" }, 400);

    const sender = body.sender ?? "anonymous";
    const chatRepo = getChatRepo(c);
    const eventBus = getEventBus(c);

    const msg = chatRepo.sendTopic(rigId, sender, body.topic, body.body);

    eventBus.emit({
      type: "chat.message",
      rigId,
      messageId: msg.id,
      sender: msg.sender,
      kind: msg.kind,
      body: msg.body,
      topic: msg.topic ?? undefined,
    });

    return c.json(msg, 201);
  });

  // POST /clear — delete all messages for this rig
  app.post("/clear", (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "Missing rigId" }, 400);

    const chatRepo = getChatRepo(c);
    const result = chatRepo.clear(rigId);
    return c.json({ ok: true, deleted: result.deleted });
  });

  return app;
}
