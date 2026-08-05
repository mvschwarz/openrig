// 51-06 D2 — REAL CLI acceptance boundary (Guard implementation-verdict correction). A genuine
// `queueCommand` invocation talks over LOOPBACK HTTP to the real candidate queueRoutes +
// QueueRepository, backed by a migration-faithful test DB (incl. 044 summary + 048 evidence_ref).
// No pre-baked response: if the daemon route/repo stopped rejecting (or mutated before responding),
// these tests would fail. Proves normal + --json reject, UNCHANGED item/transition/event state after
// the HTTP call, and the successful human-park control — all end to end.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

let db: Database.Database;
let bus: EventBus;
let repo: QueueRepository;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let port = 0;

// HERMETIC ISOLATION (Guard test-isolation binding): getDaemonStatus() resolves ambient
// OPENRIG_URL / RIGGED_URL (and OPENRIG_PORT) BEFORE the injected state file. The managed seat
// exports OPENRIG_URL=http://127.0.0.1:7433 (the canonical daemon), so without neutralizing these
// the CLI would talk to the real daemon, not this test's loopback repo. Save the originals, delete
// them so the injected state file supplies the fresh loopback port, and restore them in teardown
// even on failure. The env is neutralized only for the CLI-invocation window (runCli).
const AMBIENT_KEYS = ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT"] as const;
const savedEnv: Record<string, string | undefined> = {};
function neutralizeAmbient(): void { for (const k of AMBIENT_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; } }
function restoreAmbient(): void { for (const k of AMBIENT_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } }

beforeAll(async () => {
  db = createDb();
  migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema, outboxEntriesSchema, queueTargetRepoSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
  bus = new EventBus(db);
  repo = new QueueRepository(db, bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("queueRepo" as never, repo); await next(); });
  app.route("/api/queue", queueRoutes());
  await new Promise<void>((resolve) => { server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: { port: number }) => { port = info.port; resolve(); }); });
});

afterAll(async () => {
  restoreAmbient(); // belt: ensure ambient aliases are never left neutralized
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  db?.close();
});

function loopbackUrl(): string { return `http://127.0.0.1:${port}`; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deps(): any {
  return {
    // state file carries an explicit 127.0.0.1 host + the fresh loopback port, so getDaemonUrl()
    // yields exactly loopbackUrl() (with the aliases neutralized during runCli).
    lifecycleDeps: { spawn: () => ({ pid: 1, unref() {} }), fetch: async () => ({ ok: true }), kill: () => true, readFile: (p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port, host: "127.0.0.1", db: "x", startedAt: "x" }) : null), writeFile() {}, removeFile() {}, exists: (p: string) => p === STATE_FILE, mkdirp() {}, openForAppend: () => 3, isProcessAlive: () => true },
    clientFactory: (url: string) => {
      // SAFETY GUARD: refuse any URL that is not this test's fresh loopback, BEFORE constructing a
      // client or touching the network — makes accidental canonical-daemon contact impossible.
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
  neutralizeAmbient(); // bind CLI status resolution to the injected loopback state file
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  try { await queueCommand(deps() as any).parseAsync(["node", "rig", ...args]); }
  finally { restoreAmbient(); console.log = ol; console.error = oe; }
  const exit = process.exitCode; process.exitCode = 0;
  return { out: out.join("\n"), exit };
}

const txnCount = (id: string) => (db.prepare("SELECT count(*) c FROM queue_transitions WHERE qitem_id = ?").get(id) as { c: number }).c;
const eventCount = () => (db.prepare("SELECT count(*) c FROM events").get() as { c: number }).c;

describe("51-06 D2 — real CLI->loopback HTTP->queueRoutes/QueueRepository acceptance", () => {
  let id: string;
  beforeEach(async () => { id = (await repo.create({ sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "e2e" })).qitemId; });

  it("normal: --summary on a non-park update -> real 400, nonzero exit, item/transition/event UNCHANGED", async () => {
    const beforeTxns = txnCount(id), beforeEvents = eventCount();
    const { out, exit } = await runCli(["update", id, "--actor", "dev-x@rig", "--state", "in-progress", "--summary", "DROPME"]);
    expect(exit).toBe(1);
    expect(out).toContain("summary_evidence_not_persistable");
    expect(out).toContain("invalidFields");
    // unchanged item/metadata/transition/event state AFTER the real HTTP call
    const item = repo.getByIdOrThrow(id);
    expect(item.state).toBe("pending");
    expect(item.summary).toBeNull();
    expect(txnCount(id)).toBe(beforeTxns);
    expect(eventCount()).toBe(beforeEvents);
  });

  it("--json: same reject as structured JSON with nonzero exit, state UNCHANGED", async () => {
    const { out, exit } = await runCli(["update", id, "--actor", "dev-x@rig", "--state", "in-progress", "--evidence-ref", "/e.md", "--json"]);
    expect(exit).toBe(1);
    const body = JSON.parse(out) as { error: string; invalidFields?: string[] };
    expect(body.error).toBe("summary_evidence_not_persistable");
    expect(body.invalidFields).toEqual(["evidenceRef"]);
    expect(repo.getByIdOrThrow(id).evidenceRef).toBeNull();
  });

  it("CONTROL: real-CLI human-seat park PERSISTS summary + evidence (exit 0)", async () => {
    const { exit } = await runCli(["update", id, "--actor", "orch@rig", "--state", "blocked", "--blocked-on", "human@kernel", "--summary", "PARK-KEEP", "--evidence-ref", "/proof/park.md"]);
    expect(exit).toBeFalsy(); // success
    const item = repo.getByIdOrThrow(id);
    expect(item.summary).toBe("PARK-KEEP");
    expect(item.evidenceRef).toBe("/proof/park.md");
  });
});
