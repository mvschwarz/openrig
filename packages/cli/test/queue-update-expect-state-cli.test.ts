// `rig queue update --expect-state <state>` through the real CLI: a genuine `queueCommand` invocation talks over
// loopback HTTP to the real queueRoutes and QueueRepository on a migration-faithful test DB. A closer that read
// `pending` and closes with --expect-state pending after the destination claimed the row fails with
// qitem_state_changed and the current state, and the claim stays in place. A matching condition applies the update,
// and an update without the option behaves as before.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { coreSchema } from "../../daemon/src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../../daemon/src/db/migrations/003_events.js";
import { queueItemsSchema } from "../../daemon/src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../../daemon/src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../../daemon/src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../../daemon/src/db/migrations/027_outbox_entries.js";
import { queueTargetRepoSchema } from "../../daemon/src/db/migrations/039_queue_target_repo.js";
import { queueItemSummarySchema } from "../../daemon/src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../../daemon/src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { DaemonClient } from "../src/client.js";
import { queueCommand } from "../src/commands/queue.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

const DESTINATION = "dev-x@rig";
const CLOSER = "orch@rig";

let db: Database.Database;
let repo: QueueRepository;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let port = 0;

// Hermetic: the CLI resolves OPENRIG_URL / RIGGED_URL / OPENRIG_PORT before the injected state file, so they are
// removed for the CLI-invocation window only, and the client factory refuses any URL but this test's loopback.
const AMBIENT_KEYS = ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT"] as const;
const savedEnv: Record<string, string | undefined> = {};
function neutralizeAmbient(): void { for (const k of AMBIENT_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; } }
function restoreAmbient(): void { for (const k of AMBIENT_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } }

beforeAll(async () => {
  db = createDb();
  migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema, outboxEntriesSchema, queueTargetRepoSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
  const bus = new EventBus(db);
  repo = new QueueRepository(db, bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("queueRepo" as never, repo); await next(); });
  app.route("/api/queue", queueRoutes());
  await new Promise<void>((resolve) => { server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: { port: number }) => { port = info.port; resolve(); }); });
});

afterAll(async () => {
  restoreAmbient();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  db?.close();
});

function loopbackUrl(): string { return `http://127.0.0.1:${port}`; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deps(): any {
  return {
    lifecycleDeps: { spawn: () => ({ pid: 1, unref() {} }), fetch: async () => ({ ok: true }), kill: () => true, readFile: (p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port, host: "127.0.0.1", db: "x", startedAt: "x" }) : null), writeFile() {}, removeFile() {}, exists: (p: string) => p === STATE_FILE, mkdirp() {}, openForAppend: () => 3, isProcessAlive: () => true },
    clientFactory: (url: string) => {
      if (url !== loopbackUrl()) throw new Error(`test-isolation guard: clientFactory url '${url}' !== loopback '${loopbackUrl()}'`);
      return new DaemonClient(url);
    },
  };
}

async function runCli(args: string[]): Promise<{ out: string; exit: number | undefined }> {
  const out: string[] = [];
  const ol = console.log, oe = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  process.exitCode = undefined;
  neutralizeAmbient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  try { await queueCommand(deps() as any).parseAsync(["node", "rig", ...args]); }
  finally { restoreAmbient(); console.log = ol; console.error = oe; }
  const exit = process.exitCode; process.exitCode = 0;
  return { out: out.join("\n"), exit };
}

/** The stored row, through the repository's public read; a missing row fails the test. */
const row = (qitemId: string) => { const item = repo.getById(qitemId); if (!item) throw new Error(`row ${qitemId} not found`); return item; };
const transitions = (id: string) => (db.prepare("SELECT count(*) n FROM queue_transitions WHERE qitem_id = ?").get(id) as { n: number }).n;
const events = () => (db.prepare("SELECT count(*) n FROM events").get() as { n: number }).n;
const closeArgs = ["--state", "done", "--closure-reason", "no-follow-on", "--note", "closing: handled elsewhere"];

describe("rig queue update --expect-state", () => {
  let id: string;
  // The closer is a managed seat other than the destination: the actor comes from the seat env (X-OpenRig-Session).
  beforeEach(async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", CLOSER);
    id = (await repo.create({ sourceSession: CLOSER, destinationSession: DESTINATION, body: "work", nudge: false })).qitemId;
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([false, true])("the closer read pending, the destination claimed, and the conditional close fails with the code and the current state, leaving the claim (json=%s)", async (json) => {
    expect(row(id).state).toBe("pending"); // what the closer read
    repo.claim({ qitemId: id, destinationSession: DESTINATION });
    const before = row(id);
    const beforeTransitions = transitions(id), beforeEvents = events();

    const { out, exit } = await runCli(["update", id, "--expect-state", "pending", ...closeArgs, ...(json ? ["--json"] : [])]);

    expect(exit).toBe(1);
    expect(out).toContain("qitem_state_changed");
    expect(out).toContain("in-progress");
    if (json) expect(JSON.parse(out)).toMatchObject({ error: "qitem_state_changed", expectedState: "pending", currentState: "in-progress" });
    expect(row(id)).toEqual(before);
    expect(before).toMatchObject({ state: "in-progress", destinationSession: DESTINATION });
    expect(transitions(id)).toBe(beforeTransitions);
    expect(events()).toBe(beforeEvents);
  });

  it("a matching condition applies the close (exit 0)", async () => {
    const { exit } = await runCli(["update", id, "--expect-state", "pending", ...closeArgs, "--json"]);
    expect(exit).toBeFalsy();
    expect(row(id)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });

  it("without the option, the close after a claim applies as today (exit 0)", async () => {
    repo.claim({ qitemId: id, destinationSession: DESTINATION });
    const { exit } = await runCli(["update", id, ...closeArgs, "--json"]);
    expect(exit).toBeFalsy();
    expect(row(id)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
  });
});
