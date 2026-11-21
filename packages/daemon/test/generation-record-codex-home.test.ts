import { afterAll, afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ProcessCensus } from "../src/domain/process-census.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";

// Set the daemon home before importing the route, including its old module-scoped resolver.
// Only process/pane observations are scripted; both native SQLite lookups and the HTTP route are real.
const homes = await vi.hoisted(async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generation-codex-home-"));
  const daemon = path.join(root, "daemon"); fs.mkdirSync(daemon);
  const previous = process.env.CODEX_HOME; process.env.CODEX_HOME = daemon;
  return { root, daemon, previous };
});
afterAll(() => {
  if (homes.previous === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = homes.previous;
  rmSync(homes.root, { recursive: true, force: true });
});
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
  rmSync(homes.daemon, { recursive: true, force: true }); mkdirSync(homes.daemon);
});
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const startedAt = "Sun Sep  6 23:52:32 2026", start = Math.floor(Date.parse(startedAt) / 1000);
type Selection = "account" | "member" | "rig" | "daemon";

function nativeRecords(home: string, id: string) {
  mkdirSync(home, { recursive: true });
  const logs = new Database(join(home, "logs_2.sqlite"));
  logs.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, process_uuid TEXT, thread_id TEXT)");
  logs.prepare("INSERT INTO logs (ts,ts_nanos,process_uuid,thread_id) VALUES (?,0,'pid:20:fixture',?)").run(start + 1, id);
  logs.close();
  const state = new Database(join(home, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)");
  // The same UUID exists in each home's state DB: using the right logs but an unqualified state lookup is insufficient.
  for (const thread of [A, B]) {
    const file = join(home, `${thread}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: thread } }) + "\n"
      + JSON.stringify({ marker: home }) + "\n");
    state.prepare("INSERT INTO threads VALUES (?,'cli',?)").run(thread, file);
  }
  state.close();
}

function fixture(selection: Selection = "member") {
  const root = mkdtempSync(join(homes.root, "seat-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = { account: join(root, "account"), member: join(root, "member"), rig: join(root, "rig"), daemon: homes.daemon };
  for (const [key, home] of Object.entries(paths)) nativeRecords(home, key === selection ? A : B);
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const repo = new RigRepository(db), rig = repo.createRig("generation-home"), node = repo.addNode(rig.id, "worker", { runtime: "codex" });
  if (selection !== "daemon") db.prepare("UPDATE rigs SET env_json=? WHERE id=?").run(JSON.stringify({ CODEX_HOME: paths.rig }), rig.id);
  if (selection === "member" || selection === "account") db.prepare("UPDATE nodes SET env_json=? WHERE id=?").run(JSON.stringify({ CODEX_HOME: paths.member }), node.id);
  if (selection === "account") db.prepare("UPDATE nodes SET account_home=? WHERE id=?").run(paths.account, node.id);
  const registry = new SessionRegistry(db), sessionName = "worker@generation-home";
  const session = registry.registerSession(node.id, sessionName); registry.updateStatus(session.id, "running");
  registry.updateResumeToken(session.id, "codex_id", B); // The saved token is deliberately not the live thread.
  registry.updateBinding(node.id, { tmuxSession: sessionName, tmuxPane: "%1" });
  new SeatIdentityStore(db).upsert({ nodeId: node.id, sessionName, verdict: "verified", evidenceSource: "pane_process", reason: null,
    observedAt: new Date().toISOString(), evidence: { registeredPane: "%1", observedPanePid: 10, observedPid: 20, observedCommand: "codex", matchedLayer: 1 } });
  const processes = [{ pid: 10, ppid: 1, command: "zsh", startedAt }, { pid: 20, ppid: 10, command: "codex", startedAt }];
  const census = vi.spyOn(ProcessCensus.prototype, "list").mockImplementation(async () => processes);
  const tmux = { getPanePid: vi.fn(async () => 10) };
  const store = new ContextUsageStore(db, { stateDir: root, codexHome: homes.daemon });
  const app = new Hono(); app.use("*", async (c, next) => {
    for (const [key, value] of Object.entries({ sessionRegistry: registry, tmuxAdapter: tmux, contextUsageStore: store, terminalBearerToken: "fixture-token" })) c.set(key as never, value as never);
    await next();
  }); app.route("/api/sessions", sessionAdminRoutes);
  const request = () => app.request(`/api/sessions/${sessionName}/generation-record?sinceBytes=0`, { headers: { authorization: "Bearer fixture-token" } });
  const editLogs = (sql: string) => { const logs = new Database(join(paths[selection], "logs_2.sqlite")); try { logs.exec(sql); } finally { logs.close(); } };
  return { db, node, paths, selectedHome: paths[selection], request, editLogs, processes, census, tmux, registry, sessionName, store };
}

it.each(["account", "member", "rig", "daemon"] as const)("reads the %s home with existing precedence and qualifies the transcript to that same home", async selection => {
  const f = fixture(selection), response = await f.request(), body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body.sessionId).toBe(A);
  expect(body.suffix).toContain(JSON.stringify({ marker: f.selectedHome }));
  for (const home of Object.values(f.paths)) if (home !== f.selectedHome) expect(body.suffix).not.toContain(home);
});

it.each(["old rows", "missing start", "no rows"] as const)("does not use the daemon home or the saved resume token when selected-home proof has %s", async condition => {
  const f = fixture();
  if (condition === "old rows") f.editLogs(`UPDATE logs SET ts=${start - 1}`);
  if (condition === "missing start") f.processes[1]!.startedAt = "";
  if (condition === "no rows") f.editLogs("DELETE FROM logs");
  const response = await f.request(), body = await response.json();
  expect(response.status).toBe(409); expect(body.error).toBe("record_identity_unverified"); expect(body.suffix).toBeUndefined();
});

it("does not accept two current threads under the bound pane", async () => {
  const f = fixture(); f.processes.push({ pid: 21, ppid: 10, command: "codex", startedAt });
  f.editLogs(`INSERT INTO logs (ts,ts_nanos,process_uuid,thread_id) VALUES (${start + 1},0,'pid:21:fixture','${B}')`);
  const response = await f.request(), body = await response.json();
  expect(response.status).toBe(409); expect(body.message).toContain("multiple codex threads"); expect(body.suffix).toBeUndefined();
});

it.each(["pane pid", "verified native pid", "occupant", "binding"] as const)("keeps the %s identity check", async changed => {
  const f = fixture();
  if (changed === "pane pid") f.tmux.getPanePid.mockResolvedValue(11);
  if (changed === "verified native pid") f.db.prepare("UPDATE seat_identity_verdicts SET observed_pid=99 WHERE node_id=?").run(f.node.id);
  if (changed === "occupant" || changed === "binding") f.census.mockImplementation(async () => {
    if (changed === "occupant") f.registry.mintOccupantTenure(f.node.id, "handover", "successor-native-id");
    else f.registry.updateBinding(f.node.id, { tmuxSession: f.sessionName, tmuxPane: "%2" });
    return f.processes;
  });
  const response = await f.request(), body = await response.json();
  expect(response.status).toBe(409); expect(body.error).toBe("record_identity_unverified"); expect(body.suffix).toBeUndefined();
});

it("still verifies the opened record's native identity", async () => {
  const f = fixture(); writeFileSync(join(f.selectedHome, `${A}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: B } }) + "\n");
  const response = await f.request(), body = await response.json();
  expect(response.status).toBe(409); expect(body.error).toBe("record_identity_mismatch"); expect(body.suffix).toBeUndefined();
});

it("does not fall back to a copied state row when the selected home's retained CLI identity row is missing", async () => {
  const f = fixture(), state = new Database(join(f.selectedHome, "state_5.sqlite"));
  try { state.exec("DELETE FROM threads"); } finally { state.close(); }
  const response = await f.request(), body = await response.json();
  expect(response.status).toBe(409); expect(body.error).toBe("record_identity_unverified"); expect(body.suffix).toBeUndefined();
});
