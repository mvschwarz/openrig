// #2866 — `rig queue update --source <name>@external`: a routine running outside any managed seat can append a
// NOTE as itself, recorded as an external actor (claimed:v1), never as a seat. A REAL `queueCommand` invocation
// talks over LOOPBACK HTTP to the real queueRoutes + QueueRepository on a fully migrated test DB, so the recorded
// transition (actor + provenance) is read back from the store, not from a stubbed response.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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
const seenHeaders: Array<string | undefined> = [];
const SELF_HOST_ID = "this-host";
const REMOTE_URL = "http://127.0.0.1:9";
const remoteCalls: string[] = [];

// Same hermetic isolation as queue-update-metadata-reject-cli.test.ts: ambient OPENRIG_URL / RIGGED_URL /
// OPENRIG_PORT win over the injected state file, so they are removed for the CLI-invocation window only.
const AMBIENT_KEYS = ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT"] as const;
const savedEnv: Record<string, string | undefined> = {};
function neutralizeAmbient(): void { for (const k of AMBIENT_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; } }
function restoreAmbient(): void { for (const k of AMBIENT_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } }

beforeAll(async () => {
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  repo = new QueueRepository(db, bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => {
    seenHeaders.push(c.req.header("x-openrig-session"));
    c.set("eventBus" as never, bus); c.set("queueRepo" as never, repo); await next();
  });
  // The daemon's own host id, as /healthz reports it: a `--host` naming it resolves to this daemon (queueHostTarget).
  app.get("/healthz", (c) => c.json({ ok: true, selfHostId: SELF_HOST_ID }));
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
    // One registered http host besides this daemon, so `--host other-host` resolves to a truly remote target.
    hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "other-host", transport: "http", url: REMOTE_URL }] } }),
    lifecycleDeps: { spawn: () => ({ pid: 1, unref() {} }), fetch: async () => ({ ok: true }), kill: () => true, readFile: (p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 1, port, host: "127.0.0.1", db: "x", startedAt: "x" }) : null), writeFile() {}, removeFile() {}, exists: (p: string) => p === STATE_FILE, mkdirp() {}, openForAppend: () => 3, isProcessAlive: () => true },
    clientFactory: (url: string) => {
      // The remote host's client is built but must never be called: every method records the call and fails.
      if (url === REMOTE_URL) {
        return new Proxy({}, { get: (_t, prop) => async () => { remoteCalls.push(String(prop)); throw new Error(`remote ${String(prop)} called`); } });
      }
      if (url !== loopbackUrl()) throw new Error(`test-isolation guard: clientFactory url '${url}' !== loopback '${loopbackUrl()}'`);
      return new DaemonClient(url);
    },
  };
}

async function runCli(args: string[]): Promise<{ out: string; exit: number | undefined }> {
  const out: string[] = [];
  const ol = console.log, oe = console.error, ow = process.stderr.write;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  process.stderr.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.exitCode = undefined;
  neutralizeAmbient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  try { await queueCommand(deps() as any).parseAsync(["node", "rig", ...args]); }
  finally { restoreAmbient(); console.log = ol; console.error = oe; process.stderr.write = ow; }
  const exit = process.exitCode; process.exitCode = 0;
  return { out: out.join("\n"), exit };
}

type TransitionRow = { actor_session: string; state: string; transition_note: string | null; identity_provenance: string | null };
const transitions = (id: string) => db.prepare(
  "SELECT actor_session, state, transition_note, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid",
).all(id) as TransitionRow[];

