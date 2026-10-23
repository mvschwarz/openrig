import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { jsonBodyErrorHandler, trackJsonBodyParseErrors } from "../src/middleware/json-body-error.js";
import { DeliveryGuardError } from "../src/domain/seat-delivery-guard.js";

const post = (body: string) => ({ method: "POST", headers: { "content-type": "application/json" }, body });

describe("malformed request bodies", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  for (const path of ["/api/ask", "/api/transport/send", "/api/transport/capture", "/api/transport/broadcast"]) {
    it(`${path} answers 400, not 500, for a body that is not JSON`, async () => {
      const { app } = createTestApp(db);
      for (const body of ["{", "not json", ""]) {
        const res = await app.request(path, post(body));
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_json", message: "Request body is not valid JSON." });
      }
    });
  }
});

describe("a request body of JSON null", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  // Routes that read the body with a bare `await c.req.json()` then read a field
  // off the result, so `null` used to die as `null.field`: a 500.
  for (const path of ["/api/ask", "/api/transport/send", "/api/transport/capture", "/api/transport/broadcast", "/api/specs/review/rig", "/api/specs/review/agent"]) {
    it(`${path} answers 400, not 500`, async () => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { app } = createTestApp(db);
        const res = await app.request(path, post("null"));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_json", message: "Request body must be a JSON object, not null." });
      } finally {
        errorLog.mockRestore();
      }
    });
  }
});

describe("a JSON null body on routes that catch a bad body themselves", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  for (const path of ["/api/stream/emit", "/api/scope/approve"]) {
    it(`${path} keeps its own 400 refusal`, async () => {
      const { app } = createTestApp(db);
      expect((await app.request(path, post("null"))).status).toBe(400);
    });
  }
});

describe("JSON null bodies on operation-correlated rig routes without an operation ID", () => {
  let db: Database.Database;
  beforeEach(() => { db = createFullTestDb(); });
  afterEach(() => { db.close(); });

  it("keeps POST /api/rigs on its required-name 400 response", async () => {
    const { app } = createTestApp(db);
    const res = await app.request("/api/rigs", post("null"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "name is required" });
  });

  it("keeps POST /api/rigs/:rigId/pods/:podNamespace/members on its required-member 400 response", async () => {
    const { app, rigRepo } = createTestApp(db);
    const rig = rigRepo.createRig("null-member-body");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
      .run("null-member-pod", rig.id, "dev", "Development");

    const res = await app.request(`/api/rigs/${rig.id}/pods/dev/members`, post("null"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "member is required (a member fragment with id, runtime, agent_ref)" });
  });
});

describe("jsonBodyErrorHandler", () => {
  function app(route: (c: Context) => Promise<Response> | Response): Hono {
    const app = new Hono();
    app.use("*", trackJsonBodyParseErrors);
    app.onError(jsonBodyErrorHandler);
    app.use("*", async (c, next) => { c.header("x-earlier", "kept"); await next(); });
    app.all("/x", route);
    return app;
  }
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errorLog = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { errorLog.mockRestore(); });

  it("answers 400 for the error thrown by parsing the request body", async () => {
    const res = await app(async (c) => c.json(await c.req.json())).request("/x", post("{"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json", message: "Request body is not valid JSON." });
  });

  it("leaves a route that catches a bad body to answer for itself", async () => {
    const res = await app(async (c) => {
      try { return c.json(await c.req.json()); } catch { return c.json({ error: "own_shape" }, 422); }
    }).request("/x", post("{"));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "own_shape" });
  });

  it("keeps a SyntaxError from anything but the request body a logged 500", async () => {
    const route = () => { JSON.parse("{stored"); return new Response("unreachable"); };
    const get = await app(route).request("/x");
    expect(get.status).toBe(500);
    const withBody = await app(async (c) => { await c.req.json(); return route(); }).request("/x", post('{"ok":true}'));
    expect(withBody.status).toBe(500);
    expect(errorLog).toHaveBeenCalledTimes(2);
  });

  it("keeps a typed refusal's own response, as Hono's default does", async () => {
    const res = await app(() => { throw new DeliveryGuardError("guard_busy", "seat is busy"); }).request("/x", { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, code: "guard_busy", error: "seat is busy" });
    expect(res.headers.get("x-earlier")).toBe("kept");
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("keeps headers set by earlier middleware on an HTTPException", async () => {
    const res = await app(() => { throw new HTTPException(418, { message: "teapot" }); }).request("/x", post("{"));
    expect(res.status).toBe(418);
    expect(res.headers.get("x-earlier")).toBe("kept");
  });
});
