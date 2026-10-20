// #1642 discriminator: what a cross-host `rig queue create` actually does, end to end. The compiled CLI
// runs as its own process against two real daemon apps on local ports: the sender's daemon and a
// receiver standing in for the remote host. Each run records stdout, stderr, the process exit status,
// the requests the receiver saw and the rows in both stores, separately, so a wrong prediction about
// any one of them shows up as that one field.
//
// The sender's registry names the receiver as `remote-vm` with no `hostId`; the CLI's learned bindings
// (written by `rig host doctor`) map `remote-vm` to the receiver's self-id. That is the shape where the
// self-id spelling of the destination is known only to the CLI.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";

const cliEntry = path.join(__dirname, "..", "dist", "index.js");
const SENDER = "lead@build";
const ALIAS = "remote-vm";
const SELF_ID = "host-5f2e9c1a";
const REMOTE_SEAT = "lead@delivery";

interface Daemon { db: Database.Database; server: ServerType; url: string; requests: string[] }

interface RunRecord {
  stdout: string;
  stderr: string;
  exit: number | null;
  receiverRequests: string[];
  senderRows: number;
  receiverRows: number;
}

function rows(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) c FROM queue_items").get() as { c: number }).c;
}

async function startDaemon(validateRig: (ref: string) => boolean): Promise<Daemon> {
  const db = createDb(":memory:");
  migrate(db, ALL_MIGRATIONS);
  const inert = async () => ({ ok: false, error: "inert fixture" });
  const { app } = createTestApp(db, {
    appDeps: {
      sessionTransport: { resolveSessions: async () => ({ ok: false, code: "not_found", error: "inert fixture" }), send: inert, capture: inert, broadcast: inert } as never,
      queueRepo: new QueueRepository(db, new EventBus(db), { validateRig }),
    },
  });
  const requests: string[] = [];
  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({
      fetch: (req, env) => {
        requests.push(`${req.method} ${new URL(req.url).pathname}`);
        return app.fetch(req, env);
      },
      port: 0,
      hostname: "127.0.0.1",
    }, () => resolve(s));
  });
  return { db, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

describe.skipIf(!fs.existsSync(cliEntry))("#1642 discriminator: cross-host queue create through the compiled CLI", () => {
  let home: string;
  let sender: Daemon;
  let receiver: Daemon;
  const savedHome = process.env.OPENRIG_HOME;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-host-qualifier-"));
    // The in-process daemons read hosts.yaml from OPENRIG_HOME at request time, as an installed one does.
    process.env.OPENRIG_HOME = home;
    // The sender's topology knows only its own rig, like the startup validator.
    sender = await startDaemon((ref) => ref.slice(ref.indexOf("@") + 1) === "build");
    receiver = await startDaemon(() => true);
    fs.writeFileSync(path.join(home, "hosts.yaml"), `hosts:\n  - id: ${ALIAS}\n    transport: http\n    url: ${receiver.url}\n`);
    const at = "2026-10-20T00:00:00.000Z";
    fs.writeFileSync(path.join(home, "host-bindings.json"), JSON.stringify({
      version: 1,
      bindings: { [ALIAS]: { hostId: SELF_ID, firstObservedAt: at, lastObservedAt: at } },
    }));
  });

  afterAll(async () => {
    for (const d of [sender, receiver]) {
      await new Promise<void>((resolve) => d.server.close(() => resolve()));
      d.db.close();
    }
    fs.rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = savedHome;
  });

  /** One `rig queue create` as its own process. Async spawn: both daemons run on this event loop. */
  async function create(label: string, args: string[]): Promise<RunRecord> {
    receiver.requests.length = 0;
    const before = { sender: rows(sender.db), receiver: rows(receiver.db) };
    const env: NodeJS.ProcessEnv = { ...process.env, OPENRIG_HOME: home, OPENRIG_URL: sender.url, OPENRIG_SESSION_NAME: SENDER };
    for (const key of ["RIGGED_HOME", "RIGGED_URL", "RIGGED_SESSION_NAME"]) delete env[key];
    const child = spawn(process.execPath, [cliEntry, "queue", "create", ...args, "--body", "fixture body", "--summary", "fixture", "--no-nudge", "--json"], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exit = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    const record: RunRecord = {
      stdout,
      stderr,
      exit,
      receiverRequests: [...receiver.requests],
      senderRows: rows(sender.db) - before.sender,
      receiverRows: rows(receiver.db) - before.receiver,
    };
    // The record itself is the evidence; print it whatever the assertions decide.
    console.log(`#1642 discriminator [${label}] ${JSON.stringify(record)}`);
    return record;
  }

  it("control: --host with the registry id forwards one create to the receiver, which stores the row", async () => {
    const r = await create("registry id", ["--destination", REMOTE_SEAT, "--host", ALIAS]);
    expect({ exit: r.exit, receiverRequests: r.receiverRequests, senderRows: r.senderRows, receiverRows: r.receiverRows })
      .toEqual({ exit: 0, receiverRequests: ["POST /api/queue/create"], senderRows: 0, receiverRows: 1 });
    expect(JSON.parse(r.stdout)).toMatchObject({ destinationSession: REMOTE_SEAT });
  }, 30_000);

  it("the learned self-id suffix today: the sender's daemon refuses unknown-host, exit 2, nothing reaches the receiver", async () => {
    const r = await create("learned self-id", ["--destination", `${REMOTE_SEAT}@${SELF_ID}`]);
    expect({ exit: r.exit, receiverRequests: r.receiverRequests, senderRows: r.senderRows, receiverRows: r.receiverRows })
      .toEqual({ exit: 2, receiverRequests: [], senderRows: 0, receiverRows: 0 });
    expect(JSON.parse(r.stdout)).toMatchObject({ error: "remote_queue_write_failed", hostId: SELF_ID, failureClass: "unknown-host" });
    expect(r.stderr).toContain("Queue create request ID:");
  }, 30_000);

  it("a rig this host doesn't have, no host named: refused unknown_destination_rig, exit 1, no row", async () => {
    const r = await create("unknown rig", ["--destination", "ops@portfolio"]);
    expect({ exit: r.exit, receiverRequests: r.receiverRequests, senderRows: r.senderRows, receiverRows: r.receiverRows })
      .toEqual({ exit: 1, receiverRequests: [], senderRows: 0, receiverRows: 0 });
    expect(JSON.parse(r.stdout)).toMatchObject({ error: "unknown_destination_rig" });
    expect(r.stderr).toContain("Queue create request ID:");
  }, 30_000);
});
