import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { whoamiCommand, withOriginPeersCommand, type WhoamiDeps } from "../src/commands/whoami.js";
import { DaemonClient } from "../src/client.js";
import { shellQuote } from "../src/cross-host-executor.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";

/**
 * Slice 15 (OPR.0.7.0.15) P5 over SSH `--host`: the remote bounds its peer list, and the note's full-list
 * command must reach the same host and identity when copied at the origin. Hermetic: the real `rig whoami` runs
 * on both sides against fixture daemons; the SSH boundary is faked by quoting the argv as the executor does and
 * splitting it as a remote shell would. No ssh, no host, no daemon process, no home but the test's own.
 */

function lifecycle(port: number): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => (p === STATE_FILE
      ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-03T00:00:00Z" } as DaemonState) : null)),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((p: string) => p === STATE_FILE), mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  };
}

const peer = (i: number) => ({ logicalId: `ops.o${i}`, sessionName: `ops-o${i}@big`, runtime: "claude-code", podId: "ops", podNamespace: "ops", memberId: `o${i}` });
const PEERS = Array.from({ length: 12 }, (_, i) => peer(i));
const NOTE = "peers = this rig's roster excluding self (no edge filter); edges = directional relationships; use `rig ps --nodes` for node inventory including self + live state";

function identity(nodeId: string, sessionName: string) {
  return {
    resolvedBy: "node_id",
    identity: { rigId: "rig-1", rigName: "big", nodeId, logicalId: "dev.impl", attachmentType: "tmux", podId: "dev", podNamespace: "dev",
      podLabel: null, memberId: "impl", memberLabel: null, sessionName, runtime: "claude-code", cwd: "/tmp", agentRef: null, profile: null,
      resolvedSpecName: null, resolvedSpecVersion: null },
    peers: PEERS, peersNote: NOTE, edges: { outgoing: [], incoming: [] },
    transcript: { enabled: true, path: "/tmp/t.log", tailCommand: "rig transcript x --tail 100", grepCommand: null },
    commands: { sendExamples: [], captureExamples: [] },
  };
}

/** A fixture daemon answering /api/whoami for exactly one seat (by node id or session); anything else is a 404. */
function daemon(nodeId: string, sessionName: string) {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    asked.push(url.pathname + url.search);
    const match = url.pathname === "/api/whoami" && (url.searchParams.get("nodeId") === nodeId || url.searchParams.get("sessionName") === sessionName);
    res.writeHead(match ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(match ? identity(nodeId, sessionName) : { error: `Session not found: ${url.searchParams.get("sessionName") ?? url.searchParams.get("nodeId")}` }));
  });
  return { server, asked, port: 0 };
}

/** Split a POSIX command line with single-quoted words (what shellQuote produces), as a remote shell would. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error(`unterminated quote in: ${line}`);
      word += line.slice(i + 1, end); i = end; inWord = true;
    } else if (c === "\\" && i + 1 < line.length) { word += line[++i]; inWord = true; }
    else if (/\s/.test(c)) { if (inWord) { words.push(word); word = ""; inWord = false; } }
    else { word += c; inWord = true; }
  }
  if (inWord) words.push(word);
  return words;
}

/** Capture what a run prints, from console and stdout, without letting it reach the test output. */
async function capture(run: () => Promise<void>): Promise<{ out: string; err: string; exitCode: number | undefined }> {
  // Nested captures (the origin's, then the remote's inside the fake SSH run) each restore what they replaced.
  const out: string[] = []; const err: string[] = [];
  const prior = { log: console.log, error: console.error, write: process.stdout.write, ewrite: process.stderr.write };
  console.log = (...a: unknown[]) => { out.push(`${a.join(" ")}\n`); };
  console.error = (...a: unknown[]) => { err.push(`${a.join(" ")}\n`); };
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as never;
  process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as never;
  const before = process.exitCode;
  process.exitCode = undefined;
  try { await run(); } finally {
    console.log = prior.log; console.error = prior.error; process.stdout.write = prior.write; process.stderr.write = prior.ewrite;
  }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = before;
  return { out: out.join(""), err: err.join(""), exitCode };
}

