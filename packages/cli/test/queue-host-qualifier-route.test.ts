// #1642: what a cross-host queue write actually does, end to end. The compiled CLI runs as its own
// process against real daemon apps on local ports: the sender's daemon, a receiver standing in for the
// remote host, and another host. Each run records stdout, stderr, the process exit status, the writes the
// sender's daemon saw, the receiver's requests and the rows in each store, separately, so a wrong
// expectation about any one of them shows up as that one field.
//
// The sender's registry names the receiver `remote-vm` with no `hostId`; the CLI's learned bindings
// (written by `rig host doctor`) map `remote-vm` to the receiver's self-id. That is the shape where the
// self-id spelling of the destination, which a cross-host reply hint carries, is known only to the CLI.
// Queue writes keep the daemon's refusal of that spelling and add a qualified hint; nothing is resent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
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
const HINT = `Host '${SELF_ID}' resolves to '${ALIAS}' in this CLI's host registry. That doesn't prove`;

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

/** `bindings` maps an alias to a learned self-id, or to the whole binding record. `null` writes no file. */
function writeHome(dir: string, hostsYaml: string | null, bindings: Record<string, string | Record<string, unknown>> | null): void {
  fs.mkdirSync(dir, { recursive: true });
  if (hostsYaml !== null) fs.writeFileSync(path.join(dir, "hosts.yaml"), hostsYaml);
  if (bindings === null) return;
  const at = "2026-10-20T00:00:00.000Z";
  fs.writeFileSync(path.join(dir, "host-bindings.json"), JSON.stringify({
    version: 1,
    bindings: Object.fromEntries(Object.entries(bindings).map(([alias, b]) => [alias,
      typeof b === "string" ? { hostId: b, firstObservedAt: at, lastObservedAt: at } : { firstObservedAt: at, lastObservedAt: at, ...b }])),
  }));
}

