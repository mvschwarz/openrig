// OPR.0.4.3.05 — `rig fork` verb tests. Proves the CLI composes the daemon
// fork composer, surfaces honest errors, reports the successor + kept image,
// and never prints a native resume id (kept daemon-local by the route).

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Command } from "commander";
import { forkCommand } from "../src/commands/fork.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import http from "node:http";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

const OK = {
  ok: true,
  result: { podId: "p1", podNamespace: "dev", node: { logicalId: "dev.forked", nodeId: "n2", status: "launched", sessionName: "forked@dst" }, warnings: [] },
};
const OK_KEEP = { ...OK, image: { id: "agent-image:kept:1", name: "kept", version: "1", pinned: true } };
const NO_TOKEN = { error: "resume_token_unavailable", message: "Could not discover a resume token ... No token was fabricated and no fresh seat was cold-started." };
const CONFLICT = { ok: false, code: "member_conflict", message: 'Member "dev.forked" already exists in rig "dst". Pick a different member id, or remove the existing seat first.' };
// The daemon's rig summary: the help examples' rig by name, and a name two rigs share.
const RIGS = [
  { id: "01RIGDELIVERY", name: "openrig-delivery", archivedAt: null },
  { id: "01TWINA", name: "twin", archivedAt: null },
  { id: "01TWINB", name: "twin", archivedAt: null },
];

describe("rig fork", () => {
  let server: http.Server;
  let port: number;
  let capturedBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url?.startsWith("/api/rigs/summary")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(RIGS));
      } else if (req.method === "POST" && req.url?.includes("/agent-images/fork")) {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          const parsed = JSON.parse(body);
          capturedBody = parsed;
          if (parsed.member === "notoken") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify(NO_TOKEN));
          } else if (parsed.member === "dupe") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify(CONFLICT));
          } else if (parsed.keepImage) {
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify(OK_KEEP));
          } else {
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify(OK));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => { server.listen(0, r); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function runningDeps(): StatusDeps {
    return {
      lifecycleDeps: {
        ...mockLifecycleDeps(),
        exists: vi.fn((p: string) => p === STATE_FILE),
        readFile: vi.fn((p: string) => p === STATE_FILE
          ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-07T00:00:00Z" } as DaemonState)
          : null),
        fetch: vi.fn(async () => ({ ok: true })),
      },
      clientFactory: (url) => new DaemonClient(url),
    };
  }

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(forkCommand(runningDeps()));
    return prog;
  }

  it("the help's own first example works as written: its rig name resolves to the rig's id", async () => {
    const fork = forkCommand(runningDeps());
    let help = "";
    fork.configureOutput({ writeOut: (s) => { help += s; } });
    fork.outputHelp();
    const example = help.split("\n").map((line) => line.trim()).find((line) => line.startsWith("rig fork ") && line.includes("--rig openrig-delivery"))!;
    capturedBody = null;
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", ...example.split(/\s+/)]);
    });
    expect(exitCode).toBeUndefined();
    expect(capturedBody).toMatchObject({ sourceSession: "dev-impl@openrig-delivery", rigId: "01RIGDELIVERY", pod: "dev" });
  });

  it("refuses a rig name two rigs share, before any fork request, and names both ids", async () => {
    capturedBody = null;
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "fork", "dev-impl@src", "--rig", "twin", "--pod", "dev", "--member", "forked"]);
    });
    expect(exitCode).toBe(1);
    expect(capturedBody).toBeNull();
    expect(logs.join("\n")).toMatch(/'twin' matches 2 rigs.*01TWINA, 01TWINB/);
  });

  it("default fork posts the composer body and reports the one-shot successor", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "fork", "dev-impl@src", "--rig", "dst-rig", "--pod", "dev", "--member", "forked"]);
    });
    expect(exitCode).toBeUndefined();
    expect(capturedBody).toMatchObject({ sourceSession: "dev-impl@src", rigId: "dst-rig", pod: "dev", member: "forked" });
    expect(capturedBody!.keepImage).toBeUndefined();
    const out = logs.join("\n");
    expect(out).toContain("[OK] dev.forked");
    expect(out).toContain("forked@dst");
    expect(out).toContain("One-shot fork");
  });

  it("--keep-image sends keepImage and reports the pinned image", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "fork", "dev-impl@src", "--rig", "dst-rig", "--pod", "dev", "--member", "kept-fork", "--keep-image", "--image-name", "kept"]);
    });
    expect(capturedBody).toMatchObject({ keepImage: true, imageName: "kept" });
    const out = logs.join("\n");
    expect(out).toContain("Kept image: kept v1 (pinned, protected from prune)");
  });

  it("--json emits the raw response", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "fork", "dev-impl@src", "--rig", "dst-rig", "--pod", "dev", "--member", "forked", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.result.node.logicalId).toBe("dev.forked");
  });

  it("no-resume-token → exit 1 with the honest (no-fabrication) message", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "fork", "dev-impl@src", "--rig", "dst-rig", "--pod", "dev", "--member", "notoken"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toMatch(/fabricated/i);
  });

  it("member_conflict → exit 1 with the honest conflict message", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "fork", "dev-impl@src", "--rig", "dst-rig", "--pod", "dev", "--member", "dupe"]);
    });
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("already exists");
  });

  it("requires --rig, --pod, --member", async () => {
    let threw = false;
    await captureLogs(async () => {
      try {
        await makeCmd().parseAsync(["node", "rig", "fork", "dev-impl@src"]);
      } catch { threw = true; }
    });
    expect(threw).toBe(true); // commander exitOverride throws on missing required options
  });
});
