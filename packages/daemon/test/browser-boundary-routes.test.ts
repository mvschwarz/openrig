// Browser boundary on the real route table (createApp via createTestApp): refused requests
// reach no handler and no remote forward; admitted requests reach the inert handler once.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";

type Call = { method: string; args: unknown[] };

function inertTransport(calls: Call[]) {
  return {
    resolveSessions: async (...args: unknown[]) => { calls.push({ method: "resolveSessions", args }); return { ok: false, code: "not_found", error: "inert fixture" }; },
    send: async (...args: unknown[]) => { calls.push({ method: "send", args }); return { ok: false, error: "inert" }; },
    capture: async (...args: unknown[]) => { calls.push({ method: "capture", args }); return { ok: false, error: "inert" }; },
    broadcast: async (...args: unknown[]) => { calls.push({ method: "broadcast", args }); return { ok: false, error: "inert" }; },
  };
}

describe("browser boundary on the real route table", () => {
  let db: Database.Database;
  let home: string;
  let spy: http.Server;
  let spyHits = 0;
  const savedHome = process.env.OPENRIG_HOME;

  beforeEach(async () => {
    db = createFullTestDb();
    home = fs.mkdtempSync(path.join(os.tmpdir(), "bb-routes-"));
    spyHits = 0;
    spy = http.createServer((_req, res) => { spyHits++; res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); });
    await new Promise<void>((r) => spy.listen(0, "127.0.0.1", () => r()));
    const port = (spy.address() as AddressInfo).port;
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: peer\n    transport: http\n    url: http://127.0.0.1:${port}\n`);
    process.env.OPENRIG_HOME = home;
  });
  afterEach(async () => {
    if (savedHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = savedHome;
    await new Promise<void>((r) => spy.close(() => r()));
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  function build(extra: Record<string, unknown> = {}) {
    const calls: Call[] = [];
    const previews: unknown[] = [];
    const decisions: Array<{ outcome: string; code?: string }> = [];
    const { app } = createTestApp(db, {
      appDeps: {
        sessionTransport: inertTransport(calls) as never,
        queueRepo: new QueueRepository(db, new EventBus(db), { validateRig: () => true }),
        terminalService: { previewView: async (req: unknown) => { previews.push(req); return { ok: false, error: "inert" }; } } as never,
        browserBoundaryObserver: (d) => decisions.push(d),
        ...extra,
      },
    });
    const rows = () => (db.prepare("SELECT count(*) AS n FROM queue_items").get() as { n: number }).n;
    return { app, calls, previews, decisions, rows };
  }

  const req = (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, p: string, h: Record<string, string>, method = "GET", body?: unknown) =>
    app.request(p, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...h }, ...(body ? { body: JSON.stringify(body) } : {}) });

  it("POST /api/transport/send: refused origin or target reaches no handler; admitted reaches it once", async () => {
    const b = build();
    const body = { session: "dev-impl@rig", text: "fixture" };
    for (const h of [
      { Host: "evil.example:7433", Origin: "http://evil.example:7433" }, // rebinding shape
      { Host: "127.0.0.1:7433", Origin: "http://evil.example" }, // cross-site
      { Host: "127.0.0.1:7433", Origin: "null" },
      { Host: "unknown.example:7433" }, // non-browser, unlisted name
    ]) {
      const res = await req(b.app, "/api/transport/send", h, "POST", body);
      expect(res.status, JSON.stringify(h)).toBe(403);
    }
    expect(b.calls).toHaveLength(0);
    const ok = await req(b.app, "/api/transport/send", { Host: "127.0.0.1:7433" }, "POST", body);
    expect(ok.status).not.toBe(403);
    expect(b.calls.map((c) => c.method)).toEqual(["resolveSessions"]);
    expect(b.decisions).toHaveLength(5);
  });

  it("GET /api/terminal/preview: a no-Origin read addressed to an attacker name reaches no handler", async () => {
    const b = build();
    expect((await req(b.app, "/api/terminal/preview?view=x", { Host: "evil.example:7433" })).status).toBe(403);
    expect((await req(b.app, "/api/terminal/preview?view=x", { Host: "evil.example:7433", "Sec-Fetch-Site": "same-origin" })).status).toBe(403);
    expect(b.previews).toHaveLength(0);
    await req(b.app, "/api/terminal/preview?view=x", { Host: "localhost:7433" });
    expect(b.previews).toHaveLength(1);
  });

  it("POST /api/queue/create: a refused request writes no row; an admitted one does", async () => {
    const b = build();
    const body = { sourceSession: "orch@rig-a", destinationSession: "dev@rig-a", body: "fixture" };
    const refused = await req(b.app, "/api/queue/create", { Host: "127.0.0.1:7433", Origin: "http://evil.example", "X-OpenRig-Session": "orch@rig-a" }, "POST", body);
    expect(refused.status).toBe(403);
    expect(b.rows()).toBe(0);
    const ok = await req(b.app, "/api/queue/create", { Host: "127.0.0.1:7433", "X-OpenRig-Session": "orch@rig-a" }, "POST", body);
    expect(ok.status).toBeLessThan(300);
    expect(b.rows()).toBe(1);
  });

  it("GET /api/ps?host=peer: refused before the read-through forwards; admitted forwards once", async () => {
    const b = build();
    expect((await req(b.app, "/api/ps?host=peer", { Host: "127.0.0.1:7433", Origin: "http://evil.example" })).status).toBe(403);
    expect((await req(b.app, "/api/ps?host=peer", { Host: "evil.example:7433" })).status).toBe(403);
    expect(spyHits).toBe(0);
    const ok = await req(b.app, "/api/ps?host=peer", { Host: "127.0.0.1:7433" });
    expect(ok.status).toBe(200);
    expect(spyHits).toBe(1);
  });

  it("UI on admits the own UI origin through the real table; a token never waives an origin refusal", async () => {
    const b = build({ webUiEnabled: true, missionControlBearerToken: "tok-1" });
    expect((await req(b.app, "/api/ps", { Host: "localhost:7433", Origin: "http://localhost:7433" })).status).toBe(200);
    expect((await req(b.app, "/api/ps", { Host: "custom.example:7433", Authorization: "Bearer tok-1" })).status).toBe(200);
    const r = await req(b.app, "/api/ps", { Host: "custom.example:7433", Authorization: "Bearer tok-1", Origin: "http://evil.example" });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code: string }).code).toBe("browser_origin_refused");
  });

  it("a waived target name keeps downstream route authorization: wrong-route token still refused by the route", async () => {
    const b = build({ missionControlBearerToken: "mc-token", terminalBearerToken: "term-token" });
    const body = { session: "dev-impl@rig", text: "fixture" };
    // Mission-control token waives the name check, but /api/transport still requires the terminal token.
    const r = await req(b.app, "/api/transport/send", { Host: "custom.example:7433", Authorization: "Bearer mc-token" }, "POST", body);
    expect(r.status).toBe(401);
    expect(b.calls).toHaveLength(0);
    const ok = await req(b.app, "/api/transport/send", { Host: "custom.example:7433", Authorization: "Bearer term-token" }, "POST", body);
    expect(ok.status).not.toBe(401);
    expect(b.calls.map((c) => c.method)).toEqual(["resolveSessions"]);
  });
});
