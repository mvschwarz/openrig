// OPR.0.5.3.5 recap-write atom — the outgoing occupant's write verb (the Q2
// boundary requirement the store alone does not satisfy). Daemon-independent
// like trace: seat dir resolves from topology.root CONFIG (slice-06 D1 layout),
// the write flows through the ONE store (supersession + addressability gate),
// advisory contract findings ride stderr, and the gate refuses loud.

import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { contextCommand } from "../src/commands/context.js";
import { DaemonClient, DaemonConnectionError, DaemonTimeoutError } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import { resolveAuthoredRecapPointer } from "../../daemon/src/domain/context-packs/seat-recap-store.js";

/** A running daemon on `port`, as the CLI's status check sees it. */
function lifecycleDeps(port: number): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE
      ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-10-25T00:00:00Z" } as DaemonState) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

const daemonDeps = (port: number): StatusDeps => ({ lifecycleDeps: lifecycleDeps(port), clientFactory: (url) => new DaemonClient(url) });

/** No daemon state file and nothing answering: the CLI reads the daemon as stopped. */
const noDaemon: StatusDeps = {
  lifecycleDeps: { ...lifecycleDeps(0), readFile: vi.fn(() => null), exists: vi.fn(() => false), isProcessAlive: vi.fn(() => false),
    fetch: vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }) },
  clientFactory: () => { throw new Error("no daemon in this test"); },
};

async function runRecapWrite(argv: string[], deps?: StatusDeps): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errLogs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };
  process.exitCode = undefined;
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    // No test reaches a real daemon: without deps, the daemon reads as stopped.
    program.addCommand(contextCommand(deps ?? noDaemon));
    await program.parseAsync(["node", "rig", "context", ...argv]);
  } catch { /* commander exitOverride */ } finally {
    exitCode = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit;
  }
  return { logs, errLogs, exitCode };
}

