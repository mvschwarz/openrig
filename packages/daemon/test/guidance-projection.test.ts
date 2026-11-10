// What OpenRig wrote into a seat's guidance file, set against when the running agent loaded it. A block written since is
// projected, not in the agent's context; nothing here claims a block was read, and unknown stays unknown.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { mergeManagedBlock } from "../src/domain/managed-blocks.js";
import { managedBlockRecords } from "../src/domain/managed-block-records.js";
import { readGuidanceProjection, type GuidanceSession } from "../src/domain/guidance-projection.js";

const nodeFs = {
  exists: (p: string) => fs.existsSync(p),
  readFile: (p: string) => fs.readFileSync(p, "utf-8"),
  writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
  mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
};

describe("readGuidanceProjection", () => {
  let db: Database.Database;
  let tmp: string;
  let file: string;

  beforeEach(() => {
    db = createFullTestDb();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guidance-projection-"));
    file = path.join(tmp, "CLAUDE.md");
  });
  afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  /** Write a block as a launch does, and record the write at `at`. */
  function written(id: string, body: string, at: string) {
    mergeManagedBlock(nodeFs, file, id, body);
    managedBlockRecords(db, () => new Date(at)).set(file, id, body);
  }
  const launched = (startupCompletedAt: string | null): GuidanceSession => ({ origin: "launched", createdAt: "2026-11-10 09:59:00", startupCompletedAt });

  it("places each block before or after the startup that loaded the file, and names the ones written since", () => {
    fs.writeFileSync(file, "Person notes\n");
    written("openrig-start.md", "Identity.", "2026-11-10T09:59:30.000Z");
    written("openrig-context-entry.md", "Where things are.", "2026-11-10T12:00:00.000Z");
    const result = readGuidanceProjection({ db, file, runtime: "claude-code", session: launched("2026-11-10T10:00:00.000Z") });
    expect(result.loadedAt).toEqual({ at: "2026-11-10T10:00:00.000Z", basis: "startup_completed" });
    expect(result.blocks).toEqual([
      { id: "openrig-start.md", writtenAt: "2026-11-10T09:59:30.000Z", loaded: "before" },
      { id: "openrig-context-entry.md", writtenAt: "2026-11-10T12:00:00.000Z", loaded: "after" },
    ]);
    expect(result.detail).toContain("1 of the 2 OpenRig blocks");
    expect(result.detail).toContain("(openrig-context-entry.md)");
    expect(result.detail).toContain("after /compact or /clear");
    expect(result.detail).toContain("OpenRig doesn't record what an agent read.");
  });

  it("says Codex reads AGENTS.md at session start, and that a resume re-reading it isn't established", () => {
    file = path.join(tmp, "AGENTS.md");
    written("openrig-context-entry.md", "Where things are.", "2026-11-10T12:00:00.000Z");
    const result = readGuidanceProjection({ db, file, runtime: "codex", session: launched("2026-11-10T10:00:00.000Z") });
    expect(result.blocks[0]?.loaded).toBe("after");
    expect(result.detail).toContain("Codex reads it at session start");
    expect(result.detail).toContain("isn't established");
  });

  it("nothing written since: says so, and still doesn't claim the agent read anything", () => {
    written("openrig-start.md", "Identity.", "2026-11-10T09:59:30.000Z");
    const result = readGuidanceProjection({ db, file, runtime: "claude-code", session: launched("2026-11-10T10:00:00.000Z") });
    expect(result.blocks.map((block) => block.loaded)).toEqual(["before"]);
    expect(result.detail).toMatch(/^None of the 1 OpenRig blocks .* was written after this session's startup finished/);
    expect(result.detail).toContain("OpenRig doesn't record what an agent read.");
  });

  it("a claimed session places later writes, and an earlier write is unknown: its process started at some earlier moment", () => {
    written("CULTURE-default.md", "Culture.", "2026-11-07T18:00:00.000Z");
    written("openrig-context-entry.md", "Where things are.", "2026-11-09T17:17:26.292Z");
    // SQLite's datetime('now') text, UTC without a zone.
    const result = readGuidanceProjection({ db, file, runtime: "claude-code", session: { origin: "claimed", createdAt: "2026-11-07 18:51:57", startupCompletedAt: null } });
    expect(result.loadedAt).toEqual({ at: "2026-11-07 18:51:57", basis: "claimed" });
    expect(result.blocks.map((block) => [block.id, block.loaded])).toEqual([["CULTURE-default.md", "unknown"], ["openrig-context-entry.md", "after"]]);
    expect(result.detail).toContain("OpenRig recorded this session at 2026-11-07 18:51:57");
    expect(result.detail).toContain("already running when OpenRig recorded it");
  });

  it("compares SQLite's zone-less session times as UTC", () => {
    written("openrig-start.md", "Identity.", "2026-11-07T18:52:30.000Z");
    const result = readGuidanceProjection({ db, file, runtime: "claude-code", session: { origin: "claimed", createdAt: "2026-11-07 18:51:57", startupCompletedAt: null } });
    expect(result.blocks[0]?.loaded).toBe("after");
  });

  it("a launched session with no recorded startup finish can't place any block", () => {
    written("openrig-start.md", "Identity.", "2026-11-10T09:59:30.000Z");
    const result = readGuidanceProjection({ db, file, runtime: "claude-code", session: launched(null) });
    expect(result.loadedAt).toBeNull();
    expect(result.blocks.map((block) => block.loaded)).toEqual(["unknown"]);
    expect(result.detail).toContain("no recorded startup finish");
  });

  it("a block with no write record can't be placed, and is counted", () => {
    mergeManagedBlock(nodeFs, file, "SOP.md", "How work flows here.");
    const result = readGuidanceProjection({ db, file, runtime: "claude-code", session: launched("2026-11-10T10:00:00.000Z") });
    expect(result.blocks).toEqual([{ id: "SOP.md", writtenAt: null, loaded: "unknown" }]);
    expect(result.detail).toContain("1 block has no write record");
  });

  it("records that can't be read leave every block unknown, with the reason", () => {
    written("openrig-start.md", "Identity.", "2026-11-10T12:00:00.000Z");
    const broken = { prepare: () => { throw new Error("database is locked"); } } as unknown as Database.Database;
    const result = readGuidanceProjection({ db: broken, file, runtime: "claude-code", session: launched("2026-11-10T10:00:00.000Z") });
    expect(result.blocks.map((block) => block.loaded)).toEqual(["unknown"]);
    expect(result.detail).toContain("couldn't be read (database is locked)");
  });

  it("a missing file holds nothing; an unreadable one is unknown, not empty", () => {
    expect(readGuidanceProjection({ db, file, runtime: "claude-code", session: null }).detail).toContain("doesn't exist");
    const denied = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    const result = readGuidanceProjection({ db, file, runtime: "claude-code", session: null, readFile: denied });
    expect(result.blocks).toEqual([]);
    expect(result.detail).toContain("couldn't be read (EACCES)");
    expect(result.detail).toContain("unknown");
  });

  it("a file with no OpenRig blocks says so", () => {
    fs.writeFileSync(file, "Only the person's notes.\n");
    expect(readGuidanceProjection({ db, file, runtime: "claude-code", session: null }).detail).toContain("holds no OpenRig guidance blocks");
  });
});