describe.skipIf(!fs.existsSync(cliEntry))("#1642: cross-host queue writes through the compiled CLI", () => {
  let root: string;
  let home: string;
  let sender: Daemon;
  let receiver: Daemon;
  let other: Daemon;
  const savedHome = process.env.OPENRIG_HOME;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "queue-host-qualifier-"));
    home = path.join(root, "home");
    // The in-process daemons read hosts.yaml from OPENRIG_HOME at request time, as an installed one does.
    process.env.OPENRIG_HOME = home;
    // The sender's topology knows only its own rig, like the startup validator.
    sender = await startDaemon((ref) => ref.slice(ref.indexOf("@") + 1) === "build");
    receiver = await startDaemon(() => true);
    other = await startDaemon(() => true);
    writeHome(home, [
      "hosts:",
      `  - id: ${ALIAS}`, "    transport: http", `    url: ${receiver.url}`,
      "  - id: other-vm", "    transport: http", "    url: http://127.0.0.1:9",
      "",
    ].join("\n"), { [ALIAS]: SELF_ID });
  });

  afterAll(async () => {
    for (const d of [sender, receiver, other]) {
      await new Promise<void>((resolve) => d.server.close(() => resolve()));
      d.db.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = savedHome;
  });

  /** One `rig queue <argv>` as its own process. Async spawn: the daemons run on this event loop.
   *  `daemonHome` gives the sender's daemon a different OPENRIG_HOME than the CLI's, as OPENRIG_URL can;
   *  `cliHome` does the same for the CLI. */
  async function run(label: string, argv: string[], opts: { daemonHome?: string; cliHome?: string } = {}): Promise<RunRecord> {
    sender.requests.length = 0;
    receiver.requests.length = 0;
    const before = { sender: rows(sender.db), receiver: rows(receiver.db) };
    if (opts.daemonHome) process.env.OPENRIG_HOME = opts.daemonHome;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, OPENRIG_HOME: opts.cliHome ?? home, OPENRIG_URL: sender.url, OPENRIG_SESSION_NAME: SENDER };
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
    expect(r.stderr).not.toContain(HINT);
  }, 30_000);

  it("a learned self-id suffix stays refused: one write, nothing stored, and a qualified hint naming the registry id", async () => {
    const r = await run("learned self-id", create(`${REMOTE_SEAT}@${SELF_ID}`));
    expect(outcome(r)).toEqual(NOTHING(2));
    expect(r.senderWrites).toEqual(["POST /api/queue/create"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: "remote_queue_write_failed", hostId: SELF_ID, failureClass: "unknown-host" });
    expect(r.stderr).toContain("Queue create request ID:");
    expect(r.stderr).toContain("No row was created: ");
    expect(r.stderr).toContain(HINT);
    expect(r.stderr).toContain(`the destination '${REMOTE_SEAT}@${ALIAS}'`);
  }, 30_000);

  it("--host with the learned self-id stays refused, and the hint gives the --host substitution", async () => {
    const r = await run("explicit self-id", create(REMOTE_SEAT, "--host", SELF_ID));
    expect(outcome(r)).toEqual(NOTHING(2));
    expect(r.senderWrites).toEqual(["POST /api/queue/create"]);
    expect(r.stderr).toContain(`--host '${ALIAS}'`);
  }, 30_000);

  it("the hinted address form reaches the receiver when the daemon shares this registry", async () => {
    const r = await run("hinted address form", create(`${REMOTE_SEAT}@${ALIAS}`));
    expect(outcome(r)).toEqual(FORWARDED);
  }, 30_000);

  it("an alias that names another host in the daemon's registry: one refused write, nothing reaches either host", async () => {
    // This CLI's remote-vm is the receiver; the selected daemon's remote-vm is a different host.
    const daemonHome = path.join(root, "daemon-alias-collision");
    writeHome(daemonHome, `hosts:\n  - id: ${ALIAS}\n    transport: http\n    url: ${other.url}\n`, {});
    other.requests.length = 0;
    const r = await run("alias collision", create(`${REMOTE_SEAT}@${SELF_ID}`), { daemonHome });
    expect(outcome(r)).toEqual(NOTHING(2));
    expect(r.senderWrites).toEqual(["POST /api/queue/create"]);
    expect(other.requests).toEqual([]);
    expect(rows(other.db)).toBe(0);
    expect(r.stderr).toContain(HINT);
  }, 30_000);

  it("a daemon whose own registry declares the self-id decides alone: one write, no hint", async () => {
    const daemonHome = path.join(root, "daemon-declares");
    writeHome(daemonHome, `hosts:\n  - id: vm-b\n    transport: http\n    url: ${receiver.url}\n    hostId: ${SELF_ID}\n`, {});
    const r = await run("daemon registry declares it", create(`${REMOTE_SEAT}@${SELF_ID}`), { daemonHome });
    expect(outcome(r)).toEqual(FORWARDED);
    expect(r.senderWrites).toEqual(["POST /api/queue/create"]);
    expect(r.stderr).not.toContain(HINT);
  }, 30_000);

  it("a rig this host doesn't have, no host named: refused unknown_destination_rig, exit 1, and it says no row was created", async () => {
    const r = await run("unknown rig", create("ops@portfolio"));
    expect(outcome(r)).toEqual(NOTHING(1));
    expect(JSON.parse(r.stdout)).toMatchObject({ error: "unknown_destination_rig" });
    expect(r.stderr).toContain("Queue create request ID:");
    expect(r.stderr).toContain("No row was created: ");
    expect(r.stderr).not.toContain(HINT);
  }, 30_000);

  for (const verb of ["handoff", "handoff-and-complete"] as const) {
    it(`${verb} to a learned self-id suffix stays refused: one write, no successor, source untouched, qualified hint`, async () => {
      const source = await sender.repo.create({ sourceSession: SENDER, destinationSession: SENDER, body: "source work", nudge: false });
      const transitions = () => (sender.db.prepare("SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id = ?").get(source.qitemId) as { c: number }).c;
      const before = { row: sender.repo.getById(source.qitemId), transitions: transitions() };
      const r = await run(`${verb} learned self-id`, [verb, source.qitemId, "--to", `${REMOTE_SEAT}@${SELF_ID}`]);
      expect(outcome(r)).toEqual(NOTHING(2));
      expect(r.senderWrites).toEqual([`POST /api/queue/${source.qitemId}/${verb}`]);
      expect(JSON.parse(r.stdout)).toMatchObject({ error: "remote_queue_write_failed", hostId: SELF_ID, failureClass: "unknown-host" });
      expect(sender.repo.getById(source.qitemId)).toEqual(before.row);
      expect(transitions()).toBe(before.transitions);
      expect(r.stderr).toContain(HINT);
      expect(r.stderr).not.toContain("No row was created");
    }, 30_000);
  }

  describe("the selected daemon's own learned binding (its home's host-bindings.json)", () => {
    let hangup: http.Server;
    let hangupUrl: string;
    const hangupRequests: string[] = [];
    const eligible = (url: string) => ({ [ALIAS]: { hostId: SELF_ID, observedUrl: url } });
    const daemonHomeWith = (name: string, url: string, bindings: Parameters<typeof writeHome>[2]) => {
      const dir = path.join(root, name);
      writeHome(dir, `hosts:\n  - id: ${ALIAS}\n    transport: http\n    url: ${url}\n`, bindings);
      return dir;
    };

    beforeAll(async () => {
      // A remote that takes the request, starts an answer and drops the connection: the outcome is unknown.
      hangup = http.createServer((req, res) => {
        hangupRequests.push(`${req.method} ${req.url}`);
        req.resume();
        req.on("end", () => {
          res.writeHead(201, { "Content-Type": "application/json", "Content-Length": "1000" });
          res.write("{\"qitemId\":");
          setTimeout(() => res.destroy(), 20);
        });
      });
      await new Promise<void>((resolve) => hangup.listen(0, "127.0.0.1", () => resolve()));
      hangupUrl = `http://127.0.0.1:${(hangup.address() as AddressInfo).port}`;
    });
    afterAll(async () => { await new Promise<void>((resolve) => hangup.close(() => resolve())); });

    it("a binding learned at the entry's current URL carries the self-id suffix to the receiver: one write, no hint", async () => {
      const daemonHome = daemonHomeWith("eligible-create", receiver.url, eligible(receiver.url));
      const r = await run("eligible binding", create(`${REMOTE_SEAT}@${SELF_ID}`), { daemonHome });
      expect(outcome(r)).toEqual(FORWARDED);
      expect(r.senderWrites).toEqual(["POST /api/queue/create"]);
      expect(r.stderr).not.toContain(HINT);
      expect(r.stderr).not.toContain("No row was created");
    }, 30_000);

    for (const [verb, closed] of [["handoff", "handed-off"], ["handoff-and-complete", "done"]] as const) {
      it(`${verb}: one successor on the receiver, the source closed toward it, and a re-run absorbs`, async () => {
        const daemonHome = daemonHomeWith(`eligible-${verb}`, receiver.url, eligible(receiver.url));
        const source = await sender.repo.create({ sourceSession: SENDER, destinationSession: SENDER, body: "source work", nudge: false });
        const transitions = () => (sender.db.prepare("SELECT COUNT(*) c FROM queue_transitions WHERE qitem_id = ?").get(source.qitemId) as { c: number }).c;
        const before = transitions();
        const first = await run(`${verb} eligible`, [verb, source.qitemId, "--to", `${REMOTE_SEAT}@${SELF_ID}`], { daemonHome });
        expect(outcome(first)).toEqual(FORWARDED);
        expect(transitions()).toBe(before + 1);
        const closedRow = sender.repo.getById(source.qitemId)!;
        expect(closedRow.state).toBe(closed);
        expect(closedRow.closureTarget).toMatch(new RegExp(`@${SELF_ID}$`));
        const successorId = closedRow.closureTarget!.slice(0, -(SELF_ID.length + 1));
        expect(receiver.repo.getById(successorId)).toMatchObject({ destinationSession: REMOTE_SEAT, chainOfRecord: [source.qitemId] });
        // The same command again: the successor create is re-sent and absorbed, the closed source is unchanged.
        const again = await run(`${verb} eligible re-run`, [verb, source.qitemId, "--to", `${REMOTE_SEAT}@${SELF_ID}`], { daemonHome });
        expect(again.exit).toBe(0);
        expect(again.receiverRows).toBe(0);
        expect(sender.repo.getById(source.qitemId)).toEqual(closedRow);
        expect(transitions()).toBe(before + 1);
      }, 30_000);
    }

    it("a binding only in the CLI's home is never used by the daemon: refused, nothing written", async () => {
      const cliHome = path.join(root, "cli-only-binding");
      writeHome(cliHome, `hosts:\n  - id: ${ALIAS}\n    transport: http\n    url: ${receiver.url}\n`, eligible(receiver.url));
      const daemonHome = daemonHomeWith("daemon-without-binding", receiver.url, null);
      const r = await run("binding only in the CLI home", create(`${REMOTE_SEAT}@${SELF_ID}`), { daemonHome, cliHome });
      expect(outcome(r)).toEqual(NOTHING(2));
      expect(JSON.parse(r.stdout)).toMatchObject({ failureClass: "unknown-host", detail: `unknown host id '${SELF_ID}'. Known host ids: ${ALIAS}.` });
      expect(r.stderr).toContain(HINT);
    }, 30_000);

    const INELIGIBLE: Array<[string, Record<string, unknown>, string]> = [
      ["learned before URLs were recorded", { hostId: SELF_ID }, "was learned before its URL was recorded"],
      ["learned at a URL the entry no longer has", { hostId: SELF_ID, observedUrl: "http://127.0.0.1:1" }, "was learned at http://127.0.0.1:1, but the entry now points at"],
      ["carrying a recorded conflict", { hostId: SELF_ID, observedUrl: "RECEIVER", conflict: { hostId: "host-0000beef", observedAt: "2026-10-20T01:00:00.000Z" } }, "has a recorded conflict"],
    ];
    for (const [label, binding, reason] of INELIGIBLE) {
      for (const verb of ["create", "handoff", "handoff-and-complete"] as const) {
        it(`${verb}: a daemon binding ${label} never forwards, writes or closes, and the refusal says why`, async () => {
          const b = binding.observedUrl === "RECEIVER" ? { ...binding, observedUrl: receiver.url } : binding;
          const daemonHome = daemonHomeWith(`ineligible-${verb}-${label.split(" ")[0]}-${reason.length}`, receiver.url, { [ALIAS]: b });
          const source = verb === "create" ? null : await sender.repo.create({ sourceSession: SENDER, destinationSession: SENDER, body: "source work", nudge: false });
          const before = source ? sender.repo.getById(source.qitemId) : null;
          const argv = source ? [verb, source.qitemId, "--to", `${REMOTE_SEAT}@${SELF_ID}`] : create(`${REMOTE_SEAT}@${SELF_ID}`);
          const r = await run(`${verb} ${label}`, argv, { daemonHome });
          expect(outcome(r)).toEqual(NOTHING(2));
          const err = JSON.parse(r.stdout) as { failureClass: string; detail: string };
          expect(err.failureClass).toBe("unknown-host");
          expect(err.detail).toContain(reason);
          expect(err.detail).toContain(`rig host doctor ${ALIAS}`);
          if (source) expect(sender.repo.getById(source.qitemId)).toEqual(before);
        }, 30_000);
      }
    }

    it("an unclear forward result is never sent again and never claims no row was created", async () => {
      const daemonHome = daemonHomeWith("eligible-hangup", hangupUrl, eligible(hangupUrl));
      hangupRequests.length = 0;
      const r = await run("indeterminate forward", create(`${REMOTE_SEAT}@${SELF_ID}`), { daemonHome });
      expect(r.exit).toBe(2);
      expect(hangupRequests).toEqual(["POST /api/queue/create"]);
      expect(r.senderWrites).toEqual(["POST /api/queue/create"]);
      expect(JSON.parse(r.stdout)).toMatchObject({ error: "remote_queue_write_failed", outcome: "indeterminate" });
      expect(r.stderr).not.toContain("No row was created");
      expect(r.stderr).not.toContain(HINT);
    }, 30_000);
  });
});
