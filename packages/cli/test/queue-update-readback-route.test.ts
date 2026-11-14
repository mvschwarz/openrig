// A verified `rig queue update` prints the canonical row it read back, and keeps what only the write's response carries:
// the park advisory (#2739). A real `queueCommand` talks over loopback HTTP to the real queueRoutes and QueueRepository,
// so the POST and the GET that reads it back are the daemon's own.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { DaemonClient } from "../src/client.js";
import { queueCommand } from "../src/commands/queue.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

let db: Database.Database;
let repo: QueueRepository;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let port = 0;

beforeAll(async () => {
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  repo = new QueueRepository(db, bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("queueRepo" as never, repo); await next(); });
  app.route("/api/queue", queueRoutes());
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: { port: number }) => { port = info.port; resolve(); });
  });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  db?.close();
});

beforeEach(() => {
  // A seat, on this host's own daemon: the CLI stamps it as the sender. Ambient endpoints would win over the state file.
  vi.stubEnv("OPENRIG_SESSION_NAME", "dev-x@rig");
  vi.stubEnv("TMUX_PANE", "");
  for (const key of ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT"]) vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());

async function runCli(args: string[]): Promise<{ out: string; err: string; exit: number | undefined }> {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log, oe = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
  process.exitCode = undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueCommand({
      lifecycleDeps: {
        spawn: () => ({ pid: 1, unref() {} }), fetch: async () => ({ ok: true }), kill: () => true,
        readFile: (p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port, host: "127.0.0.1", db: "x", startedAt: "x" }) : null),
        writeFile() {}, removeFile() {}, exists: (p: string) => p === STATE_FILE, mkdirp() {}, openForAppend: () => 3, isProcessAlive: () => true,
      },
      clientFactory: (url: string) => new DaemonClient(url),
    } as any).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = ol;
    console.error = oe;
  }
  const exit = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join("\n"), err: err.join("\n"), exit };
}

async function claimedRow(): Promise<string> {
  const row = await repo.create({ sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "work", nudge: false });
  repo.claim({ qitemId: row.qitemId, destinationSession: "dev-x@rig" });
  return row.qitemId;
}

const park = (id: string) => ["update", id, "--state", "blocked", "--blocked-on", "external:vendor-fix", "--note", "waiting on the vendor"];

describe("a verified queue update keeps the write's park advisory", () => {
  it.each([
    ["the compact JSON receipt", "true", ["--json"]],
    ["the full JSON row", "false", ["--json"]],
    ["the full row with --full", "true", ["--full", "--json"]],
  ] as const)("in %s", async (_label, compact, flags) => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", compact);
    const id = await claimedRow();
    const { out, err, exit } = await runCli([...park(id), ...flags]);

    expect(exit, err).toBeFalsy();
    const printed = JSON.parse(out) as { state?: string; advisories?: Array<{ code?: string }> };
    expect(printed.advisories).toEqual([expect.objectContaining({ code: "park_without_wake" })]);
    expect(repo.getByIdOrThrow(id)).toMatchObject({ state: "blocked", blockedOn: "external:vendor-fix" });
  });

  it("in the compact text receipt", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "true");
    const id = await claimedRow();
    const { out, err, exit } = await runCli(park(id));

    expect(exit, err).toBeFalsy();
    expect(out).toMatch(/advisory: No wake is set for this park/);
  });

  it("and a park with a wake carries none", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "true");
    const id = await claimedRow();
    const { out, err, exit } = await runCli([...park(id), "--wake-after", "10m", "--json"]);

    expect(exit, err).toBeFalsy();
    expect((JSON.parse(out) as { advisories?: unknown }).advisories).toBeUndefined();
  });
});
