// Due parked-row reminders for one seat, through the daemon's own composition: `createDaemon`'s scheduler, policy
// engine and watchdog delivery, down to the session transport's `send`, which is the only stub. Timers are made due by
// moving their recorded start back in the store; nothing fires at a live seat.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDaemon } from "../src/startup.js";
import type { AppDeps } from "../src/server.js";
import type { CmuxTransportFactory } from "../src/terminal/cmux-transport.js";
import type { ExecFn } from "../src/domain/tmux-adapter.js";

let db: Database.Database;
let deps: AppDeps;
let scratch: string;
const savedEnv: Record<string, string | undefined> = {};
const sends: Array<{ session: string; text: string }> = [];

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "park-digest-"));
  for (const k of ["OPENRIG_HOME", "OPENRIG_DB", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_NO_KERNEL"]) savedEnv[k] = process.env[k];
  process.env.OPENRIG_HOME = path.join(scratch, "home");
  process.env.OPENRIG_DB = path.join(scratch, "daemon.sqlite");
  delete process.env.OPENRIG_URL;
  delete process.env.OPENRIG_PORT;
  process.env.OPENRIG_NO_KERNEL = "1";
  const cmuxFactory: CmuxTransportFactory = async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); };
  const tmuxExec: ExecFn = async () => "";
  const result = await createDaemon({ cmuxFactory, tmuxExec, dbPath: process.env.OPENRIG_DB! });
  db = result.db;
  deps = result.deps;
  vi.spyOn(deps.sessionTransport, "send").mockImplementation(async (session: string, text: string) => {
    sends.push({ session, text });
    return { ok: true, sessionName: session, verified: true } as never;
  });
}, 60000);

afterAll(() => {
  deps?.watchdogScheduler?.stop?.();
  db?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => { sends.length = 0; });

let seq = 0;
/** A seat in a real rig, so the queue accepts it as a destination. */
function seat(): string {
  const rigName = `digest${++seq}`;
  const rig = deps.rigRepo.createRig(rigName);
  const node = deps.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
  const session = `dev-impl@${rigName}`;
  deps.sessionRegistry.registerSession(node.id, session);
  return session;
}

/** A row parked by its owner with an ordinary `--wake-after` timer; returns the row and its timer's job id. */
async function park(owner: string, summary: string, wakeAfterSeconds = 600) {
  const row = await deps.queueRepo.create({ sourceSession: "orch@rig", destinationSession: owner, body: `work ${++seq}`, summary, nudge: false } as never) as unknown as { qitemId: string };
  deps.queueRepo.update({ qitemId: row.qitemId, actorSession: owner, state: "blocked", blockedOn: "external:wait",
    transitionNote: "parked", wakeAfterSeconds } as never);
  const jobId = deps.queueRepo.getParkWakeStatus(row.qitemId)!.ref;
  return { qitemId: row.qitemId, jobId };
}

/** Make a timer due now, as though its interval had passed. */
function due(jobId: string) {
  const past = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare("UPDATE watchdog_jobs SET last_evaluation_at = ?, registered_at = ? WHERE job_id = ?").run(past, past, jobId);
}

describe("due parked-row reminders for one seat", () => {
  it("arrive as one message per scheduler pass, naming every row", async () => {
    const owner = seat();
    const rows = [await park(owner, "first wait"), await park(owner, "second wait"), await park(owner, "third wait")];
    for (const r of rows) due(r.jobId);
    await deps.watchdogScheduler!.runTickNow();
    const toOwner = sends.filter((s) => s.session === owner);
    expect(toOwner).toHaveLength(1);
    for (const r of rows) expect(toOwner[0]!.text).toContain(r.qitemId);
  });
});
