// createDaemon({ seatKinds }) is the one way to add a seat kind. This drives the real composition
// with a fake kind and checks that launch, send and capture reach it, and that tmux is not asked.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon } from "../src/startup.js";
import type { AppDeps } from "../src/server.js";
import type { CmuxTransportFactory } from "../src/terminal/cmux-transport.js";
import type { ArgvExecFn, ExecFn } from "../src/adapters/tmux.js";
import type Database from "better-sqlite3";
import type { SeatKind, SeatRef } from "../src/domain/seat-kinds.js";

let db: Database.Database;
let deps: AppDeps;
let scratch: string;
const savedEnv: Record<string, string | undefined> = {};
const tmuxCommands: string[] = [];
const kindCalls: string[] = [];

const acp: SeatKind = {
  kind: "acp",
  host: {
    create: async (req) => { kindCalls.push(`create:${req.sessionName}`); return { ok: true, binding: {}, warnings: [] }; },
    launch: async () => ({ ok: true }),
    checkReady: async () => ({ ready: true }),
    probe: async () => ({ state: "present" }),
    stop: async (ref: SeatRef) => { kindCalls.push(`stop:${ref.sessionName}`); return { ok: true }; },
  },
  inbound: {
    deliver: async (ref, text) => { kindCalls.push(`deliver:${ref.sessionName}:${text}`); return { ok: true, sessionName: ref.sessionName, verified: true }; },
    capture: async (ref, lines) => ({ ok: true, sessionName: ref.sessionName, content: "from the agent", lines }),
  },
  activity: { probe: async (_ref, now) => ({ state: "idle", reason: "turn_closed", evidenceSource: "external_cli", sampledAt: now.toISOString(), evidence: null }) },
};

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "seat-kinds-daemon-"));
  for (const k of ["OPENRIG_HOME", "OPENRIG_DB", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_NO_KERNEL"]) savedEnv[k] = process.env[k];
  process.env.OPENRIG_HOME = path.join(scratch, "home");
  process.env.OPENRIG_DB = path.join(scratch, "daemon.sqlite");
  delete process.env.OPENRIG_URL;
  delete process.env.OPENRIG_PORT;
  process.env.OPENRIG_NO_KERNEL = "1";
  const cmuxFactory: CmuxTransportFactory = async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); };
  const tmuxExec: ExecFn = async (cmd) => { tmuxCommands.push(cmd); return ""; };
  const argvExec: ArgvExecFn = async (argv) => { tmuxCommands.push(argv.join(" ")); return ""; };
  const result = await createDaemon({ cmuxFactory, tmuxExec, argvExec, dbPath: process.env.OPENRIG_DB!, seatKinds: [acp] });
  db = result.db;
  deps = result.deps;
}, 60000);

afterAll(() => {
  db?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("createDaemon({ seatKinds })", () => {
  it("launches, sends to and captures a registered kind's seat without asking tmux", async () => {
    const rig = deps.rigRepo.createRig("r01");
    const node = deps.rigRepo.addNode(rig.id, "impl", { role: "worker", runtime: "claude-code" });
    const before = tmuxCommands.length;

    const launched = await deps.nodeLauncher.launchNode(rig.id, "impl", { kind: "acp" });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(deps.sessionRegistry.getBindingForNode(node.id)).toMatchObject({ attachmentType: "acp", externalSessionName: launched.sessionName });

    const sent = await deps.sessionTransport!.send(launched.sessionName, "hello");
    expect(sent).toMatchObject({ ok: true, verified: true });
    const captured = await deps.sessionTransport!.capture(launched.sessionName);
    expect(captured).toMatchObject({ ok: true, content: "from the agent" });

    expect(kindCalls).toEqual([`create:${launched.sessionName}`, `deliver:${launched.sessionName}:hello`]);
    expect(tmuxCommands.slice(before)).toEqual([]);
  });
});
