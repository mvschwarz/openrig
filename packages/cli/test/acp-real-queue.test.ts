// rig acp against the real queue: the daemon's queueRoutes and QueueRepository over a fully migrated test DB, on
// loopback, with the fake ACP agent. The documented permission answer runs through the real `rig queue update`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createFullTestDb } from "../../daemon/test/helpers/test-app.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import { queueCommand } from "../src/commands/queue.js";
import { daemonAcpQueue } from "../src/commands/acp.js";
import { answerCommand, runAcpAssignment } from "../src/acp/connector.js";

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const SEAT = "builder@studio";
let db: Database.Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let port = 0;
let dir = "";
const url = () => `http://127.0.0.1:${port}`;

beforeAll(async () => {
  db = createFullTestDb();
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("queueRepo" as never, repo); await next(); });
  app.route("/api/queue", queueRoutes());
  await new Promise<void>((resolve) => { server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: { port: number }) => { port = info.port; resolve(); }); });
  dir = mkdtempSync(join(tmpdir(), "acp-real-queue-"));
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** `rig queue …` as the seat would type it, bound to this test's loopback daemon (never the ambient one). */
async function rigQueue(args: string[]): Promise<{ out: string; exit: number | undefined }> {
  const out: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  const ambient = ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT"].map((key) => [key, process.env[key]] as const);
  for (const [key] of ambient) delete process.env[key];
  process.exitCode = undefined;
  const deps = {
    lifecycleDeps: { spawn: () => ({ pid: 1, unref() {} }), fetch: async () => ({ ok: true }), kill: () => true, readFile: (p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port, host: "127.0.0.1", db: "x", startedAt: "x" }) : null), writeFile() {}, removeFile() {}, exists: (p: string) => p === STATE_FILE, mkdirp() {}, openForAppend: () => 3, isProcessAlive: () => true },
    clientFactory: (target: string) => { if (target !== url()) throw new Error(`test isolation: ${target} isn't the loopback daemon`); return new DaemonClient(target); },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  try { await queueCommand(deps as any).parseAsync(["node", "rig", ...args]); } finally {
    for (const [key, value] of ambient) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    console.log = log; console.error = error;
  }
  const exit = process.exitCode; process.exitCode = 0;
  return { out: out.join("\n"), exit };
}

const row = (id: string) => db.prepare("SELECT state, resolution, closure_reason FROM queue_items WHERE qitem_id = ?").get(id) as { state: string; resolution: string | null; closure_reason: string | null };
const pendingAsks = () => (db.prepare("SELECT qitem_id FROM queue_items WHERE tags LIKE '%acp-permission%' AND state = 'pending'").all() as Array<{ qitem_id: string }>).map((r) => r.qitem_id);
const notes = (id: string) => (db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid").all(id) as Array<{ transition_note: string | null }>).map((r) => r.transition_note ?? "");

describe("rig acp with the real queue", () => {
  it("the documented answer closes the permission row and reaches the agent; the outcome stays a note on the open row", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", SEAT);
    try {
      const queue = daemonAcpQueue(new DaemonClient(url()));
      const task = await queue.create({ destination: SEAT, body: "scenario:permission", summary: "a task for the agent", tags: ["mission:demo"] });
      let answered: { out: string; exit: number | undefined } | undefined;
      const answering = setInterval(() => {
        const [ask] = pendingAsks();
        if (!ask || answered) return;
        answered = { out: "", exit: undefined };
        // Exactly the command the permission row and the help advertise.
        void rigQueue(answerCommand(ask).replace("<optionId>", "allow-once").split(" ").slice(2)).then((result) => { answered = result; });
      }, 10);
      const outcome = await runAcpAssignment(queue, { qitemId: task, agent: [process.execPath, FAKE_AGENT], cwd: dir, self: SEAT, runId: `acp-real-${process.pid}`, logPath: join(dir, "run.jsonl"), pollMs: 20, exitWaitMs: 2000 });
      clearInterval(answering);
      expect(answered?.exit ?? 0).toBe(0);
      expect(outcome).toMatchObject({ kind: "completed", text: "permission allow-once" });
      const [askId] = (db.prepare("SELECT qitem_id FROM queue_items WHERE tags LIKE '%acp-permission%'").all() as Array<{ qitem_id: string }>).map((r) => r.qitem_id);
      expect(row(askId!)).toEqual({ state: "done", resolution: "allow-once", closure_reason: "no-follow-on" });
      expect(row(task)).toMatchObject({ state: "in-progress", resolution: null });
      expect(notes(task).some((note) => note.startsWith("ACP run ") && note.includes(" outcome completed: "))).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });

  it("the queue refuses a done without a closure reason, which is why the advertised command carries one", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", SEAT);
    try {
      const ask = await daemonAcpQueue(new DaemonClient(url())).create({ destination: SEAT, body: "a permission row", summary: "permission", tags: ["acp-permission"] });
      const refused = await rigQueue(["update", ask, "--state", "done", "--resolution", "allow-once"]);
      expect(refused.exit).not.toBe(0);
      expect(refused.out).toContain("missing_closure_reason");
      expect(row(ask)).toMatchObject({ state: "pending", resolution: null });
    } finally { vi.unstubAllEnvs(); }
  });
});
