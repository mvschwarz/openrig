import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  createMutationTraceMiddleware,
  MUTATION_TRACE_SCHEMA,
  type MutationTraceSink,
} from "../src/domain/mutation-trace.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

function capturingSink(): MutationTraceSink & { records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    recordDiagnostic: (record) => {
      records.push(record);
      return true;
    },
  };
}

describe("mutation trace middleware", () => {
  it("lets GET through to the handler and records nothing", async () => {
    const sink = capturingSink();
    const app = new Hono();
    app.use("*", createMutationTraceMiddleware(sink));
    app.get("/api/thing", (c) => c.json({ ok: true }));

    const res = await app.request("/api/thing", { method: "GET" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sink.records).toHaveLength(0);
  });

  it("records one line per state-changing request with status and sender", async () => {
    const sink = capturingSink();
    const app = new Hono();
    app.use("*", createMutationTraceMiddleware(sink));
    app.post("/api/thing", (c) => c.json({ ok: true }, 201));

    const res = await app.request("/api/thing", {
      method: "POST",
      headers: { "x-openrig-session": "seat@rig" },
    });
    expect(res.status).toBe(201);

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      schema: MUTATION_TRACE_SCHEMA,
      method: "POST",
      path: "/api/thing",
      status: 201,
      sender: "seat@rig",
    });
    expect(Number.isNaN(Date.parse(String(sink.records[0]!.at)))).toBe(false);
  });

  it("never lets a failing trace write replace the route response", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink: MutationTraceSink = {
      recordDiagnostic: () => {
        throw new Error("diagnostics path unavailable");
      },
    };
    const app = new Hono();
    app.use("*", createMutationTraceMiddleware(sink));
    app.post("/api/thing", (c) => c.json({ ok: true }, 201));

    const res = await app.request("/api/thing", { method: "POST" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("leaves the response untouched when the record is dropped", async () => {
    const sink: MutationTraceSink = { recordDiagnostic: () => false };
    const app = new Hono();
    app.use("*", createMutationTraceMiddleware(sink));
    app.post("/api/thing", (c) => c.json({ ok: true }, 201));

    const res = await app.request("/api/thing", { method: "POST" });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("mutation trace wiring (createApp)", () => {
  it("registers the trace middleware when a sink is wired through appDeps", async () => {
    const db = createFullTestDb();
    const sink = capturingSink();
    const { app } = createTestApp(db, { appDeps: { mutationTrace: sink } });

    // Any mutating request reaches the middleware even when the route 404s —
    // that is enough to prove createApp registered it (no route handler needed).
    const res = await app.request("/api/definitely-not-a-route", { method: "POST" });
    expect(res.status).toBe(404);

    expect(sink.records).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({
      schema: MUTATION_TRACE_SCHEMA,
      method: "POST",
      path: "/api/definitely-not-a-route",
      status: 404,
    });
    db.close();
  });

  it("keeps the default app quiet when no sink is wired", async () => {
    const db = createFullTestDb();
    const { app } = createTestApp(db);
    const res = await app.request("/api/definitely-not-a-route", { method: "POST" });
    expect(res.status).toBe(404);
    db.close();
  });
});
