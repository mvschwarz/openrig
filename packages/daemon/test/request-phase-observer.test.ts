import { afterEach, expect, it, vi } from "vitest";
import { createServer, get } from "node:http";
import { EventEmitter, once } from "node:events";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { getRequestListener } from "@hono/node-server";
import Database from "better-sqlite3";
import { RequestPhaseObserver, inventoryAttemptId, inventoryDiagnosticRoute, observeInventoryHandler } from "../src/domain/request-phase-observer.js";
import { trackHttpServerResponses } from "../src/daemon-shutdown.js";
import { EventLoopMonitor } from "../src/domain/event-loop-monitor.js";
import { rigsRoutes } from "../src/routes/rigs.js";
import { RigRepository } from "../src/domain/rig-repository.js";

const token = "11111111-1111-4111-8111-111111111111";
const header = "X-OpenRig-Diagnostic-Attempt";
const dirs: string[] = [];
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); vi.restoreAllMocks(); for (const p of dirs.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function scratch() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-observer-")); dirs.push(dir); return dir; }
function recorder() { const records: Array<Record<string, any>> = []; return { records, sink: { recordDiagnostic: (r: Record<string, unknown>) => { records.push(r); return true; } } }; }
async function listen(app: Hono, observer: RequestPhaseObserver) {
  const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
  trackHttpServerResponses(server, observer.observeRequest);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanups.push(async () => { observer.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function database(file = ":memory:") {
  const db = new Database(file, { timeout: 2000 });
  db.exec("CREATE TABLE rigs(id TEXT PRIMARY KEY,name TEXT,created_at TEXT,updated_at TEXT,archived_at TEXT); INSERT INTO rigs VALUES('r','fixture','2026-01-01','2026-01-01',NULL)");
  cleanups.push(() => { if (db.open) db.close(); }); return db;
}
function stubPair(id = token) {
  const req = Object.assign(new EventEmitter(), { method: "GET", url: "/api/rigs", rawHeaders: [header, id] });
  const res = Object.assign(new EventEmitter(), { statusCode: 200, headersSent: true, writableFinished: true });
  return { req, res };
}

it("accepts one bounded token only on the inventory routes; malformed diagnostics cannot gate a request", () => {
  expect(inventoryAttemptId([header, token])).toBe(token);
  for (const headers of [[header, token, header, token], [header, token.toUpperCase().replace("1111", "AAAA")], [header, "x".repeat(10000)], [header, ""], [header, token + " "]]) expect(inventoryAttemptId(headers)).toBeUndefined();
  expect(inventoryDiagnosticRoute("GET", "/api/rigs?includeArchived=true")).toBe("rigs_list");
  expect(inventoryDiagnosticRoute("GET", "/api/rigs/private-name/nodes")).toBe("rig_nodes");
  for (const [method, url] of [["POST", "/api/rigs"], ["GET", "/healthz"], ["GET", "/api/rigs/a/nodes/b"], ["GET", "/api/ps"]]) expect(inventoryDiagnosticRoute(method, url)).toBeNull();
});

it("observes actual root handler and SQLite boundaries, response finish, and normal close separately", async () => {
  const { records, sink } = recorder(); const observer = new RequestPhaseObserver(sink);
  const app = new Hono(); app.use("*", observer.middleware());
  const repo = new RigRepository(database());
  app.use("*", async (c, next) => { c.set("rigRepo", repo); await next(); }); app.route("/api/rigs", rigsRoutes);
  const url = await listen(app, observer);
  const response = await fetch(url + "/api/rigs", { headers: { [header]: token } });
  expect(response.status).toBe(200); expect((await response.json())[0].name).toBe("fixture");
  await vi.waitFor(() => expect(records.some(r => r.phase === "response_close")).toBe(true));
  const joined = records.filter(r => r.attemptId === token);
  expect(joined.map(r => r.phase)).toEqual(["node_arrival", "hono_enter", "handler_enter", "sql_begin", "sql_end", "handler_exit", "hono_exit", "response_finish", "response_close"]);
  expect(new Set(joined.map(r => r.serverRequestId)).size).toBe(1);
  expect(joined.at(-1)).toMatchObject({ status: 200, headersSent: true, writableFinished: true });
  expect(joined.every(r => r.requestElapsedMs >= 0)).toBe(true);
  const count = records.length;
  expect((await fetch(url + "/api/rigs")).status).toBe(200);
  expect(records.length).toBe(count); // Untokened traffic produces no detailed records.
});

it("distinguishes a pre-handler barrier from a handler barrier without changing the returned body", async () => {
  const { records, sink } = recorder(); const observer = new RequestPhaseObserver(sink);
  const pre = deferred(), entered = deferred(), handler = deferred(), inHandler = deferred();
  cleanups.push(() => { pre.resolve(); handler.resolve(); });
  const app = new Hono(); app.use("*", observer.middleware());
  app.use("*", async (_c, next) => { entered.resolve(); await pre.promise; await next(); });
  app.get("/api/rigs", observeInventoryHandler, async c => { inHandler.resolve(); await handler.promise; return c.json(["unchanged"]); });
  const url = await listen(app, observer);
  const response = fetch(url + "/api/rigs", { headers: { [header]: token } });
  await entered.promise;
  expect(records.filter(r => r.attemptId).map(r => r.phase)).toEqual(["node_arrival", "hono_enter"]);
  pre.resolve(); await inHandler.promise;
  expect(records.at(-1)?.phase).toBe("handler_enter");
  handler.resolve(); expect(await (await response).json()).toEqual(["unchanged"]);
});

it("places a real private SQLite lock wait inside the root query span", async () => {
  const file = path.join(scratch(), "locked.sqlite"); const repo = new RigRepository(database(file));
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const DB=require(workerData.module); const db=new DB(workerData.file); db.exec('BEGIN EXCLUSIVE'); parentPort.postMessage('locked'); setTimeout(()=>{db.exec('COMMIT');db.close();},200);`, { eval: true, workerData: { file, module: createRequire(import.meta.url).resolve("better-sqlite3") } });
  cleanups.push(() => worker.terminate()); await once(worker, "message");
  const phases: Array<{ phase: string; at: number }> = [];
  expect(repo.listRigs(undefined, phase => phases.push({ phase, at: performance.now() }))[0]?.name).toBe("fixture");
  expect(phases.map(p => p.phase)).toEqual(["begin", "end"]);
  expect(phases[1]!.at - phases[0]!.at).toBeGreaterThan(75);
  expect(repo.listRigs(undefined, () => { throw Error("observer"); })[0]?.name).toBe("fixture");
  repo.db.close(); // The original query error survives a throwing diagnostic callback.
  expect(() => repo.listRigs(undefined, () => { throw Error("observer"); })).toThrow();
});

it("records premature response close then late handler completion without calling it a finished response", async () => {
  const { records, sink } = recorder(); const observer = new RequestPhaseObserver(sink);
  const entered = deferred(), release = deferred(); cleanups.push(() => release.resolve());
  const app = new Hono(); app.use("*", observer.middleware());
  app.get("/api/rigs", observeInventoryHandler, async c => { entered.resolve(); await release.promise; return c.json([]); });
  const url = await listen(app, observer);
  const request = get(url + "/api/rigs", { headers: { [header]: token } }); request.on("error", () => {});
  await entered.promise; request.destroy();
  await vi.waitFor(() => expect(records.find(r => r.phase === "response_close")).toMatchObject({ writableFinished: false, headersSent: false }));
  expect(records.some(r => r.phase === "response_finish")).toBe(false);
  release.resolve(); await vi.waitFor(() => expect(records.some(r => r.phase === "handler_exit")).toBe(true));
});

it("observes an abort during the body separately from headers and keeps the original status", async () => {
  const { records, sink } = recorder(); const observer = new RequestPhaseObserver(sink);
  const app = new Hono(); app.use("*", observer.middleware());
  app.get("/api/rigs", observeInventoryHandler, () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("[")); } }), { status: 202 }));
  const url = await listen(app, observer); const abort = new AbortController();
  const response = await fetch(url + "/api/rigs", { signal: abort.signal, headers: { [header]: token } });
  expect(response.status).toBe(202); const reader = response.body!.getReader(); await reader.read(); abort.abort();
  await expect(reader.read()).rejects.toThrow();
  await vi.waitFor(() => expect(records.find(r => r.phase === "response_close")).toMatchObject({ status: 202, headersSent: true, writableFinished: false }));
});

it("isolates observer exceptions from gate, handler and query outcomes", async () => {
  const observer = new RequestPhaseObserver({ recordDiagnostic: () => { throw Error("diagnostic unavailable"); } });
  const app = new Hono(); app.use("*", observer.middleware());
  app.use("*", async (c, next) => { if (c.req.query("deny")) return c.json({ denied: true }, 403); await next(); });
  app.get("/api/rigs", observeInventoryHandler, () => { throw Error("handler failure"); });
  app.onError((_e, c) => c.json({ failed: true }, 503));
  const url = await listen(app, observer);
  expect((await fetch(url + "/api/rigs?deny=1", { headers: { [header]: token } })).status).toBe(403);
  const response = await fetch(url + "/api/rigs", { headers: { [header]: token } });
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ failed: true });
});

it("bounds concurrent traces, expires observation only, distinguishes duplicate tokens, and omits private fields", () => {
  let mono = 100; let wall = "2026-01-01T00:00:00Z";
  const { records, sink } = recorder(); const observer = new RequestPhaseObserver(sink, () => mono, () => wall);
  const pairs = Array.from({ length: 129 }, () => stubPair());
  pairs[0]!.req.url += "?private=private-marker"; pairs[0]!.req.rawHeaders.push("Authorization", "private-marker", "X-OpenRig-Session", "private-marker");
  for (const p of pairs) observer.observeRequest(p.req, p.res);
  expect(records.filter(r => r.phase === "node_arrival")).toHaveLength(128);
  expect(new Set(records.filter(r => r.phase === "node_arrival").map(r => r.serverRequestId)).size).toBe(128);
  mono += 60_001; wall = "2000-01-01T00:00:00Z"; observer.tick(mono, 100);
  expect(records.filter(r => r.phase === "trace_expired")).toHaveLength(128);
  expect(pairs[0]!.res.listenerCount("close")).toBe(0);
  expect(records.at(-1)).toMatchObject({ expired: 128, rejected: 1 });
  expect(records.find(r => r.phase === "event_loop_gap")).toMatchObject({ gapMs: 60_001, utc: wall });
  expect(records.filter(r => r.requestElapsedMs !== undefined).every(r => r.requestElapsedMs >= 0)).toBe(true);
  observer.observeRequest(pairs[128]!.req, pairs[128]!.res);
  expect(records.filter(r => r.phase === "node_arrival")).toHaveLength(129);
  pairs[128]!.res.emit("finish"); pairs[128]!.res.emit("close");
  expect(JSON.stringify(records)).not.toContain("private-marker");
  observer.close(); expect(records.at(-1)).toMatchObject({ phase: "stopped", incompleteActive: 0 });
});

it("uses the existing event-loop tick without changing health snapshot semantics", () => {
  let mono = 0; let wall = 1000; const tick = vi.fn(() => { throw Error("sink failure"); });
  const monitor = new EventLoopMonitor({ autoStart: false, now: () => wall, monotonicNow: () => mono, onTick: tick });
  mono = 700; wall = 800; monitor.recordTick();
  expect(tick).toHaveBeenCalledWith(700, 0); expect(monitor.snapshot().lastTickAgeMs).toBe(0); monitor.stop();
});
