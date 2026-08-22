// Founder-priority hotfix (row qitem-20260822230440-da0d2ad6, FIX 2; shape from
// row 9e0a051e): createTestApp left `permissionDriftObserver` undefined, so
// server.ts's createApp constructed the PRODUCTION PermissionDriftObserver —
// whose constructor warms a ClaudePermissionModeCache, which shells out
// `claude --help`. Across the daemon suite that was 162 REAL claude launches
// from 46 concurrent test files: a hermeticity hole burning both machines.
//
// This pin: building the test app must never exec a real runtime binary. The
// drift-observer's own tests construct the class directly and explicitly —
// that remains the one sanctioned path to the production observer in tests.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";

const execFileCalls: unknown[][] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: ((...args: unknown[]) => {
      execFileCalls.push(args);
      const cb = args[args.length - 1];
      if (typeof cb === "function") (cb as (err: Error) => void)(new Error("hermetic-block"));
      return undefined as never;
    }) as typeof actual.execFile,
  };
});

import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("test-app hermeticity — no real runtime binaries from the harness itself", () => {
  let db: Database.Database;

  beforeEach(() => {
    execFileCalls.length = 0;
    db = createFullTestDb();
  });

  it("createTestApp never launches a real `claude` (or any) binary just by being constructed", async () => {
    const { app } = createTestApp(db);
    // One ordinary request, so lazily-constructed route deps get exercised too.
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);

    const claudeCalls = execFileCalls.filter((args) => args[0] === "claude");
    expect(claudeCalls).toEqual([]);
    expect(execFileCalls).toEqual([]);
  });

  it("an explicitly injected drift observer still reaches the app (the opt-in path stays open)", async () => {
    const diagnose = vi.fn(() => null);
    const { app } = createTestApp(db, { permissionDriftObserver: { diagnose } });
    expect(app).toBeDefined();
    expect(execFileCalls).toEqual([]);
  });
});
