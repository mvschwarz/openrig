import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { providerCommand } from "../src/commands/provider.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

// Slice 18 — `rig provider moves` reads move reports back; `rig provider moves report` files one. The CLI only
// carries the file to the daemon's check and prints what it says; a refused report changes nothing.

function deps(port: number): StatusDeps {
  const lifecycleDeps = {
    spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), writeFile: vi.fn(), removeFile: vi.fn(),
    mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
    exists: vi.fn((p: string) => p === STATE_FILE),
    readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-10-23T00:00:00Z" }) : null)),
  } as unknown as LifecycleDeps;
  return { lifecycleDeps, clientFactory: (url) => new DaemonClient(url) };
}

async function run(args: string[], port: number): Promise<{ out: string; exitCode: number | undefined }> {
  const lines: string[] = [];
  const log = console.log, err = console.error, exit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    await providerCommand(deps(port)).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = log;
    console.error = err;
  }
  const exitCode = process.exitCode;
  process.exitCode = exit;
  return { out: lines.join("\n"), exitCode };
}

describe("rig provider moves", () => {
  let server: http.Server;
  let port: number;
  let seen: Array<{ method: string; url: string; body: string }> = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moves-cli-"));
  const reportFile = path.join(dir, "move.json");

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", body });
        res.writeHead(answer.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { seen = []; fs.writeFileSync(reportFile, JSON.stringify({ version: 1, host: "build-box", seats: [] })); });

  it("report carries the file, --to, --follows and --evidence-ref to the daemon, and says where it went", async () => {
    answer = { status: 201, body: { qitemId: "qitem-new", report: {} } };
    const { out, exitCode } = await run(["moves", "report", "--file", reportFile, "--to", "operator@kernel", "--follows", "qitem-old", "--evidence-ref", "moves/verify.json"], port);
    expect(exitCode).toBeUndefined();
    expect(out).toBe("Filed qitem-new to operator@kernel");
    expect(seen.map((r) => [r.method, r.url])).toEqual([["POST", "/api/provider/moves"]]);
    expect(JSON.parse(seen[0]!.body)).toEqual({
      to: "operator@kernel", evidenceRef: "moves/verify.json",
      report: { version: 1, host: "build-box", seats: [], follows: "qitem-old" },
    });
  });

  it("a refused report prints each check and the daemon's message, and exits 1", async () => {
    answer = {
      status: 400,
      body: { error: "move_report_invalid", errors: ["seats[0]: unconfirmed needs missing, what wasn't seen"], message: "Nothing was recorded, and the move itself is unchanged." },
    };
    const { out, exitCode } = await run(["moves", "report", "--file", reportFile, "--to", "operator@kernel"], port);
    expect(exitCode).toBe(1);
    expect(out).toBe("- seats[0]: unconfirmed needs missing, what wasn't seen\nNothing was recorded, and the move itself is unchanged.");
  });

  it("a file that isn't JSON is refused before anything is sent", async () => {
    fs.writeFileSync(reportFile, "{ not json");
    const { out, exitCode } = await run(["moves", "report", "--file", reportFile, "--to", "operator@kernel"], port);
    expect(exitCode).toBe(1);
    expect(out).toContain("Nothing was recorded, and the move itself is unchanged.");
    expect(seen).toEqual([]);
  });

  it("lists reports with each seat's result, the follow-up chain, and what couldn't be read", async () => {
    answer = {
      status: 200,
      body: {
        moves: [{
          qitemId: "qitem-1", reportedAt: "2026-10-23T12:00:00.000Z", reportedBy: "fleet@fleet", reportedTo: "operator@kernel", state: "pending", followedBy: ["qitem-2"],
          report: {
            host: "build-box", home: "/home/ubuntu/.codex", from: "codex-1", to: "codex-2", reason: "codex-1 nearly out",
            seats: [{ seat: "dev-impl@team", result: "moved" }, { seat: "dev-qa@team", result: "unconfirmed", missing: "no tool turn yet" }],
            peers: [{ seat: "dev-lead@team", note: "not restarted; account unverified" }],
          },
        }],
        unreadable: [{ qitemId: "qitem-x", reason: "no openrig-subscription-move block" }],
        truncated: true,
      },
    };
    const { out } = await run(["moves", "--seat", "dev-qa@team", "--limit", "5"], port);
    expect(seen[0]!.url).toBe("/api/provider/moves?seat=dev-qa%40team&limit=5");
    expect(out.split("\n")).toEqual([
      "2026-10-23T12:00:00.000Z  qitem-1  build-box /home/ubuntu/.codex: codex-1 → codex-2 (to operator@kernel)",
      "  why: codex-1 nearly out",
      "  dev-impl@team: moved",
      "  dev-qa@team: unconfirmed; missing: no tool turn yet",
      "  dev-lead@team: not restarted; account unverified",
      "  followed by qitem-2",
      "unreadable: qitem-x: no openrig-subscription-move block",
      "(only the newest 5 reports were read; older ones may exist: raise --limit)",
    ]);
    const json = await run(["moves", "--json"], port);
    expect(JSON.parse(json.out)).toEqual(answer.body);
  });
});
