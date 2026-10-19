// OPR.0.7.0.18: `rig provider moves` (record, list, show) as an agent runs it — the CLI from this checkout's source, its
// seat identity from the environment — against the daemon's real provider routes and event log over HTTP.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";

// Run from source (tsx), so the test needs no prior build.
const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const AGENT = "fleet@ops-rig";

describe("rig provider moves", () => {
  let db: Database.Database;
  let server: ServerType;
  let url: string;
  let root: string;
  let settingsFile: string;

  beforeEach(async () => {
    delete process.env["OPENRIG_PROVIDER_SUBSCRIPTION_MOVES"];
    root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-moves-"));
    // The daemon's provider.subscription_moves switch, on unless a test turns it off.
    settingsFile = path.join(root, "daemon-config.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ provider: { subscriptionMoves: true } }));
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const { app } = createTestApp(db, { appDeps: { settingsStore: new SettingsStore(settingsFile) } });
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function rig(args: string[], seat: string | null = AGENT) {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, OPENRIG_HOME: path.join(root, "openrig"), OPENRIG_URL: url };
    if (seat) env.OPENRIG_SESSION_NAME = seat;
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, ["--import", "tsx", CLI, ...args], { env, cwd: fileURLToPath(new URL("..", import.meta.url)) }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
      });
    });
  }

  it("records a move from a file under the agent's seat, then lists and shows it", async () => {
    const file = path.join(root, "move.json");
    fs.writeFileSync(file, JSON.stringify({
      home: "/home/dev/.codex-team-a", host: "box-2", from: "codex-sub-A", to: "codex-sub-B",
      reason: "A near its weekly limit; B has room.",
      readings: [{ subject: "codex-sub-A weekly", observedAt: "2026-10-18T09:56:00Z", summary: "92% used" }],
      seats: [{ seat: "dev-impl@team", result: "moved", evidence: "verify: moved" }],
      peers: [{ seat: "dev-svc@team", note: "not restarted; account unverified" }],
    }));
    const recorded = await rig(["provider", "moves", "record", "--file", file, "--json"]);
    expect(recorded.code).toBe(0);
    const { move } = JSON.parse(recorded.stdout) as { move: { id: string; recordedBy: string } };
    expect(move.recordedBy).toBe(AGENT);

    const listed = await rig(["provider", "moves", "--seat", "dev-svc@team", "--json"]);
    expect(JSON.parse(listed.stdout)).toMatchObject({ moves: [{ id: move.id, reason: "A near its weekly limit; B has room." }] });
    const shown = await rig(["provider", "moves", "show", move.id, "--json"]);
    expect(JSON.parse(shown.stdout)).toMatchObject({ move: { id: move.id, peers: [{ seat: "dev-svc@team" }] } });
  }, 30_000);

  it("records a named operator from a shell with no seat identity", async () => {
    const file = path.join(root, "op.json");
    fs.writeFileSync(file, JSON.stringify({
      home: "/home/dev/.codex-team-a", from: "codex-sub-A", to: "codex-sub-B", reason: "Moved by hand.",
      readings: [{ subject: "codex-sub-A weekly", observedAt: "2026-10-18T09:56:00Z", summary: "92% used" }],
      seats: [{ seat: "dev-impl@team", result: "unconfirmed", missing: "no tool turn yet" }],
    }));
    const recorded = await rig(["provider", "moves", "record", "--file", file, "--operator", "alex (terminal)", "--json"], null);
    expect(recorded.code).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({ move: { recordedBy: "alex (terminal)", recordedVia: "claimed:v1" } });
  }, 30_000);

  it("explains how to name an actor when recording from an unmanaged shell", async () => {
    const file = path.join(root, "actor-missing.json");
    fs.writeFileSync(file, JSON.stringify({
      home: "/home/test/.codex", from: "A", to: "B", reason: "fixture move",
      readings: [{ subject: "A", observedAt: "2026-10-18T09:56:00Z", summary: "near limit" }],
      seats: [{ seat: "dev@team", result: "unconfirmed", missing: "not observed" }],
    }));
    const result = await rig(["provider", "moves", "record", "--file", file], null);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("name one, or run from a managed seat");
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'subscription.move_recorded'").get()).toEqual({ n: 0 });
  }, 30_000);

  it("reports a malformed move and records nothing", async () => {
    const file = path.join(root, "bad.json");
    fs.writeFileSync(file, JSON.stringify({ home: "h", from: "A", to: "B", reason: "r", seats: [],
      readings: [{ subject: "A", observedAt: "2026-10-18T09:56:00Z", summary: "92%" }] }));
    const result = await rig(["provider", "moves", "record", "--file", file]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("seats or peers must name at least one seat");
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'subscription.move_recorded'").get()).toEqual({ n: 0 });
  }, 30_000);

  it("with the daemon's switch off, says how to turn it on, exits 1 and records nothing", async () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ provider: { subscriptionMoves: false } }));
    const file = path.join(root, "move.json");
    fs.writeFileSync(file, JSON.stringify({
      home: "/home/dev/.codex-team-a", host: "box-2", from: "codex-sub-A", to: "codex-sub-B", reason: "room on B",
      readings: [{ subject: "codex-sub-A weekly", observedAt: "2026-10-18T09:56:00Z", summary: "92% used" }],
      seats: [{ seat: "dev-impl@team", result: "moved", evidence: "verify: moved" }], peers: [],
    }));
    const off = "The subscription move record is off on this daemon. Turn it on with: rig config set provider.subscription_moves true";
    for (const args of [["record", "--file", file], ["--json"], ["show", "move-20261018100000-0123abcd"]]) {
      const got = await rig(["provider", "moves", ...args]);
      expect([got.code, got.stderr.trim(), got.stdout]).toEqual([1, off, ""]);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'subscription.move_recorded'").get() as { n: number }).n).toBe(0);
  });

  it("names the switch in its help", async () => {
    const help = await rig(["provider", "moves", "record", "--help"]);
    expect(help.stdout).toContain("rig config set provider.subscription_moves true");
    const list = await rig(["provider", "--help"]);
    expect(list.stdout.replace(/\s+/g, " ")).toContain("needs provider.subscription_moves on");
  });
});