const REMOTE = { nodeId: "node-remote", session: "o'neil impl@big" }; // a quote and a space: quoting must hold
const LOCAL = { nodeId: "node-local", session: "local-impl@big" };
const remoteD = daemon(REMOTE.nodeId, REMOTE.session);
const localD = daemon(LOCAL.nodeId, LOCAL.session);
let remoteEnv: Record<string, string> = {};
let remoteOverride: ((stdout: string) => string) | null = null;
let sshCalls: string[] = [];

beforeAll(async () => {
  for (const d of [remoteD, localD]) {
    await new Promise<void>((resolve) => { d.server.listen(0, resolve); });
    d.port = (d.server.address() as { port: number }).port;
  }
});
afterAll(() => { remoteD.server.close(); localD.server.close(); });
beforeEach(() => {
  remoteD.asked.length = 0; localD.asked.length = 0; remoteEnv = {}; remoteOverride = null; sshCalls = [];
  for (const k of ["OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "TMUX_PANE", "OPENRIG_HOST_SELECTED"]) vi.stubEnv(k, "");
  vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1"); // compact output on, default bound 8 (on both sides of this one process)
});
afterEach(() => { vi.unstubAllEnvs(); });

/** The remote side of the fake SSH boundary: the real `rig whoami`, against the remote fixture daemon. */
const fakeSsh: NonNullable<WhoamiDeps["crossHostRun"]> = async (_host, argv) => {
  const line = argv.map(shellQuote).join(" "); // what the SSH executor sends
  sshCalls.push(line);
  const words = shellWords(line);
  const saved: Record<string, string | undefined> = {};
  // The remote host has its own configuration: no host selection of the origin's, plus anything a case sets.
  for (const [k, v] of Object.entries({ OPENRIG_HOST_SELECTED: "", ...remoteEnv })) { saved[k] = process.env[k]; process.env[k] = v; }
  let result;
  try { result = await capture(() => rig(words.slice(1), { lifecycleDeps: lifecycle(remoteD.port), clientFactory: (u) => new DaemonClient(u) })); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  const stdout = remoteOverride ? remoteOverride(result.out) : result.out;
  return result.exitCode ? { ok: false, failedStep: "remote-command-failed", stdout, stderr: result.err, remoteExitCode: result.exitCode }
    : { ok: true, failedStep: "none", stdout, stderr: result.err, remoteExitCode: 0 };
};

async function rig(args: string[], deps: WhoamiDeps): Promise<void> {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(whoamiCommand(deps));
  await prog.parseAsync(["node", "rig", ...args]);
}
/** The origin: its own (local) fixture daemon, a registry with one SSH host, and the fake SSH boundary. */
const origin = (args: string[]) => capture(() => rig(args, {
  lifecycleDeps: lifecycle(localD.port), clientFactory: (u) => new DaemonClient(u),
  hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "vm-a", transport: "ssh", target: "vm-a.local" }] } }),
  crossHostRun: fakeSsh,
}));
const hintOf = (stdout: string): string => /all: (rig whoami [^;]*);/.exec(JSON.parse(stdout).peersNote)![1]!;

