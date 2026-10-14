import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigStore } from "../src/config-store.js";
import { Command } from "commander";
import { whoamiCommand, boundPeers } from "../src/commands/whoami.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

/**
 * Slice 15 (OPR.0.7.0.15) P5 — `rig whoami --json` lists a bounded, edge-first set of peers when
 * `output.compact` is on. Switch off (the default) and `--all-peers` print today's compact output.
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

const DAEMON_NOTE = "peers = this rig's roster excluding self (no edge filter); edges = directional relationships; use `rig ps --nodes` for node inventory including self + live state";

const peer = (logicalId: string, podId: string) => ({
  logicalId, sessionName: `${logicalId.replace(".", "-")}@big`, runtime: "claude-code", podId, podNamespace: podId, memberId: logicalId.split(".")[1],
});

/** A 23-peer roster in daemon (created_at) order. The edge peers sit late, so edge-first ordering is visible. */
const BIG_PEERS = [
  ...Array.from({ length: 10 }, (_, i) => peer(`ops.o${i}`, "ops")),
  peer("dev.a", "dev"), peer("dev.b", "dev"),
  ...Array.from({ length: 9 }, (_, i) => peer(`misc.m${i}`, "misc")),
  peer("review.r1", "review"), peer("orch.lead", "orch"),
];

function response(peers: ReturnType<typeof peer>[], edges = {
  outgoing: [{ kind: "delegates_to", to: { logicalId: "orch.lead", sessionName: "orch-lead@big" } }],
  incoming: [{ kind: "can_observe", from: { logicalId: "review.r1", sessionName: "review-r1@big" } }],
}) {
  return {
    resolvedBy: "node_id",
    identity: {
      rigId: "rig-1", rigName: "big", nodeId: "node-1", logicalId: "dev.impl", attachmentType: "tmux", podId: "dev",
      podNamespace: "dev", podLabel: null, memberId: "impl", memberLabel: null, sessionName: "dev-impl@big", runtime: "claude-code",
      cwd: "/tmp", agentRef: null, profile: null, resolvedSpecName: null, resolvedSpecVersion: null,
    },
    peers,
    peersNote: DAEMON_NOTE,
    edges,
    transcript: { enabled: true, path: "/tmp/t.log", tailCommand: "rig transcript dev-impl@big --tail 100", grepCommand: null },
    commands: { sendExamples: [], captureExamples: [] },
  };
}

const SMALL_PEERS = [peer("dev.a", "dev"), peer("orch.lead", "orch"), peer("review.r1", "review")];

/** Main's compact projection (`projectCompactWhoami` at 7510731d), restated so "unchanged" is checked against a fixed shape. */
function todaysCompact(data: ReturnType<typeof response>): string {
  return JSON.stringify({
    resolvedBy: data.resolvedBy,
    identity: {
      rigName: data.identity.rigName, nodeId: data.identity.nodeId, logicalId: data.identity.logicalId, podId: data.identity.podId,
      podNamespace: data.identity.podNamespace, memberId: data.identity.memberId, sessionName: data.identity.sessionName,
      runtime: data.identity.runtime,
    },
    peers: data.peers.map((p) => ({ logicalId: p.logicalId, sessionName: p.sessionName, runtime: p.runtime })),
    peersNote: data.peersNote,
    edges: data.edges,
    transcript: { path: data.transcript.path, tailCommand: data.transcript.tailCommand },
  });
}