describe("rig context recap-write — the boundary write verb", () => {
  it("writes RECAP.md to the topology seat dir, supersedes into the chain, and echoes advisory findings on stderr", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s05-recap-verb-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      mkdirSync(join(tmp, "topology", "rigs", "r1", "seats", "s1"), { recursive: true });
      const f1 = join(tmp, "era1.md");
      writeFileSync(f1, "## Recent Decisions\nchose X because Y");
      const first = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", f1]);
      expect(first.exitCode ?? 0).toBe(0);
      const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("chose X because Y");
      // Second write supersedes; content missing a decisions section draws the
      // ADVISORY finding on stderr but still lands (never gated on prose).
      const f2 = join(tmp, "era2.md");
      writeFileSync(f2, "## Status\nall done");
      const second = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", f2]);
      expect(second.exitCode ?? 0).toBe(0);
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("all done");
      expect(readdirSync(join(seatDir, "recap-superseded"))).toHaveLength(1);
      expect(second.errLogs.join("\n")).toMatch(/decisions/i);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("provisions a missing seat directory beneath an existing topology rig", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-provision-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const rigDir = join(tmp, "topology", "rigs", "r1");
      const seatDir = join(rigDir, "seats", "s1");
      mkdirSync(rigDir, { recursive: true });
      expect(existsSync(seatDir)).toBe(false);
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nchose provisioning because manual mkdir is not a product path");

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap]);

      expect(res.exitCode ?? 0).toBe(0);
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("chose provisioning");
      writeFileSync(recap, "## Recent Decisions\nkept the supported store path because it preserves the chain");
      const second = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap]);
      expect(second.exitCode ?? 0).toBe(0);
      expect(readFileSync(join(seatDir, "RECAP.md"), "utf-8")).toContain("preserves the chain");
      expect(readdirSync(join(seatDir, "recap-superseded"))).toHaveLength(1);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a missing rig instead of manufacturing an arbitrary topology", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-missing-rig-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nnone");

      const res = await runRecapWrite(["recap-write", "--rig", "missing", "--seat", "s1", "--file", recap]);

      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/rig.*does not exist|topology/i);
      expect(existsSync(join(tmp, "topology", "rigs", "missing"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses unsafe rig or seat path segments before provisioning", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-path-guard-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      mkdirSync(join(tmp, "topology", "rigs", "r1"), { recursive: true });
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nnone");

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "../escape", "--file", recap]);

      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/unsafe|segment/i);
      expect(existsSync(join(tmp, "topology", "rigs", "r1", "escape"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to provision through a symlinked topology namespace", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s06-recap-symlink-guard-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const rigDir = join(tmp, "topology", "rigs", "r1");
      const outside = join(tmp, "outside");
      mkdirSync(rigDir, { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, join(rigDir, "seats"));
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nnone");

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap]);

      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/symlink|escape|unsafe/i);
      expect(existsSync(join(outside, "s1"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the addressability gate refuses LOUD and leaves nothing behind", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "s05-recap-verb2-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      const seatDir = join(tmp, "topology", "rigs", "r1", "seats", "s1");
      mkdirSync(seatDir, { recursive: true });
      const bad = join(tmp, "bad.md");
      writeFileSync(bad, "## Same\na\n## Same\nb");
      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", bad]);
      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toMatch(/addressab|duplicate/i);
      expect(existsSync(join(seatDir, "RECAP.md"))).toBe(false);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// A sandboxed seat (a default Codex seat) can't write the topology tree. The OS refuses the write (EPERM under a
// sandbox; EACCES here, from a read-only rig folder), so the CLI hands the same recap to the daemon, which owns the tree.
describe.skipIf(process.getuid?.() === 0)("rig context recap-write when this process may not write the topology tree", () => {
  it("hands the recap to the daemon, which writes it; nothing is written by this process", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "recap-via-daemon-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    const received: unknown[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, body: JSON.parse(body || "null") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: "/daemon/topology/rigs/r1/seats/s1/RECAP.md", superseded: 1 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const rigDir = join(tmp, "topology", "rigs", "r1");
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      mkdirSync(rigDir, { recursive: true });
      chmodSync(rigDir, 0o555);
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nchose the daemon because the seat can't write here");

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap], daemonDeps(port));

      expect(res.exitCode ?? 0).toBe(0);
      // The named seat is looked up first (reads only); the one write is the daemon's recap write.
      expect(received.filter((request) => request.method !== "POST").every((request) => request.method === "GET")).toBe(true);
      expect(received.filter((request) => request.method === "POST")).toEqual([{ method: "POST", url: "/api/context-packs/seat-recap",
        body: { rig: "r1", seat: "s1", content: "## Recent Decisions\nchose the daemon because the seat can't write here" } }]);
      expect(res.logs.join("\n")).toBe(`Recap written: /daemon/topology/rigs/r1/seats/s1/RECAP.md (1 superseded predecessor retained), by the daemon at http://127.0.0.1:${port}`);
      expect(res.errLogs.join("\n")).toMatch(/can't write the topology tree \(EACCES.*\), so the daemon writes the recap instead/);
      expect(existsSync(join(rigDir, "seats"))).toBe(false);
    } finally {
      chmodSync(rigDir, 0o755);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("says the outcome is unknown when the daemon's write times out, so it's checked before a retry", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "recap-daemon-timeout-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    const rigDir = join(tmp, "topology", "rigs", "r1");
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      mkdirSync(rigDir, { recursive: true });
      chmodSync(rigDir, 0o555);
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nnone");
      const post = vi.fn(async () => { throw new DaemonTimeoutError("Request to /api/context-packs/seat-recap timed out after 5000ms"); });

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap],
        { lifecycleDeps: lifecycleDeps(4242), clientFactory: (() => ({ post })) as never });

      expect(post).toHaveBeenCalledTimes(1);
      expect(res.exitCode).toBe(1);
      expect(res.errLogs.join("\n")).toContain("outcome is UNKNOWN");
    } finally {
      chmodSync(rigDir, 0o755);
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("says why it needed the daemon when the daemon can't be reached", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "recap-no-daemon-"));
    const saved = process.env["OPENRIG_TOPOLOGY_ROOT"];
    const rigDir = join(tmp, "topology", "rigs", "r1");
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      mkdirSync(rigDir, { recursive: true });
      chmodSync(rigDir, 0o555);
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nnone");

      const post = vi.fn(async () => { throw new DaemonConnectionError("connect ECONNREFUSED 127.0.0.1:4242", "ECONNREFUSED"); });

      const res = await runRecapWrite(["recap-write", "--rig", "r1", "--seat", "s1", "--file", recap],
        { lifecycleDeps: lifecycleDeps(4242), clientFactory: (() => ({ post })) as never });

      expect(res.exitCode).toBe(1);
      expect(res.errLogs[0]).toMatch(/can't write the topology tree \(EACCES.*\), so the daemon writes the recap instead/);
      expect(res.errLogs.slice(1).join("\n")).toMatch(/ECONNREFUSED|daemon/i);
    } finally {
      chmodSync(rigDir, 0o755);
      if (saved === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Every recap reader uses seats/<the part of the session name before @>, so a recap written under a member id or a
// logical id was left where nothing reads it (one seat had lead, editorial.lead and editorial-lead). A name maps only by
// the rig's recorded seats, never by its spelling: a suffix or a dot isn't identity.
describe("rig context recap-write — the seat folder every reader uses", () => {
  /** The rig's seats as the daemon records them (pod.member logical ids; custom.name is a self-attached session). */
  const recorded = [
    { logicalId: "editorial.lead", podNamespace: "editorial", canonicalSessionName: "editorial-lead@web-studio" },
    { logicalId: "ux.designer", podNamespace: "ux", canonicalSessionName: "ux-designer@web-studio" },
    { logicalId: "research.dev-qa", podNamespace: "research", canonicalSessionName: "research-dev-qa@web-studio" },
    { logicalId: "dev.qa", podNamespace: "dev", canonicalSessionName: "dev-qa@web-studio" },
    { logicalId: "custom", podNamespace: null, canonicalSessionName: "custom.name@web-studio" },
  ];
  const withSeats: StatusDeps = { lifecycleDeps: lifecycleDeps(4242), clientFactory: (() => ({
    get: async (path: string) => path === "/api/ps" ? { status: 200, data: [{ rigId: "rig-1", name: "web-studio" }] }
      : path === "/api/rigs/rig-1/nodes" ? { status: 200, data: recorded } : { status: 404, data: {} },
  })) as never };

  async function inTopology(session: string | undefined, run: (tmp: string, seats: string, recap: string) => Promise<void>) {
    const tmp = mkdtempSync(join(tmpdir(), "recap-seat-"));
    const saved = { root: process.env["OPENRIG_TOPOLOGY_ROOT"], session: process.env["OPENRIG_SESSION_NAME"], legacy: process.env["RIGGED_SESSION_NAME"] };
    try {
      process.env["OPENRIG_TOPOLOGY_ROOT"] = join(tmp, "topology");
      if (session === undefined) delete process.env["OPENRIG_SESSION_NAME"]; else process.env["OPENRIG_SESSION_NAME"] = session;
      delete process.env["RIGGED_SESSION_NAME"];
      const seats = join(tmp, "topology", "rigs", "web-studio", "seats");
      for (const folder of ["editorial-lead", "ux-designer", "research-dev-qa", "dev-qa", "custom.name"]) mkdirSync(join(seats, folder), { recursive: true });
      const recap = join(tmp, "recap.md");
      writeFileSync(recap, "## Recent Decisions\nchose X because Y");
      await run(tmp, seats, recap);
    } finally {
      for (const [key, value] of [["OPENRIG_TOPOLOGY_ROOT", saved.root], ["OPENRIG_SESSION_NAME", saved.session], ["RIGGED_SESSION_NAME", saved.legacy]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  const folders = (seats: string) => readdirSync(seats).sort();
  const standard = ["custom.name", "dev-qa", "editorial-lead", "research-dev-qa", "ux-designer"];

  it.each([
    { name: "no --rig or --seat: this seat", args: [] as string[], note: undefined },
    { name: "this seat's member id", args: ["--seat", "lead"], note: "--seat lead is the member id of editorial-lead@web-studio, so the recap goes to seats/editorial-lead" },
    { name: "this seat's logical id", args: ["--seat", "editorial.lead"], note: "--seat editorial.lead is the logical id of editorial-lead@web-studio" },
    { name: "the folder itself", args: ["--rig", "web-studio", "--seat", "editorial-lead"], note: undefined },
  ])("a seat writing its own recap lands in seats/editorial-lead ($name)", async ({ args, note }) => {
    await inTopology("editorial-lead@web-studio", async (tmp, seats, recap) => {
      const res = await runRecapWrite(["recap-write", ...args, "--file", recap], withSeats);
      expect(res.exitCode ?? 0).toBe(0);
      expect(readFileSync(join(seats, "editorial-lead", "RECAP.md"), "utf-8")).toContain("chose X because Y");
      // The handover's own reader finds it, from the session name alone.
      expect(resolveAuthoredRecapPointer("editorial-lead@web-studio", join(tmp, "topology"))).toMatchObject({ address: "seat:RECAP.md" });
      expect(folders(seats)).toEqual(standard);
      if (note) expect(res.errLogs.join("\n")).toContain(note);
      else expect(res.errLogs.join("\n")).not.toContain("Note:");
    });
  });

  it("another seat's exact folder is never mistaken for the caller, even when the caller's folder ends with it", async () => {
    await inTopology("research-dev-qa@web-studio", async (_tmp, seats, recap) => {
      const res = await runRecapWrite(["recap-write", "--seat", "dev-qa", "--file", recap], withSeats);
      expect(res.exitCode ?? 0).toBe(0);
      expect(existsSync(join(seats, "dev-qa", "RECAP.md"))).toBe(true);
      expect(existsSync(join(seats, "research-dev-qa", "RECAP.md"))).toBe(false);
      expect(res.errLogs.join("\n")).not.toContain("Note:");
    });
  });

  it.each(["custom.name@web-studio", "editorial-lead@web-studio"])("a dotted seat folder is used as given, not rewritten to a hyphen (caller %s)", async (session) => {
    await inTopology(session, async (_tmp, seats, recap) => {
      const res = await runRecapWrite(["recap-write", "--seat", "custom.name", "--file", recap], withSeats);
      expect(res.exitCode ?? 0).toBe(0);
      expect(existsSync(join(seats, "custom.name", "RECAP.md"))).toBe(true);
      expect(folders(seats)).toEqual(standard);
    });
  });

  it("another seat's recorded logical or member id maps to its folder; a name no seat has still writes, and says so", async () => {
    await inTopology("editorial-lead@web-studio", async (_tmp, seats, recap) => {
      const logical = await runRecapWrite(["recap-write", "--seat", "ux.designer", "--file", recap], withSeats);
      expect(existsSync(join(seats, "ux-designer", "RECAP.md"))).toBe(true);
      expect(logical.errLogs.join("\n")).toContain("--seat ux.designer is the logical id of ux-designer@web-studio");
      const member = await runRecapWrite(["recap-write", "--seat", "designer", "--file", recap], withSeats);
      expect(member.errLogs.join("\n")).toContain("--seat designer is the member id of ux-designer@web-studio");
      expect(folders(seats)).toEqual(standard);

      const unknown = await runRecapWrite(["recap-write", "--seat", "nobody", "--file", recap], withSeats);
      expect(unknown.exitCode ?? 0).toBe(0);
      expect(existsSync(join(seats, "nobody", "RECAP.md"))).toBe(true);
      expect(unknown.errLogs.join("\n")).toContain("seats/nobody didn't exist in rig web-studio, so this write created it.");
    });
  });

  it("when the daemon can't be asked, a name is written as given and the note says it wasn't checked", async () => {
    await inTopology("editorial-lead@web-studio", async (_tmp, seats, recap) => {
      const res = await runRecapWrite(["recap-write", "--seat", "lead", "--file", recap]);
      expect(res.exitCode ?? 0).toBe(0);
      expect(existsSync(join(seats, "lead", "RECAP.md"))).toBe(true);
      expect(res.errLogs.join("\n")).toContain("the name couldn't be checked against the rig's seats");
      // An existing folder, such as an old alias, is no proof of identity either, so the note is there too.
      const existing = await runRecapWrite(["recap-write", "--seat", "lead", "--file", recap]);
      expect(existing.exitCode ?? 0).toBe(0);
      expect(existing.errLogs.join("\n")).toContain("The recap went to the existing seats/lead as given, but the name couldn't be checked against the rig's seats");
    });
  });

  it("without OPENRIG_SESSION_NAME, --rig and --seat are named, not guessed", async () => {
    await inTopology(undefined, async (_tmp, seats, recap) => {
      const noRig = await runRecapWrite(["recap-write", "--file", recap]);
      expect(noRig.exitCode).toBe(1);
      expect(noRig.errLogs.join("\n")).toContain("Name the rig with --rig");
      const noSeat = await runRecapWrite(["recap-write", "--rig", "web-studio", "--file", recap]);
      expect(noSeat.exitCode).toBe(1);
      expect(noSeat.errLogs.join("\n")).toContain("Name the seat with --seat");
      expect(folders(seats)).toEqual(standard);
    });
  });
});
