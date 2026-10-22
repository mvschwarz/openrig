// A daemon that is alive but busy answers its health check slowly, with an error or with a starved event
// loop. Such a daemon gets the command's real request, under the request's normal timeout, instead of an
// immediate "did not respond" refusal. Only a daemon confirmed down (connection refused, or a stale or
// missing process) keeps today's fast "not running" refusal. A write whose real request then times out
// reports an unknown outcome, and nothing is sent twice. The compiled CLI runs as its own process against a
// stub daemon on a local port, so the probe, the client and the exit status are the real ones.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";

const cliEntry = path.join(__dirname, "..", "dist", "index.js");

type Healthz = "ok" | "unhealthy" | "reset" | "starved" | "slow";

interface Run { stdout: string; stderr: string; exit: number | null; requests: string[] }

describe.skipIf(!fs.existsSync(cliEntry))("a busy but alive daemon gets the real request", () => {
  let server: http.Server;
  let port: number;
  let healthz: Healthz = "ok";
  let emitHangs = false;
  const requests: string[] = [];
  const held = new Set<http.ServerResponse>();
  let home: string;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "busy-daemon-"));
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/healthz")) {
        if (healthz === "ok") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok" }));
        if (healthz === "unhealthy") return void res.writeHead(503).end();
        if (healthz === "reset") return void req.socket.destroy();
        if (healthz === "starved") {
          return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
            status: "ok", eventLoop: { healthy: false, lagMeanMs: 900, lagP99Ms: 2000, utilization: 1, lastTickAgeMs: 50 },
          }));
        }
        held.add(res); // slow: never answers inside the probe's deadline
        return;
      }
      requests.push(`${req.method} ${url.split("?")[0]}`);
      req.resume();
      req.on("end", () => {
        if (url.startsWith("/api/stream/emit")) {
          if (emitHangs) { held.add(res); return; }
          return void res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ streamItemId: "s-1" }));
        }
        if (url.startsWith("/api/queue/create")) {
          return void res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ qitemId: "qitem-20261021000000-aaaa", state: "pending" }));
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end("[]");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    for (const res of held) res.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests.length = 0;
    healthz = "ok";
    emitHangs = false;
  });

  async function rig(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, OPENRIG_HOME: home, OPENRIG_URL: `http://127.0.0.1:${port}`, ...env };
    for (const key of ["RIGGED_HOME", "RIGGED_URL", "OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME"]) if (!(key in env)) delete childEnv[key];
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
    const child = spawn(process.execPath, [cliEntry, ...args], { env: childEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    const exit = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    const run = { stdout, stderr, exit, requests: [...requests] };
    console.log(`busy-daemon [${args.slice(0, 2).join(" ")} healthz=${healthz}] ${JSON.stringify(run)}`);
    return run;
  }

  for (const mode of ["unhealthy", "reset", "starved"] as const) {
    it(`a read completes when /healthz is ${mode}`, async () => {
      healthz = mode;
      const r = await rig(["stream", "list", "--json"]);
      expect(r.requests).toEqual(["GET /api/stream/list"]);
      expect(r.exit).toBe(0);
      expect(r.stderr).not.toContain("did not respond");
    }, 30_000);
  }

  it("a read completes when /healthz is slower than the probe's deadline", async () => {
    healthz = "slow";
    const r = await rig(["stream", "list", "--json"]);
    expect(r.requests).toEqual(["GET /api/stream/list"]);
    expect(r.exit).toBe(0);
  }, 30_000);

  it("a write is made exactly once against a busy daemon", async () => {
    healthz = "unhealthy";
    const r = await rig(["stream", "emit", "--source", "lead@build", "--body", "note", "--json"]);
    expect(r.requests).toEqual(["POST /api/stream/emit"]);
    expect(r.exit).toBe(0);
  }, 30_000);

  it("a write whose real request times out reports an unknown outcome and is sent once", async () => {
    healthz = "unhealthy";
    emitHangs = true;
    const r = await rig(["stream", "emit", "--source", "lead@build", "--body", "note"]);
    expect(r.requests).toEqual(["POST /api/stream/emit"]);
    expect(r.exit).toBe(1);
    expect(r.stderr).toContain("outcome is UNKNOWN");
    expect(r.stderr).toContain("before any retry");
    expect(r.stderr).not.toContain("not running");
  }, 30_000);

  it("a hand-written precheck (rig context list) also lets the real request run", async () => {
    healthz = "unhealthy";
    const r = await rig(["context", "list", "--json"]);
    expect(r.requests).toEqual(["GET /api/context-packs/library"]);
    expect(r.exit).toBe(0);
  }, 30_000);

  it("a local queue create reaches a busy daemon once", async () => {
    healthz = "unhealthy";
    const r = await rig(["queue", "create", "--destination", "worker@build", "--body", "b", "--summary", "s", "--json"], { OPENRIG_SESSION_NAME: "lead@build" });
    expect(r.requests).toEqual(["POST /api/queue/create"]);
    expect(r.exit).toBe(0);
  }, 30_000);

  it("a recorded daemon whose process is alive but whose /healthz fails gets the real request", async () => {
    // No OPENRIG_URL: the CLI reads daemon.json, finds the process alive and the health check failing.
    healthz = "unhealthy";
    const recorded = fs.mkdtempSync(path.join(os.tmpdir(), "busy-daemon-recorded-"));
    fs.writeFileSync(path.join(recorded, "daemon.json"), JSON.stringify({ pid: process.pid, port, host: "127.0.0.1", db: path.join(recorded, "x.sqlite"), startedAt: "2026-10-21T00:00:00.000Z" }));
    try {
      const r = await rig(["stream", "list", "--json"], { OPENRIG_HOME: recorded, OPENRIG_URL: undefined });
      expect(r.requests).toEqual(["GET /api/stream/list"]);
      expect(r.exit).toBe(0);
    } finally {
      fs.rmSync(recorded, { recursive: true, force: true });
    }
  }, 30_000);

  it("a daemon confirmed down keeps today's fast not-running refusal, and nothing is sent", async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    });
    const r = await rig(["stream", "list", "--json"], { OPENRIG_URL: `http://127.0.0.1:${closed}` });
    expect(r.exit).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("Daemon not running.");
    expect(r.requests).toEqual([]);
  }, 30_000);
});