describe("rig whoami --json --host (SSH): the full-peer-list hint reaches the same host and identity", () => {
  it("main's hint (the remote's own command) queries the local host; the corrected hint reaches the remote seat's full list", async () => {
    const first = await origin(["whoami", "--json", "--host", "vm-a", "--session", REMOTE.session]);
    const bounded = JSON.parse(first.out);
    expect(bounded.identity.nodeId).toBe(REMOTE.nodeId);
    expect(bounded.peers).toHaveLength(8);
    expect(bounded.peersOmitted).toBe(4);

    // What main printed: the remote's own command. Followed at the origin, it asks the local daemon.
    const remoteOwn = `rig whoami --json --all-peers --session ${shellQuote(REMOTE.session)}`;
    const mains = await origin(shellWords(remoteOwn).slice(1));
    expect(localD.asked.some((q) => q.startsWith("/api/whoami"))).toBe(true);
    expect(mains.exitCode).toBe(1); // that seat doesn't exist on the local host
    expect(JSON.parse(mains.out).error).toContain("Session not found");

    // The corrected hint carries the host; followed at the origin it goes through SSH to the same seat, in full.
    const hint = hintOf(first.out);
    expect(hint).toBe(`rig whoami --json --all-peers --host 'vm-a' --session ${shellQuote(REMOTE.session)}`);
    localD.asked.length = 0;
    const full = await origin(shellWords(hint).slice(1));
    expect(localD.asked).toEqual([]);
    expect(sshCalls.at(-1)).toContain("'--all-peers'");
    const all = JSON.parse(full.out);
    expect(all.identity).toMatchObject({ nodeId: REMOTE.nodeId, sessionName: REMOTE.session });
    expect(all.peers).toHaveLength(12);
    expect(all.peersNote).toBe(NOTE);
  });

  it("a persisted host selection keeps the caller's context too: the hint names that host", async () => {
    vi.stubEnv("OPENRIG_HOST_SELECTED", "vm-a");
    const first = await origin(["whoami", "--json", "--node-id", REMOTE.nodeId]);
    const hint = hintOf(first.out);
    expect(hint).toBe(`rig whoami --json --all-peers --host 'vm-a' --node-id 'node-remote'`);
    vi.stubEnv("OPENRIG_HOST_SELECTED", ""); // even after the selection changes, the hint goes to the same host
    const all = JSON.parse((await origin(shellWords(hint).slice(1))).out);
    expect(all.identity.nodeId).toBe(REMOTE.nodeId);
    expect(all.peers).toHaveLength(12);
  });

  it("an identity the remote resolved itself (none asked for) is named in the hint, so it reaches the same seat", async () => {
    remoteEnv = { OPENRIG_NODE_ID: REMOTE.nodeId };
    const first = await origin(["whoami", "--json", "--host", "vm-a"]);
    const hint = hintOf(first.out);
    expect(hint).toBe(`rig whoami --json --all-peers --host 'vm-a' --node-id 'node-remote'`);
    remoteEnv = {};
    const all = JSON.parse((await origin(shellWords(hint).slice(1))).out);
    expect(all.identity.nodeId).toBe(REMOTE.nodeId);
    expect(all.peers).toHaveLength(12);
  });

  it("controls: local, switch off, --all-peers, errors and plain output are unchanged", async () => {
    // Local: the hint stays the local command.
    const local = await origin(["whoami", "--json", "--session", LOCAL.session]);
    expect(hintOf(local.out)).toBe(`rig whoami --json --all-peers --session 'local-impl@big'`);
    // Over SSH, everything that isn't a bounded note passes through byte for byte.
    const passthrough = async (args: string[]) => {
      let remoteOut = "";
      remoteOverride = (s) => { remoteOut = s; return s; };
      const r = await origin(args);
      remoteOverride = null;
      return { r, remoteOut };
    };
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", ""); // switch off: unbounded
    let { r, remoteOut } = await passthrough(["whoami", "--json", "--host", "vm-a", "--session", REMOTE.session]);
    expect(r.out).toBe(remoteOut);
    expect(JSON.parse(r.out).peers).toHaveLength(12);
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    ({ r, remoteOut } = await passthrough(["whoami", "--json", "--all-peers", "--host", "vm-a", "--session", REMOTE.session]));
    expect(r.out).toBe(remoteOut);
    ({ r, remoteOut } = await passthrough(["whoami", "--json", "--host", "vm-a", "--session", "nobody@big"])); // a remote error
    expect(remoteOut).toContain("Session not found");
    expect(JSON.parse(r.out)).toMatchObject({ ok: false }); // main's cross-host failure envelope, untouched by the hint
    expect(r.out).not.toContain("--all-peers --host");
    ({ r, remoteOut } = await passthrough(["whoami", "--host", "vm-a", "--session", REMOTE.session])); // plain output
    expect(r.out).toContain("[via host=vm-a (vm-a.local)]");
    expect(r.out.endsWith(remoteOut)).toBe(true);
  });

  it("older, unbounded or malformed remote output is passed through, never rejected or turned into a success", async () => {
    const cases: Array<[string, (s: string) => string]> = [
      ["not JSON", () => "rig: unknown option --all-peers\n"],
      ["an older remote (no peersOmitted)", (s) => { const o = JSON.parse(s); delete o.peersOmitted; return JSON.stringify(o); }],
      ["a note in another form", (s) => { const o = JSON.parse(s); o.peersNote = "peers trimmed; ask the operator"; return JSON.stringify(o); }],
      ["the command named twice", (s) => { const o = JSON.parse(s); o.peersNote = `${o.peersNote} ${o.peersNote}`; return JSON.stringify(o); }],
      ["a JSON array", () => "[1,2]"],
    ];
    for (const [, change] of cases) {
      let sent = "";
      remoteOverride = (s) => { sent = change(s); return sent; };
      const r = await origin(["whoami", "--json", "--host", "vm-a", "--session", REMOTE.session]);
      expect(r.out).toBe(sent);
      expect(r.exitCode).toBeUndefined();
    }
  });

  it("withOriginPeersCommand replaces only the remote's own command in a bounded note, escaped as the JSON carries it", () => {
    const opts = { session: `a"b'c d@big`, json: true };
    const remote = `rig whoami --json --all-peers --session ${shellQuote(opts.session)}`;
    const body = { identity: { nodeId: "n" }, peersOmitted: 3, peersNote: `peers = 8 of 11; 3 not shown; all: ${remote}; edges = ...` };
    const out = withOriginPeersCommand(JSON.stringify(body), "vm-a", opts as never);
    expect(JSON.parse(out).peersNote).toBe(`peers = 8 of 11; 3 not shown; all: rig whoami --json --all-peers --host 'vm-a' --session ${shellQuote(opts.session)}; edges = ...`);
    expect(shellWords(/all: ([^;]*);/.exec(JSON.parse(out).peersNote)![1]!)).toEqual(["rig", "whoami", "--json", "--all-peers", "--host", "vm-a", "--session", opts.session]);
    const pretty = JSON.stringify(body, null, 2);
    expect(withOriginPeersCommand(pretty, "vm-a", opts as never)).toBe(pretty.replace(JSON.stringify(`all: ${remote};`).slice(1, -1),
      JSON.stringify(`all: rig whoami --json --all-peers --host 'vm-a' --session ${shellQuote(opts.session)};`).slice(1, -1)));
    expect(withOriginPeersCommand(JSON.stringify({ ...body, peersOmitted: 0 }), "vm-a", opts as never)).toBe(JSON.stringify({ ...body, peersOmitted: 0 }));
  });

  it("F1: only the note's own value is rewritten; differently encoded or ambiguous output passes through byte for byte", () => {
    const opts = { session: "dev-impl@big", json: true };
    const remote = `rig whoami --json --all-peers --session 'dev-impl@big'`;
    const note = `peers = 8 of 11; 3 not shown; all: ${remote}; edges = ...`;
    const escaped = JSON.stringify(note).replace(/ /g, "\\u0020"); // the note's command with Unicode escapes
    // The reviewer's case: the note carries the command escaped, another field carries it literally.
    const f1 = `{"identity":{"nodeId":"n"},"peersOmitted":3,"peersNote":${escaped},"debug":${JSON.stringify(`ran: all: ${remote};`)}}`;
    expect(JSON.parse(f1).peersNote).toBe(note); // valid JSON, the same note value
    expect(withOriginPeersCommand(f1, "vm-a", opts as never)).toBe(f1);
    // A canonical copy elsewhere while the real note is escaped: still not rewritten anywhere.
    const copy = `{"identity":{"nodeId":"n"},"peersOmitted":3,"peersNote":${escaped},"mirror":{"peersNote":${JSON.stringify(note)}}}`;
    expect(withOriginPeersCommand(copy, "vm-a", opts as never)).toBe(copy);
    // The same note twice under peersNote keys (top level and nested): ambiguous, passed through.
    const twice = JSON.stringify({ identity: { nodeId: "n" }, peersOmitted: 3, peersNote: note, nested: { peersNote: note } });
    expect(withOriginPeersCommand(twice, "vm-a", opts as never)).toBe(twice);
    // The canonical note alone, with the command literal elsewhere too: only the note changes.
    const plain = JSON.stringify({ identity: { nodeId: "n" }, peersOmitted: 3, peersNote: note, debug: `ran: all: ${remote};` });
    const out = withOriginPeersCommand(plain, "vm-a", opts as never);
    expect(JSON.parse(out)).toEqual({ ...JSON.parse(plain), peersNote: note.replace(remote, `rig whoami --json --all-peers --host 'vm-a' --session 'dev-impl@big'`) });
    expect(out.replace(/"peersNote":"[^"]*"/, "")).toBe(plain.replace(/"peersNote":"[^"]*"/, "")); // every other byte kept
  });
});
