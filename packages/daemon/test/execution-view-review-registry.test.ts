// The execution view reads the legacy global review registry once per read, not once per slice,
// and lets the event loop run while it does (450 registry files across 8 and 30 slices).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const hooks = vi.hoisted(() => ({ onRead: null as null | ((file: string) => void) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
    hooks.onRead?.(String(args[0]));
    return actual.readFileSync(...args);
  }) };
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { buildExecutionView, type ExecutionViewDeps } from "../src/domain/execution-view.js";
import { readProjectReadiness } from "../src/domain/proof/judgments.js";

const SHA = "a".repeat(40);
const REGISTRY_FILES = 450;
const readFileSync = vi.mocked(fs.readFileSync);

describe("execution view review registry", () => {
  let tmp: string;
  let db: Database.Database;
  let registryDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exec-registry-"));
    registryDir = path.join(tmp, "rigs", "fixture", "state", "review-fixture");
    fs.mkdirSync(registryDir, { recursive: true });
    db = createDb();
    migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, queueItemsSchema, queueItemSummarySchema, queueTransitionsSchema]);
    readFileSync.mockClear();
  });
  afterEach(() => {
    hooks.onRead = null;
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A mission of built slices; registry file i reviews slice i % (slices + 1), the last being no slice here. */
  function fixture(mission: string, slices: number): ExecutionViewDeps {
    const insert = db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session,
      state, priority, tier, tags, body) VALUES (?, ?, ?, 'lead@fixture', 'builder@fixture', 'done', 'normal', 'light', ?, ?)`);
    for (let s = 0; s < slices; s++) {
      const id = `S${String(s).padStart(2, "0")}`;
      const dir = path.join(tmp, "missions", mission, "slices", id);
      fs.mkdirSync(path.join(dir, "proof"), { recursive: true });
      fs.writeFileSync(path.join(dir, "SPEC.md"), `---\nid: ${id}\n---\n# ${id}\n`);
      insert.run(`qitem-${mission}-${id}`, "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z",
        JSON.stringify([`mission:${mission}`, `slice:${id}`, `candidate:${SHA}`]), "worktree_path=/fixture/repo\n");
    }
    // A local review drop leads its slice's legs; a local QA drop is never a review leg.
    const proof = path.join(tmp, "missions", mission, "slices", "S00", "proof");
    fs.writeFileSync(path.join(proof, "local.md"), `---\nslice: S00\nartifact_type: adjudication\nverdict: CLEAR\ncandidate_sha: ${SHA}\n---\n`);
    fs.writeFileSync(path.join(proof, "qa.md"), `---\nslice: S00\nartifact_type: qa\nverdict: BLOCKING\ncandidate_sha: ${SHA}\n---\n`);
    for (let i = 0; i < REGISTRY_FILES; i++) {
      const target = i % (slices + 1);
      const slice = target === slices ? "ELSEWHERE" : `S${String(target).padStart(2, "0")}`;
      fs.writeFileSync(path.join(registryDir, `r${String(i).padStart(3, "0")}.md`),
        `---\nslice: ${slice}\nartifact_type: rev1-r${1 + (i % 2)}\nverdict: CLEAR\ncandidate_sha: ${SHA}\n---\n`);
    }
    return {
      db,
      slicesRoot: () => path.join(tmp, "missions"),
      rigsRoot: () => path.join(tmp, "rigs"),
      buildInfo: { semver: null, commit: null, dirty: null, builtAt: null },
      now: () => new Date("2026-11-05T20:00:00.000Z"),
      exec: async (_cmd: string, args: string[]) => (args.includes("--git-dir") ? ".git" : SHA),
    };
  }

  const registryReads = () => readFileSync.mock.calls.filter(([file]) => String(file).startsWith(registryDir)).length;

  it.each([8, 30])("reads the 450-file registry once per read for %i slices, and again on the next read", async (slices) => {
    const deps = fixture(`m${slices}`, slices);
    const doc = await buildExecutionView(deps, { mission: `m${slices}` });
    expect(registryReads()).toBe(REGISTRY_FILES);
    const ladder = doc["q4_ladder"] as Array<{ reviewed: { legs: Array<{ path: string }> } }>;
    expect(ladder).toHaveLength(slices);
    for (let s = 0; s < slices; s++) {
      const global = Array.from({ length: REGISTRY_FILES }, (_, i) => i).filter((i) => i % (slices + 1) === s)
        .map((i) => path.join(registryDir, `r${String(i).padStart(3, "0")}.md`));
      const local = s === 0 ? [path.join(tmp, "missions", `m${slices}`, "slices", "S00", "proof", "local.md")] : [];
      expect(ladder[s]!.reviewed.legs.map((leg) => leg.path)).toEqual([...local, ...global]);
    }
    await buildExecutionView(deps, { mission: `m${slices}` });
    expect(registryReads()).toBe(2 * REGISTRY_FILES);
  });

  it("never reads the global registry for a project-scoped read", async () => {
    await buildExecutionView(fixture("scoped", 8), { mission: "scoped", project: "fixture-project" });
    expect(registryReads()).toBe(0);
  });

  it("lets the event loop run while one read traverses the registry", async () => {
    const deps = fixture("turns", 8);
    let turns = 0;
    let ticking = true;
    const tick = () => { turns++; if (ticking) setImmediate(tick); };
    const turnsAtRead: number[] = [];
    hooks.onRead = (file) => { if (file.startsWith(registryDir)) turnsAtRead.push(turns); };
    setImmediate(tick);
    try {
      await buildExecutionView(deps, { mission: "turns" });
    } finally {
      ticking = false;
    }
    // Other callbacks ran between the first and the last file of one traversal, not only around it.
    expect(turnsAtRead[REGISTRY_FILES - 1]! - turnsAtRead[0]!).toBeGreaterThan(0);
    expect(turnsAtRead).toHaveLength(REGISTRY_FILES);
  });

  it("also yields inside the later whole-project readiness read, preserving its projection", async () => {
    const deps = fixture("turns", 2), missions = deps.slicesRoot()!;
    for (const name of ["beta", "gamma"]) {
      fs.mkdirSync(path.join(missions, name));
      fs.writeFileSync(path.join(missions, name, "mission.yaml"), "kind: mission\ncomposition: { slices: [] }\n");
    }
    const first = fs.readdirSync(missions).slice(0, -1).find(name => name !== "turns")!;
    let started = false, yielded = false;
    hooks.onRead = file => {
      if (!started && file === path.join(missions, first, "mission.yaml")) {
        started = true;
        setImmediate(() => { yielded = true; });
      }
    };
    const doc = await buildExecutionView(deps, { mission: "turns" });
    expect(started).toBe(true);
    expect(yielded, "earlier registry yields must not hide a later synchronous project walk").toBe(true);
    hooks.onRead = null;
    expect(doc.project_readiness).toEqual(readProjectReadiness(missions));
  });
});
