// #1642: what a cross-host queue write actually does, end to end. The compiled CLI runs as its own
// process against two real daemon apps on local ports: the sender's daemon and a receiver standing in for
// the remote host. Each run records stdout, stderr, the process exit status, the creates each daemon saw
// and the rows in both stores, separately, so a wrong expectation about any one of them shows up as that
// one field.
//
// The sender's registry names the receiver `remote-vm` with no `hostId`; the CLI's learned bindings
// (written by `rig host doctor`) map `remote-vm` to the receiver's self-id. That is the shape where the
// self-id spelling of the destination, which a cross-host reply hint carries, is known only to the CLI.
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
const RETRY_LINE = `The daemon doesn't know host '${SELF_ID}'. Sending the same write as '${ALIAS}'`;

interface Daemon { db: Database.Database; repo: QueueRepository; server: ServerType; url: string; requests: string[] }

interface RunRecord {
  stdout: string;
  stderr: string;
  exit: number | null;
  senderWrites: string[];
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
  const repo = new QueueRepository(db, new EventBus(db), { validateRig });
  const { app } = createTestApp(db, {
    appDeps: {
      sessionTransport: { resolveSessions: async () => ({ ok: false, code: "not_found", error: "inert fixture" }), send: inert, capture: inert, broadcast: inert } as never,
      queueRepo: repo,
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
  return { db, repo, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function writeHome(dir: string, hostsYaml: string | null, bindings: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  if (hostsYaml !== null) fs.writeFileSync(path.join(dir, "hosts.yaml"), hostsYaml);
  const at = "2026-10-20T00:00:00.000Z";
  fs.writeFileSync(path.join(dir, "host-bindings.json"), JSON.stringify({
    version: 1,
    bindings: Object.fromEntries(Object.entries(bindings).map(([alias, hostId]) => [alias, { hostId, firstObservedAt: at, lastObservedAt: at }])),
  }));
}

describe.skipIf(!fs.existsSync(cliEntry))("#1642: cross-host queue writes through the compiled CLI", () => {
  let root: string;
  let home: string;
  let sender: Daemon;
  let receiver: Daemon;
  const savedHome = process.env.OPENRIG_HOME;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-host-qualifier-"));
    home = path.join(root, "home");
    // The in-process daemons read hosts.yaml from OPENRIG_HOME at request time, as an installed one does.
    process.env.OPENRIG_HOME = home;
    // The sender's topology knows only its own rig, like the startup validator.
    sender = await startDaemon((ref) => ref.slice(ref.indexOf("@") + 1) === "build");
    receiver = await startDaemon(() => true);
    writeHome(home, [
      "hosts:",
      `  - id: ${ALIAS}`, "    transport: http", `    url: ${receiver.url}`,
      "  - id: other-vm", "    transport: http", "    url: http://127.0.0.1:9",
      "",
    ].join("\n"), { [ALIAS]: SELF_ID });
  });

  afterAll(async () => {
    for (const d of [sender, receiver]) {
      await new Promise<void>((resolve) => d.server.close(() => resolve()));
      d.db.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = savedHome;
  });

  /** One `rig queue <argv>` as its own process. Async spawn: both daemons run on this event loop.
   *  `daemonHome` gives the sender's daemon a different OPENRIG_HOME than the CLI's, as OPENRIG_URL can. */
  async function run(label: string, argv: string[], opts: { daemonHome?: string } = {}): Promise<RunRecord> {
    sender.requests.length = 0;
    receiver.requests.length = 0;
    const before = { sender: rows(sender.db), receiver: rows(receiver.db) };
    if (opts.daemonHome) process.env.OPENRIG_HOME = opts.daemonHome;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, OPENRIG_HOME: home, OPENRIG_URL: sender.url, OPENRIG_SESSION_NAME: SENDER };
      for (const key of ["RIGGED_HOME", "RIGGED_URL", "RIGGED_SESSION_NAME"]) delete env[key];
      const child = spawn(process.execPath, [cliEntry, "queue", ...argv, "--summary", "fixture", "--no-nudge", "--json"], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const exit = await new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
      const record: RunRecord = {
        stdout,
        stderr,
        exit,
        senderWrites: sender.requests.filter((r) => r.startsWith("POST /api/queue/")),
        receiverRequests: [...receiver.requests],
        senderRows: rows(sender.db) - before.sender,
        receiverRows: rows(receiver.db) - before.receiver,
      };
      // The record itself is the evidence; print it whatever the assertions decide.
      console.log(`#1642 [${label}] ${JSON.stringify(record)}`);
      return record;
    } finally {
      process.env.OPENRIG_HOME = home;
    }
  }

  const create = (to: string, ...extra: string[]) => ["create", "--destination", to, "--body", "fixture body", ...extra];
  const outcome = (r: RunRecord) => ({ exit: r.exit, receiverRequests: r.receiverRequests, senderRows: r.senderRows, receiverRows: r.receiverRows });
  const FORWARDED = { exit: 0, receiverRequests: ["POST /api/queue/create"], senderRows: 0, receiverRows: 1 };
  const NOTHING = (exit: number) => ({ exit, receiverRequests: [], senderRows: 0, receiverRows: 0 });

  it("control: --host with the registry id forwards one create, as written", async () => {
    const r = await run("registry id", create(REMOTE_SEAT, "--host", ALIAS));
    expect(outcome(r)).toEqual(FORWARDED);
    expect(r.senderWrites).toEqual(["POST /api/queue/create"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ destinationSession: REMOTE_SEAT });
  }, 30_000);

  it("a learned self-id suffix reaches the receiver: one unknown-host refusal, then the registry id", async () => {
    const r = await run("learned self-id", create(`${REMOTE_SEAT}@${SELF_ID}`));
    expect(outcome(r)).toEqual(FORWARDED);
    expect(r.senderWrites).toEqual(["POST /api/queue/create", "POST /api/queue/create"]);
    expect(r.stderr).toContain(RETRY_LINE);
    expect(r.stderr).not.toContain("No row was created");
    expect(JSON.parse(r.stdout)).toMatchObject({ destinationSession: REMOTE_SEAT });
  }, 30_000);

  it("--host with the learned self-id reaches the receiver the same way", async () => {
    const r = await run("explicit self-id", create(REMOTE_SEAT, "--host", SELF_ID));
    expect(outcome(r)).toEqual(FORWARDED);
    expect(r.stderr).toContain(RETRY_LINE);
  }, 30_000);

  it("the alias beside the self-id suffix is one host, not a conflict", async () => {
    const r = await run("equivalent spelling", create(`${REMOTE_SEAT}@${SELF_ID}`, "--host", ALIAS));
    expect(outcome(r)).toEqual(FORWARDED);
  }, 30_000);

  it("a different registry entry beside the suffix is still a conflict, refused before any daemon write", async () => {
    const r = await run("real conflict", create(`${REMOTE_SEAT}@${SELF_ID}`, "--host", "other-vm"));
    expect(outcome(r)).toEqual(NOTHING(1));
    expect(r.senderWrites).toEqual([]);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: "host_qualifier_conflict" });
  }, 30_000);

  it("a daemon whose own registry declares the self-id under another alias decides alone: no rewrite, no second write", async () => {
    // The CLI's registry would rewrite the self-id to `remote-vm`, which this daemon doesn't have.
    const daemonHome = path.join(root, "daemon-declares");
    writeHome(daemonHome, `hosts:\n  - id: vm-b\n    transport: http\n    url: ${receiver.url}\n    hostId: ${SELF_ID}\n`, {});
    const r = await run("daemon registry declares it", create(`${REMOTE_SEAT}@${SELF_ID}`), { daemonHome });
    expect(outcome(r)).toEqual(FORWARDED);
    expect(r.senderWrites).toEqual(["POST /api/queue/create"]);
    expect(r.stderr).not.toContain(RETRY_LINE);
  }, 30_000);

  it("a daemon whose registry knows neither spelling refuses both, and nothing is written", async () => {
    const daemonHome = path.join(root, "daemon-knows-neither");
    writeHome(daemonHome, "hosts:\n  - id: unrelated\n    transport: http\n    url: http://127.0.0.1:9\n", {});
    const r = await run("daemon registry lacks it", create(`${REMOTE_SEAT}@${SELF_ID}`), { daemonHome });
    expect(outcome(r)).toEqual(NOTHING(2));
    expect(r.senderWrites).toEqual(["POST /api/queue/create", "POST /api/queue/create"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: "remote_queue_write_failed", hostId: ALIAS, failureClass: "unknown-host" });
    expect(r.stderr).toContain("No row was created: ");
  }, 30_000);

  it("a rig this host doesn't have, no host named: refused unknown_destination_rig, exit 1, and it says no row was created", async () => {
    const r = await run("unknown rig", create("ops@portfolio"));
    expect(outcome(r)).toEqual(NOTHING(1));
    expect(JSON.parse(r.stdout)).toMatchObject({ error: "unknown_destination_rig" });
    expect(r.stderr).toContain("Queue create request ID:");
    expect(r.stderr).toContain("No row was created: ");
  }, 30_000);

  for (const [verb, closed] of [["handoff", "handed-off"], ["handoff-and-complete", "done"]] as const) {
    it(`${verb} to a learned self-id suffix creates the successor on the receiver and closes the source`, async () => {
      const source = await sender.repo.create({ sourceSession: SENDER, destinationSession: SENDER, body: "source work", nudge: false });
      const r = await run(`${verb} learned self-id`, [verb, source.qitemId, "--to", `${REMOTE_SEAT}@${SELF_ID}`]);
      expect(outcome(r)).toEqual(FORWARDED);
      expect(r.stderr).toContain(RETRY_LINE);
      const after = sender.repo.getById(source.qitemId)!;
      expect(after.state).toBe(closed);
      expect(after.closureTarget).toMatch(new RegExp(`@${ALIAS}$`));
    }, 30_000);
  }
});