describe("#2866 rig queue update --source <name>@external (note only, external actor)", () => {
  let id: string;
  beforeEach(async () => {
    // Outside any managed seat: neither seat env is set, so the CLI stamps no X-OpenRig-Session header.
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    seenHeaders.length = 0;
    remoteCalls.length = 0;
    id = (await repo.create({ sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "work" })).qitemId;
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("records the note with the external routine as its actor (claimed:v1), never a seat, and leaves the state alone", async () => {
    const before = repo.getByIdOrThrow(id);
    const { out, exit } = await runCli(["update", id, "--source", "routine-nightly@external", "--note", "nudged the owner", "--json"]);
    expect(exit, out).toBeFalsy();
    const last = transitions(id).at(-1)!;
    expect(last).toMatchObject({ actor_session: "routine-nightly@external", transition_note: "nudged the owner", identity_provenance: "claimed:v1" });
    expect(last.state).toBe(before.state);
    expect(repo.getByIdOrThrow(id).state).toBe(before.state);
    // No seat identity was forged on the wire: the request carried no X-OpenRig-Session header.
    expect(seenHeaders.length).toBeGreaterThan(0);
    expect(seenHeaders.every((h) => h === undefined)).toBe(true);
  });

  it("without a seat and without --source, says notes need a seat and names --source; nothing is sent", async () => {
    const beforeTxns = transitions(id).length;
    const { out, exit } = await runCli(["update", id, "--note", "nudged the owner"]);
    expect(exit).toBe(1);
    expect(out.startsWith("notes need a seat; an external routine can pass --source <name>@external")).toBe(true);
    expect(seenHeaders).toEqual([]);
    expect(transitions(id).length).toBe(beforeTxns);
  });

  it("without a seat, a state change still needs one: refused before any request, and the error names --source for notes", async () => {
    const before = repo.getByIdOrThrow(id);
    const { out, exit } = await runCli(["update", id, "--state", "done", "--closure-reason", "no-follow-on"]);
    expect(exit).toBe(1);
    expect(out).toContain("OPENRIG_SESSION_NAME is not set, so there's no seat to act as");
    expect(out).toContain("notes need a seat; an external routine can pass --source <name>@external");
    // D#52: a person approving their own ask (a host pairing) is pointed at the TUI or Steering.
    expect(out).toContain("A person answering an ask addressed to them (a host pairing approval, say) does it in the TUI (rig tui, then attention) or in Steering");
    expect(seenHeaders).toEqual([]);
    expect(repo.getByIdOrThrow(id)).toEqual(before);
  });

  it("a blank seat env is no seat: the --source note is recorded as the external routine, not dropped", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "   ");
    const { out, exit } = await runCli(["update", id, "--source", "routine-nightly@external", "--note", "blank env", "--json"]);
    expect(exit, out).toBeFalsy();
    expect(out).not.toContain("is ignored");
    expect(transitions(id).at(-1)).toMatchObject({ actor_session: "routine-nightly@external", identity_provenance: "claimed:v1" });
  });

  it.each(["local", SELF_HOST_ID])("accepts --host %s, which resolves to this daemon: the note is recorded as the external routine", async (host) => {
    const { out, exit } = await runCli(["update", id, "--source", "routine-nightly@external", "--note", `via --host ${host}`, "--host", host, "--json"]);
    expect(exit, out).toBeFalsy();
    expect(transitions(id).at(-1)).toMatchObject({ actor_session: "routine-nightly@external", transition_note: `via --host ${host}`, identity_provenance: "claimed:v1" });
  });

  it("refuses --source with a --host that resolves to another host (it would lose the routine's origin); nothing is written", async () => {
    const beforeTxns = transitions(id).length;
    const { out, exit } = await runCli(["update", id, "--source", "routine-nightly@external", "--note", "x", "--host", "other-host"]);
    expect(exit).toBe(1);
    expect(out).toContain("--source with --host other-host is not supported");
    expect(out).toContain("Nothing was sent");
    // Only the self-id probe reached this daemon; nothing was posted here or to the other host.
    expect(remoteCalls).toEqual([]);
    expect(transitions(id).length).toBe(beforeTxns);
  });

  it.each(["dev-x@rig", "routine-nightly", "routine@externalx", "human@kernel"])("refuses --source %s (not <name>@external); nothing is sent", async (source) => {
    const beforeTxns = transitions(id).length;
    const { out, exit } = await runCli(["update", id, "--source", source, "--note", "nudged the owner"]);
    expect(exit).toBe(1);
    expect(out).toContain("--source must be <name>@external");
    expect(seenHeaders).toEqual([]);
    expect(transitions(id).length).toBe(beforeTxns);
  });

  // Every flag of the update verb that writes more than a note, one case each (UPDATE_STATE_WRITE_FLAGS in queue.ts).
  it.each([
    ["--state", ["--state", "in-progress"]],
    ["--reopen", ["--reopen"]],
    ["--closure-reason", ["--closure-reason", "no-follow-on"]],
    ["--closure-target", ["--closure-target", "next@rig"]],
    ["--closure-required-at", ["--closure-required-at", "2030-01-01T00:00:00Z"]],
    ["--resolution", ["--state", "done", "--closure-reason", "no-follow-on", "--resolution", "finished"]],
    ["--blocked-on", ["--state", "blocked", "--blocked-on", "external:x"]],
    ["--wake-watchdog", ["--wake-watchdog", "job-1"]],
    ["--wake-after", ["--wake-after", "15m"]],
    ["--summary", ["--summary", "new subject"]],
    ["--evidence-ref", ["--evidence-ref", "/proof.md"]],
  ] as const)("refuses --source with %s: it records a note only; nothing is sent", async (_label, extra) => {
    const before = repo.getByIdOrThrow(id);
    const beforeTxns = transitions(id).length;
    const { out, exit } = await runCli(["update", id, "--source", "routine-nightly@external", "--note", "x", ...extra]);
    expect(exit).toBe(1);
    expect(out).toContain("--source records a note only");
    expect(seenHeaders).toEqual([]);
    expect(transitions(id).length).toBe(beforeTxns);
    expect(repo.getByIdOrThrow(id)).toEqual(before);
  });

  it("refuses --source without --note; nothing is sent", async () => {
    const { out, exit } = await runCli(["update", id, "--source", "routine-nightly@external"]);
    expect(exit).toBe(1);
    expect(out).toContain("--source records a note only");
    expect(seenHeaders).toEqual([]);
  });

  it("inside a managed seat the seat stays the actor (transport:v1); --source does not override it", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "dev-x@rig");
    const { out, exit } = await runCli(["update", id, "--source", "routine-nightly@external", "--note", "seat note", "--json"]);
    expect(exit, out).toBeFalsy();
    expect(transitions(id).at(-1)).toMatchObject({ actor_session: "dev-x@rig", transition_note: "seat note", identity_provenance: "transport:v1" });
    expect(out).toContain("warning: --source routine-nightly@external is ignored: this runs in the seat dev-x@rig");
  });
});