describe("rig whoami --json: bounded peers (output.compact, output.whoami_peers)", () => {
  let server: http.Server;
  let port: number;
  let served: ReturnType<typeof response> | Record<string, unknown>;
  let status = 200;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if ((req.url ?? "").includes("/api/whoami")) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(served));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); });

  beforeEach(() => {
    served = response(BIG_PEERS);
    status = 200;
    vi.stubEnv("OPENRIG_NODE_ID", "");
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    vi.stubEnv("TMUX_PANE", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  async function run(...args: string[]): Promise<string> {
    const deps: StatusDeps = { lifecycleDeps: lifecycle(port), clientFactory: (url) => new DaemonClient(url) };
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(whoamiCommand(deps));
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(a.join(" ")); });
    try {
      await prog.parseAsync(["node", "rig", "whoami", "--node-id", "node-1", ...args]);
    } finally {
      spy.mockRestore();
    }
    return logs.join("\n");
  }

  it("switch off (default): today's compact output byte for byte, on a large and a small rig", async () => {
    expect(await run("--json")).toBe(todaysCompact(served as ReturnType<typeof response>));
    served = response(SMALL_PEERS);
    expect(await run("--json")).toBe(todaysCompact(served as ReturnType<typeof response>));
  });

  it("switch off: --all-peers changes nothing", async () => {
    expect(await run("--json", "--all-peers")).toBe(todaysCompact(served as ReturnType<typeof response>));
  });

  it("switch on, large rig: 8 peers, edge peers (both directions) first, then the seat's pod, then roster order", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    const out = JSON.parse(await run("--json"));
    expect(out.peers.map((p: { logicalId: string }) => p.logicalId)).toEqual([
      "review.r1", "orch.lead", "dev.a", "dev.b", "ops.o0", "ops.o1", "ops.o2", "ops.o3",
    ]);
    expect(out.peers[0]).toEqual({ logicalId: "review.r1", sessionName: "review-r1@big", runtime: "claude-code" });
    expect(out.peersOmitted).toBe(15);
    expect(out.peersNote).toBe(
      "peers = 8 of this rig's 23 (roster excluding self; edge peers first, then your pod, then roster order; "
      + "bound output.whoami_peers=8); 15 not shown; all: rig whoami --json --all-peers --node-id 'node-1'; "
      + "edges = directional relationships (always complete); use `rig ps --nodes` for node inventory including self + live state",
    );
    // Identity, edges and transcript stay at today's paths, complete.
    const today = JSON.parse(todaysCompact(served as ReturnType<typeof response>));
    expect(out.identity).toEqual(today.identity);
    expect(out.edges).toEqual(today.edges);
    expect(out.transcript).toEqual(today.transcript);
    expect(Object.keys(out)).toEqual(["resolvedBy", "identity", "peers", "peersNote", "peersOmitted", "edges", "transcript"]);
  });

  it("switch on, small rig: today's peers and note verbatim, plus only peersOmitted: 0", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    served = response(SMALL_PEERS);
    const out = await run("--json");
    const today = JSON.parse(todaysCompact(served as ReturnType<typeof response>));
    expect(JSON.parse(out)).toEqual({ ...today, peersOmitted: 0 });
    expect(Object.keys(JSON.parse(out))).toEqual(["resolvedBy", "identity", "peers", "peersNote", "peersOmitted", "edges", "transcript"]);
    expect(Buffer.byteLength(out) - Buffer.byteLength(todaysCompact(served as ReturnType<typeof response>))).toBe('"peersOmitted":0,'.length);
  });

  it("a rig of exactly the bound is shown whole, unchanged", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    served = response(BIG_PEERS.slice(0, 8));
    const out = JSON.parse(await run("--json"));
    expect(out.peers).toEqual(JSON.parse(todaysCompact(served as ReturnType<typeof response>)).peers);
    expect(out.peersNote).toBe(DAEMON_NOTE);
    expect(out.peersOmitted).toBe(0);
  });

  it("switch on: an error answer prints exactly as main does (no bounding, no rewritten note, no peersOmitted)", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    for (const code of [404, 409, 500]) {
      status = code;
      served = { error: "Session not found", peers: BIG_PEERS, peersNote: DAEMON_NOTE };
      const out = await run("--json");
      // Main's error path: the whole answer, pretty-printed; a 404 also gets its additive routing hint.
      if (code === 404) expect(JSON.parse(out)).toEqual({ ...served, hint: expect.any(String) });
      else expect(out).toBe(JSON.stringify(served, null, 2));
      expect(out).not.toContain("peersOmitted");
    }
  });

  it("the setting changes the bound", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    vi.stubEnv("OPENRIG_OUTPUT_WHOAMI_PEERS", "3");
    let out = JSON.parse(await run("--json"));
    expect(out.peers.map((p: { logicalId: string }) => p.logicalId)).toEqual(["review.r1", "orch.lead", "dev.a"]);
    expect(out.peersOmitted).toBe(20);
    expect(out.peersNote).toContain("bound output.whoami_peers=3); 20 not shown");
    vi.stubEnv("OPENRIG_OUTPUT_WHOAMI_PEERS", "30");
    out = JSON.parse(await run("--json"));
    expect(out.peers).toEqual(JSON.parse(todaysCompact(served as ReturnType<typeof response>)).peers);
    expect(out.peersNote).toBe(DAEMON_NOTE);
    expect(out.peersOmitted).toBe(0);
  });

  it("switch on: --all-peers prints today's compact output byte for byte", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    expect(await run("--json", "--all-peers")).toBe(todaysCompact(served as ReturnType<typeof response>));
  });

  it("switch on: --full keeps today's whole payload", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    expect(await run("--json", "--full")).toBe(JSON.stringify(served, null, 2));
  });

  it("switch on: plain text still lists every peer (out of P5)", async () => {
    vi.stubEnv("OPENRIG_OUTPUT_COMPACT", "1");
    const out = await run();
    for (const p of BIG_PEERS) expect(out).toContain(p.logicalId);
  });

  it("the full-list command names the identity the call used: --session, quoted", () => {
    const bounded = boundPeers(response(BIG_PEERS), 2, "rig whoami --json --all-peers --session 'dev-impl@big'");
    expect(bounded.note).toContain("all: rig whoami --json --all-peers --session 'dev-impl@big';");
  });

  it("edge peers past the bound are cut like any other, and edges still name them", () => {
    const bounded = boundPeers(response(BIG_PEERS), 1, "rig whoami --json --all-peers");
    expect(bounded.peers.map((p) => (p as { logicalId: string }).logicalId)).toEqual(["review.r1"]);
    expect(bounded.omitted).toBe(22);
  });

  it("is deterministic and keeps roster order inside each tier", () => {
    const a = boundPeers(response(BIG_PEERS), 8, "x");
    const b = boundPeers(response(BIG_PEERS), 8, "x");
    expect(a).toEqual(b);
    const noEdges = boundPeers(response(BIG_PEERS, { outgoing: [], incoming: [] }), 4, "x");
    expect(noEdges.peers.map((p) => (p as { logicalId: string }).logicalId)).toEqual(["dev.a", "dev.b", "ops.o0", "ops.o1"]);
  });

  it("the bound set in the config file applies, as `rig config get` reports it", async () => {
    // Its own scratch home, so the test never depends on the suite's (or the caller's) OPENRIG_HOME.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "whoami-peers-home-"));
    vi.stubEnv("OPENRIG_HOME", home);
    try {
      expect(new ConfigStore().configPath).toBe(path.join(home, "config.json"));
      new ConfigStore().set("output.compact", "true");
      new ConfigStore().set("output.whoami_peers", "5");
      expect(new ConfigStore().resolveWithSource("output.whoami_peers")).toMatchObject({ value: 5, source: "file" });
      const out = JSON.parse(await run("--json"));
      expect(out.peers).toHaveLength(5);
      expect(out.peersOmitted).toBe(18);
    } finally {
      // OPENRIG_HOME is restored by afterEach's vi.unstubAllEnvs(); remove only this test's own home.
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("output.whoami_peers: registered like output.compact", () => {
  let home: string;
  beforeEach(() => { vi.unstubAllEnvs(); home = fs.mkdtempSync(path.join(os.tmpdir(), "whoami-peers-config-")); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

  it("defaults to 8 and accepts only an integer >= 1", () => {
    const store = new ConfigStore(path.join(home, "config.json"));
    expect(store.resolveWithSource("output.whoami_peers")).toMatchObject({ value: 8, source: "default" });
    store.set("output.whoami_peers", "12");
    expect(store.get("output.whoami_peers")).toBe(12);
    for (const raw of ["0", "-3", "2.5", "8junk", "many"]) {
      expect(() => store.set("output.whoami_peers", raw)).toThrow(/output\.whoami_peers/);
    }
  });

  it("an invalid OPENRIG_OUTPUT_WHOAMI_PEERS is rejected with the store's warning and falls back", () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => { stderr.push(String(s)); return true; }) as typeof process.stderr.write);
    vi.stubEnv("OPENRIG_OUTPUT_WHOAMI_PEERS", "0");
    expect(new ConfigStore(path.join(home, "config.json")).get("output.whoami_peers")).toBe(8);
    expect(stderr.join("")).toContain("output.whoami_peers");
  });
});
