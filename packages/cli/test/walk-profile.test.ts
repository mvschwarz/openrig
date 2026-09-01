// Test-A pre-drive (row 782b467a) — the WALK/PROFILE join: WALK consumes the
// AUTHORITATIVE composed profile (rig context profile's output, per-piece
// provenance intact) and reports delivered pieces BY IDENTITY (atomId+address),
// so the profile piece set and the delivered set are exact-comparable. The
// piece set is NEVER hand-authored; the smallest glue is a --through-profile
// input on the existing walk verb. NO-COPY: the bytes sent are the bytes the
// profile served — walk re-reads and re-composes nothing.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { walkCommand } from "../src/commands/walk.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { WalkDeps } from "../src/commands/walk.js";

const PROFILE_RESPONSE = {
  ref: "packs/world",
  situation: "handover",
  runtime: "claude",
  pieces: [
    { atomId: "welcome", address: "walk.md#welcome", sourceKind: "library", order: 1, priority: "core", text: "## Welcome\nhello world", estimatedTokens: 5 },
    { atomId: "recap", address: "seat:RECAP.md#recent-decisions", sourceKind: "seat", order: 9, priority: "core", text: "## Recent Decisions\nwe chose X", estimatedTokens: 6 },
  ],
  totalEstimatedTokens: 11,
  provenanceWarnings: [],
};

function mockLifecycle(port: number): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => (p === STATE_FILE
      ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-08-24T00:00:00Z" } as DaemonState)
      : null)),
    writeFile: vi.fn(), removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
  };
}

async function runWalk(port: number, argv: string[], failTransportAt?: number): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined; transportPayloads: string[]; profileRequestUrls: string[] }> {
  const transportPayloads: string[] = [];
  const profileRequestUrls: string[] = [];
  let sends = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      const url = req.url ?? "";
      if (url.startsWith("/api/context-packs/library/by-ref/profile")) {
        profileRequestUrls.push(url);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(PROFILE_RESPONSE));
      } else if (url === "/api/transport/send") {
        sends += 1;
        if (failTransportAt !== undefined && sends === failTransportAt) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "send failed" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        transportPayloads.push((JSON.parse(body) as { text: string }).text);
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const p = (server.address() as { port: number }).port;
  const deps: WalkDeps = {
    lifecycleDeps: mockLifecycle(p),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
    sleep: async () => {},
  };
  const logs: string[] = [];
  const errLogs: string[] = [];
  const origLog = console.log; const origErr = console.error;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };
  let exitCode: number | undefined;
  try {
    const program = new Command();
    program.exitOverride();
    program.addCommand(walkCommand(deps));
    await program.parseAsync(["node", "rig", "walk", ...argv]);
  } catch { /* exitOverride */ } finally {
    exitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = origLog; console.error = origErr;
    await new Promise<void>((r) => { server.close(() => r()); });
  }
  return { logs, errLogs, exitCode, transportPayloads, profileRequestUrls };
}

describe("rig walk --through-profile — the walk/profile join (Test-A)", () => {
  const ARGS = ["seat@rig", "--through-profile", "packs/world", "--situation", "handover", "--runtime", "claude", "--rig", "r1", "--seat-grant", "s1", "--pace", "0s", "--json"];

  it("IDENTITY EQUALITY: the delivered report equals the profile's piece identity list, in order, never hand-authored", async () => {
    const { logs, exitCode, transportPayloads } = await runWalk(0, ARGS);
    expect(exitCode ?? 0).toBe(0);
    const report = JSON.parse(logs[logs.length - 1]!) as { delivered: Array<{ atomId: string; address: string }> };
    expect(report.delivered).toEqual([
      { atomId: "welcome", address: "walk.md#welcome" },
      { atomId: "recap", address: "seat:RECAP.md#recent-decisions" },
    ]);
    expect(transportPayloads).toHaveLength(2);
  });

  it("NO-COPY: the bytes sent to the seat are exactly the bytes the profile served", async () => {
    const { transportPayloads } = await runWalk(0, ARGS);
    expect(transportPayloads).toEqual(["## Welcome\nhello world", "## Recent Decisions\nwe chose X"]);
  });

  it("accepts and forwards the exact slice grant alongside its mission", async () => {
    const { exitCode, profileRequestUrls } = await runWalk(0, [
      ...ARGS,
      "--mission", "release-0.5.7",
      "--slice", "10-work-install",
    ]);
    expect(exitCode ?? 0).toBe(0);
    const request = new URL(profileRequestUrls[0]!, "http://localhost");
    expect(request.searchParams.get("mission")).toBe("release-0.5.7");
    expect(request.searchParams.get("slice")).toBe("10-work-install");
  });

  it("MISMATCH VISIBLE: a mid-walk failure reports the delivered PREFIX vs the expected set, by identity", async () => {
    const { errLogs, logs, exitCode } = await runWalk(0, ARGS, 2);
    expect(exitCode).toBe(1);
    const err = errLogs.join("\n");
    expect(err).toContain("recap"); // the aborted piece named by identity
    const report = JSON.parse(logs[logs.length - 1]!) as { delivered: Array<{ atomId: string }>; expected: Array<{ atomId: string }> };
    expect(report.delivered.map((d) => d.atomId)).toEqual(["welcome"]);
    expect(report.expected.map((d) => d.atomId)).toEqual(["welcome", "recap"]);
  });

  it("mixing --through and --through-profile is rejected loud before any send", async () => {
    const { errLogs, exitCode, transportPayloads } = await runWalk(0, ["seat@rig", "--through", "a.md", "--through-profile", "packs/world", "--situation", "fresh"]);
    expect(exitCode).toBe(1);
    expect(errLogs.join("\n")).toMatch(/either .*--through|not both|mix/i);
    expect(transportPayloads).toHaveLength(0);
  });
});
