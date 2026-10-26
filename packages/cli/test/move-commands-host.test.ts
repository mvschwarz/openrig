// Slice 18 — `--codex-home` and `--host` on the commands that move a Codex home: `rig auth status|list|switch` and
// `rig seat restart`. `--host` runs the same rig command on another registered machine over its SSH entry, as the
// calling seat; only that argv goes out, and the remote command's own output and status come back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authCommand } from "../src/commands/auth.js";
import { seatCommand } from "../src/commands/seat.js";
import type { CrossHostResult } from "../src/cross-host-executor.js";
import type { HostEntry } from "../src/host-registry.js";

// This machine's persisted identity, as `rig send --host` reads it (the real reader opens the local store).
vi.mock("../src/local-origin.js", () => ({ readLocalOrigin: () => "host-local" }));

const SEAT = "fleet-agent@fleet";
const REGISTRY = {
  ok: true as const,
  registry: { hosts: [
    { id: "box-ssh", transport: "ssh", target: "box.local" },
    { id: "box", transport: "http", url: "http://box.local:7433" },
  ] as HostEntry[] },
};

let ran: Array<{ host: string; argv: readonly string[]; origin?: string }>;
let reply: CrossHostResult;
const ORIGIN = `${SEAT}@host-a`;
let selfHostId: string | undefined = "host-a";
const host = {
  hostRegistryLoader: () => REGISTRY,
  selfHostId: async () => selfHostId,
  crossHostRun: async (entry: HostEntry, argv: readonly string[], opts?: { originTriple?: string }) => {
    ran.push({ host: entry.id, argv, origin: opts?.originTriple });
    return reply;
  },
};

async function capture(run: () => Promise<unknown>): Promise<{ out: string; err: string; code: number | undefined }> {
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error, write = process.stdout.write, writeErr = process.stderr.write, exit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  process.stdout.write = ((chunk: string) => { out.push(String(chunk).replace(/\n$/, "")); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err.push(String(chunk).replace(/\n$/, "")); return true; }) as typeof process.stderr.write;
  let code: number | undefined;
  try {
    await run();
    code = process.exitCode as number | undefined;
  } finally {
    console.log = log; console.error = error; process.stdout.write = write; process.stderr.write = writeErr; process.exitCode = exit;
  }
  return { out: out.join("\n"), err: err.join("\n"), code };
}

let home: string;
const auth = (args: string[]) => capture(() =>
  authCommand({ env: { CODEX_HOME: path.join(home, "default"), HOME: home, OPENRIG_SESSION_NAME: SEAT }, loginStatus: () => "unavailable", host })
    .parseAsync(args, { from: "user" }));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "move-host-"));
  ran = [];
  selfHostId = "host-a";
  reply = { ok: true, failedStep: "none", stdout: "activated_profile: codex-2\n", stderr: "", remoteExitCode: 0 };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("rig auth --codex-home", () => {
  it("acts on the named home instead of CODEX_HOME", async () => {
    const other = path.join(home, "seat-home");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }), { mode: 0o600 });
    const saved = await capture(() => authCommand({ env: { CODEX_HOME: other, HOME: home } }).parseAsync(["save", "codex-2"], { from: "user" }));
    expect(saved.code).toBeUndefined();

    expect((await auth(["status", "--codex-home", other])).out).toContain(`codex_home: ${other}`);
    expect((await auth(["list", "--codex-home", other])).out).toBe("codex-2");
    expect((await auth(["list"])).out).toBe("");
    const switched = await auth(["switch", "codex-2", "--codex-home", other]);
    expect(switched.code).toBeUndefined();
    expect(switched.out).toContain(`active_auth: ${path.join(other, "auth.json")}`);
    expect(ran).toEqual([]);
  });
});

