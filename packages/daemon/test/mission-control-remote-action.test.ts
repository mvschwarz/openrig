// OPR.0.4.4.15 FR-4 — remote action forwarding on POST /api/mission-control/action.
//
// The load-bearing pins: hostId absent/local = the existing path
// byte-for-byte (write contract invoked); remote = server-side forward with
// the origin's structured response passed through VERBATIM (success AND
// failure — the fake-success negative); NOTHING written to the local write
// contract on the forwarded path (arch ruling 4 addition riding R15-3:
// origin's audit row is THE record); only the one verb allowlist gates.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "B" },
    { id: "ssh-1", transport: "ssh", target: "x.local" },
  ],
};

function makeApp(opts: { fetchImpl?: typeof fetch } = {}) {
  const localActs: unknown[] = [];
  const writeContract = {
    act: async (req: unknown) => {
      localActs.push(req);
      return { ok: true, actionId: "local-act-1" };
    },
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    set("missionControlWriteContract", writeContract);
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    if (opts.fetchImpl) set("remoteFetchImpl", opts.fetchImpl);
    set("eventBus", { emit: () => {} });
    await next();
  });
  app.route("/api/mission-control", missionControlRoutes({ bearerToken: null }));
  return { app, localActs };
}

const BASE_BODY = { verb: "resolve", qitemId: "qitem-1", actorSession: "human@host" };

function post(app: Hono, body: Record<string, unknown>) {
  // P21: the caller's transport identity is the X-OpenRig-Session header (stamped by DaemonClient from
  // the seat env). Mirror it from the body's actorSession so these fixtures present a legit caller
  // (header == claim ⇒ tolerated); the forward then RE-STAMPS it and drops the body claim.
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof body.actorSession === "string") headers["X-OpenRig-Session"] = body.actorSession;
  return app.request("/api/mission-control/action", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// Bearer env for the forward legs.
process.env["B"] = "remote-token";

describe("POST /action — FR-4 remote forwarding", () => {
  it("hostId ABSENT: the existing local write path runs byte-for-byte", async () => {
    const { app, localActs } = makeApp();
    const res = await post(app, BASE_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, actionId: "local-act-1" });
    expect(localActs).toHaveLength(1);
  });

  it("hostId 'local': same local path (the contract's literal is not a remote)", async () => {
    const { app, localActs } = makeApp();
    const res = await post(app, { ...BASE_BODY, hostId: "local" });
    expect(res.status).toBe(200);
    expect(localActs).toHaveLength(1);
  });

  it("remote hostId: forwards the SAME body (minus hostId) with the bearer; origin's SUCCESS response passes through verbatim; LOCAL write contract untouched", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const { app, localActs } = makeApp({
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        capture.url = String(url);
        capture.init = init;
        return new Response(JSON.stringify({ ok: true, actionId: "origin-act-9", audited: "on-origin" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    const res = await post(app, { ...BASE_BODY, hostId: "vps-b", annotation: "from the merged feed" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, actionId: "origin-act-9", audited: "on-origin" });
    expect(capture.url).toBe("http://vps-b:7433/api/mission-control/action");
    const fwdHeaders = capture.init?.headers as Record<string, string>;
    expect(fwdHeaders["Authorization"]).toBe("Bearer remote-token");
    // P21 I2 cross-host RE-STAMP: the forward carries THIS daemon's derived actor + a relay marker,
    // and DROPS the inbound body actorSession claim — the origin derives the re-stamped actor.
    expect(fwdHeaders["X-OpenRig-Session"]).toBe("human@host"); // re-stamped from the derived actor
    expect(fwdHeaders["X-OpenRig-Relay"]).toBeTruthy(); // relay provenance marked
    // P21 review-actions deferral: the forward CARRIES the resolved provenance so the origin never
    // launders it. A CLI-derived (header-present) actor is carried as transport:v1 (origin ⇒ relay:v1).
    expect(fwdHeaders["X-OpenRig-Provenance"]).toBe("transport:v1");
    const forwarded = JSON.parse(String(capture.init?.body)) as Record<string, unknown>;
    expect(forwarded).toEqual({ verb: "resolve", qitemId: "qitem-1", annotation: "from the merged feed" }); // hostId AND actorSession stripped
    expect(forwarded).not.toHaveProperty("actorSession"); // the inbound claim never rides the wire
    expect(localActs).toEqual([]); // arch pin: local mission_control_actions CLEAN after forward
  });

  it("P21 forward PRESERVES claimed-era: a HEADERLESS (browser UI) action forwarded carries the claimed actor + X-OpenRig-Provenance=claimed:v1 — never upgraded to transport:v1", async () => {
    const capture: { init?: RequestInit } = {};
    const { app, localActs } = makeApp({
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        capture.init = init;
        return new Response(JSON.stringify({ ok: true, actionId: "origin-act-ui" }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    // Browser UI: NO X-OpenRig-Session header (bearer only), a body actorSession, targeting a REMOTE item.
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verb: "resolve", qitemId: "qitem-1", actorSession: "founder@host", hostId: "vps-b" }),
    });
    expect(res.status).toBe(200);
    const fwdHeaders = capture.init?.headers as Record<string, string>;
    expect(fwdHeaders["X-OpenRig-Session"]).toBe("founder@host"); // the claimed actor rides the header
    expect(fwdHeaders["X-OpenRig-Provenance"]).toBe("claimed:v1"); // PRESERVED — the origin cannot launder it to verified
    expect(JSON.parse(String(capture.init?.body))).not.toHaveProperty("actorSession"); // body claim still stripped
    expect(localActs).toEqual([]);
  });

  it("origin REFUSAL passes through as structured failure — no fake success, local contract untouched", async () => {
    const { app, localActs } = makeApp({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "qitem qitem-1 not found on this host" }), { status: 404, headers: { "Content-Type": "application/json" } })) as typeof fetch,
    });
    const res = await post(app, { ...BASE_BODY, hostId: "vps-b" });
    expect(res.status).toBe(502);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toMatchObject({ error: "remote_action_failed", hostId: "vps-b", failureClass: "remote-error", remoteStatus: 404 });
    expect(String(data["detail"])).toContain("not found on this host");
    expect(localActs).toEqual([]);
  });

  it("origin unreachable at action time: structured per-host error (never optimistic), never hangs (deadline through body)", async () => {
    const { app, localActs } = makeApp({
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    const res = await post(app, { ...BASE_BODY, hostId: "vps-b" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "remote_action_failed", failureClass: "unreachable", detail: "ECONNREFUSED" });
    expect(localActs).toEqual([]);
  });

  it("SSH-declared and unknown hosts fail structurally BEFORE any wire attempt", async () => {
    let wireTouched = false;
    const { app } = makeApp({
      fetchImpl: (async () => {
        wireTouched = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const ssh = await post(app, { ...BASE_BODY, hostId: "ssh-1" });
    expect(ssh.status).toBe(502);
    expect(await ssh.json()).toMatchObject({ failureClass: "unsupported-transport" });
    const ghost = await post(app, { ...BASE_BODY, hostId: "ghost" });
    expect(await ghost.json()).toMatchObject({ failureClass: "unknown-host" });
    expect(wireTouched).toBe(false);
  });

  it("the verb allowlist gates BEFORE any forward (one allowlist, no duplicated validation)", async () => {
    let wireTouched = false;
    const { app } = makeApp({
      fetchImpl: (async () => {
        wireTouched = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const res = await post(app, { verb: "reboot-host", qitemId: "q", actorSession: "a", hostId: "vps-b" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "verb_unknown" });
    expect(wireTouched).toBe(false);
  });
});
