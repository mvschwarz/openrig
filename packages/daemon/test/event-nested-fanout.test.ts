import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { EventBus } from "../src/domain/event-bus.js";
import { eventsRoute } from "../src/routes/events.js";

describe("subscriber-generated events", () => {
  let db: Database.Database;
  let bus: EventBus;
  beforeEach(() => {
    db = createDb();
    db.exec(eventsSchema.sql);
    bus = new EventBus(db);
  });
  afterEach(() => db.close());

  it.each(["emit", "envelope"])("delivers %s children once, after the parent reaches every subscriber", (writer) => {
    const first: number[] = [];
    const second: number[] = [];
    bus.subscribe((event) => {
      first.push(event.seq);
      if (event.type !== "rig.created") return;
      const child = { type: "rig.deleted" as const, rigId: "rig-1" };
      if (writer === "emit") bus.emit(child);
      else bus.withNotifyEnvelope((register) => register(bus.persistWithinTransaction(child)));
    });
    bus.subscribe((event) => second.push(event.seq));
    bus.emit({ type: "rig.created", rigId: "rig-1" });
    const persisted = bus.replayAll(0).map((event) => event.seq);
    expect(persisted).toEqual([1, 2]);
    expect(first).toEqual(persisted);
    expect(second).toEqual(persisted);
    expect(bus.getNotifyDrainStatus().watermark).toBe(2);
  });

  it("streams nested live events in the same order as durable replay", async () => {
    bus.subscribe((event) => {
      if (event.type === "rig.created") bus.emit({ type: "rig.deleted", rigId: "rig-1" });
    });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("eventBus" as never, bus as never); await next(); });
    app.route("/events", eventsRoute);
    const response = await app.request("/events");
    const reader = response.body!.getReader();
    const received: number[] = [];
    let pending = "";
    try {
      expect(bus.subscriberCount).toBe(2);
      bus.emit({ type: "rig.created", rigId: "rig-1" });
      bus.emit({ type: "view.changed", viewName: "end", cause: "test" });
      const decoder = new TextDecoder();
      while (!received.includes(3)) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const id = frame.match(/^id: (\d+)$/m);
          if (id) received.push(Number(id[1]));
        }
      }
      expect(received).toEqual(bus.replayAll(0).map((event) => event.seq));
    } finally {
      await reader.cancel();
    }
    expect(bus.subscriberCount).toBe(1);
  });
});