describe("rig auth --host", () => {
  it("runs the same switch on that machine's SSH entry, as this seat, with the exact home, and passes its output on", async () => {
    const res = await auth(["switch", "codex-2", "--host", "box-ssh", "--codex-home", "/home/ubuntu/.codex"]);
    expect(ran).toEqual([{ host: "box-ssh", origin: ORIGIN, argv: ["rig", "auth", "switch", "codex-2", "--runtime", "codex", "--codex-home", "/home/ubuntu/.codex"] }]);
    expect(res.out).toBe("activated_profile: codex-2");
    expect(res.err).toBe("[via host=box-ssh (box.local)]");
    expect(res.code).toBeUndefined();
  });

  it("status and list go the same way; the home is optional there", async () => {
    await auth(["status", "--host", "box-ssh"]);
    await auth(["list", "--host", "box-ssh", "--codex-home", "/srv/codex"]);
    expect(ran.map((r) => r.argv)).toEqual([
      ["rig", "auth", "status", "--runtime", "codex"],
      ["rig", "auth", "list", "--runtime", "codex", "--codex-home", "/srv/codex"],
    ]);
  });

  it("refuses a remote switch that doesn't name the home, and runs nothing", async () => {
    const res = await auth(["switch", "codex-2", "--host", "box-ssh"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("switch --host needs --codex-home");
    expect(ran).toEqual([]);
  });

  it("an HTTP entry can't run it: says which entry to use instead, and runs nothing", async () => {
    const res = await auth(["switch", "codex-2", "--host", "box", "--codex-home", "/home/ubuntu/.codex"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("that entry reaches the machine over http, which can't run auth switch there");
    expect(res.err).toContain("Name the same machine's SSH entry instead");
    expect(ran).toEqual([]);
  });

  it("whatever the remote shell answered comes back as its own output and status", async () => {
    reply = { ok: false, failedStep: "remote-command-failed", stdout: "", stderr: "rig auth: profile_not_found codex-9\n", remoteExitCode: 1 };
    const refused = await auth(["switch", "codex-9", "--host", "box-ssh", "--codex-home", "/h"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("rig auth: profile_not_found codex-9");
    // A machine whose login shell has no rig: its own words and its 127, plus the existing hint.
    reply = { ok: false, failedStep: "remote-command-not-found", stdout: "", stderr: "sh: rig: command not found\n", remoteExitCode: 127, hint: "The remote login PATH does not resolve `rig`." };
    const missing = await auth(["status", "--host", "box-ssh"]);
    expect(missing.code).toBe(127);
    expect(missing.err).toContain("sh: rig: command not found");
    expect(missing.err).toContain("The remote login PATH does not resolve `rig`.");
    reply = { ok: false, failedStep: "remote-daemon-unreachable", stdout: '{"ok":false,"code":"daemon_not_running"}\n', stderr: "", remoteExitCode: 1 };
    const noDaemon = await auth(["status", "--host", "box-ssh"]);
    expect(noDaemon.out).toBe('{"ok":false,"code":"daemon_not_running"}');
    expect(noDaemon.code).toBe(1);
  });

  it("a lost connection during a switch is an unknown outcome with the read to check; during a read, a failure", async () => {
    reply = { ok: false, failedStep: "ssh-unreachable", sshStderr: "Connection to box.local closed by remote host." };
    const lost = await auth(["switch", "codex-2", "--host", "box-ssh", "--codex-home", "/home/ubuntu/.codex"]);
    expect(lost.code).toBe(1);
    expect(lost.err).toContain("remote-outcome-unknown: the connection to host=box-ssh (box.local) failed or dropped, so whether rig auth switch ran there is unknown");
    expect(lost.err).toContain("Check before repeating it: rig auth status --host box-ssh --codex-home /home/ubuntu/.codex");
    const read = await auth(["status", "--host", "box-ssh"]);
    expect(read.err).toContain("ssh to host=box-ssh (target=box.local) failed");
    expect(read.err).not.toContain("remote-outcome-unknown");
  });

  it("carries this host's id in the origin, keeps a full triple as given, and falls back to the seat name", async () => {
    await auth(["status", "--host", "box-ssh"]);
    selfHostId = undefined;
    await auth(["status", "--host", "box-ssh"]);
    await capture(() => authCommand({ env: { HOME: home, RIGGED_SESSION_NAME: "old@rig@host-z" }, host }).parseAsync(["status", "--host", "box-ssh"], { from: "user" }));
    expect(ran.map((r) => r.origin)).toEqual([ORIGIN, SEAT, "old@rig@host-z"]);
  });
});

describe("rig seat restart --host", () => {
  const before = process.env.OPENRIG_SESSION_NAME;
  beforeEach(() => { process.env.OPENRIG_SESSION_NAME = SEAT; });
  afterEach(() => { if (before === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = before; });
  const restart = (args: string[]) => capture(() =>
    seatCommand({ lifecycleDeps: {} as never, clientFactory: () => { throw new Error("no local daemon call"); }, host })
      .parseAsync(["node", "seat", "restart", ...args]));

  it("runs the restart on that machine with its reason, naming this seat as the operator, and passes the JSON on", async () => {
    reply = { ok: true, failedStep: "none", stdout: '{"ok":true,"outcome":"restarted_account_unverified"}\n', stderr: "", remoteExitCode: 0 };
    const res = await restart(["dev-impl@team", "--keep-conversation", "--reason", "take codex-2", "--host", "box-ssh", "--json"]);
    expect(ran).toEqual([{ host: "box-ssh", origin: ORIGIN, argv: ["rig", "seat", "restart", "dev-impl@team", "--keep-conversation", "--reason", "take codex-2", "--operator", ORIGIN, "--json"] }]);
    expect(JSON.parse(res.out)).toEqual({ ok: true, outcome: "restarted_account_unverified" });
  });

  it("plan and verify go the same way, without an operator; an explicit operator wins", async () => {
    await restart(["dev-impl@team", "--keep-conversation", "--plan", "--host", "box-ssh"]);
    await restart(["dev-impl@team", "--keep-conversation", "--verify", "--expect-account", "two@example.com", "--host", "box-ssh"]);
    await restart(["dev-impl@team", "--keep-conversation", "--reason", "r", "--operator", "person@kernel", "--host", "box-ssh"]);
    expect(ran.map((r) => r.argv.slice(3))).toEqual([
      ["dev-impl@team", "--keep-conversation", "--plan"],
      ["dev-impl@team", "--keep-conversation", "--verify", "--expect-account", "two@example.com"],
      ["dev-impl@team", "--keep-conversation", "--reason", "r", "--operator", "person@kernel"],
    ]);
  });

  it("a lost connection during a restart is an unknown outcome, in JSON with --json, naming the plan to read; not for a plan", async () => {
    reply = { ok: false, failedStep: "ssh-unreachable", sshStderr: "client_loop: send disconnect: Broken pipe" };
    const lost = await restart(["dev-impl@team", "--keep-conversation", "--reason", "r", "--host", "box-ssh", "--json"]);
    expect(lost.code).toBe(1);
    expect(JSON.parse(lost.out)).toMatchObject({
      ok: false, code: "remote-outcome-unknown", cross_host: { host: "box-ssh", target: "box.local" },
      check: "rig seat restart dev-impl@team --keep-conversation --plan --host box-ssh (its lastRestart says whether this restart ran); don't restart it again on this result alone",
    });
    const plan = await restart(["dev-impl@team", "--keep-conversation", "--plan", "--host", "box-ssh", "--json"]);
    expect(JSON.parse(plan.out)).toMatchObject({ ok: false, failedStep: "ssh-unreachable" });
    expect(plan.out).not.toContain("remote-outcome-unknown");
  });

  it("checks its own options before anything goes out", async () => {
    const res = await restart(["dev-impl@team", "--keep-conversation", "--host", "box-ssh"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("A restart requires --reason");
    expect(ran).toEqual([]);
  });
});

describe("the origin's host id, as rig send reads it", () => {
  const before = process.env.OPENRIG_URL;
  afterEach(() => { if (before === undefined) delete process.env.OPENRIG_URL; else process.env.OPENRIG_URL = before; });

  it("is this machine's persisted id, even when OPENRIG_URL points at another machine's daemon", async () => {
    process.env.OPENRIG_URL = "http://host-b.example:7433";
    const { selfHostId: _injected, ...production } = host;
    await capture(() => authCommand({ env: { HOME: home, OPENRIG_SESSION_NAME: SEAT, OPENRIG_URL: "http://host-b.example:7433" }, host: production })
      .parseAsync(["status", "--host", "box-ssh"], { from: "user" }));
    expect(ran.at(-1)?.origin).toBe(`${SEAT}@host-local`);
  });
});
