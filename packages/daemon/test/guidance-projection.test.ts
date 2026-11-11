// When OpenRig wrote each block in a seat's guidance file, set against a recorded moment of the running session. That's
// chronology, not loading or reading; nothing here claims a block reached the agent, and unknown stays unknown.
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
  const read = (session: GuidanceSession | null, runtime = "claude-code") => readGuidanceProjection({ db, file, runtime, session });

  it("places each write before or after the session's recorded startup finish, and names the ones after it", () => {
    fs.writeFileSync(file, "Person notes\n");
    written("openrig-start.md", "Identity.", "2026-11-10T09:59:30.000Z");
    written("openrig-context-entry.md", "Where things are.", "2026-11-10T12:00:00.000Z");
    const result = read(launched("2026-11-10T10:00:00.000Z"));
    expect(result.mark).toEqual({ at: "2026-11-10T10:00:00.000Z", kind: "startup_finished" });
    expect(result.blocks).toEqual([
      { id: "openrig-start.md", writtenAt: "2026-11-10T09:59:30.000Z", written: "before" },
      { id: "openrig-context-entry.md", writtenAt: "2026-11-10T12:00:00.000Z", written: "after" },
    ]);
    expect(result.detail).toContain("1 was written after this session's recorded startup finish at 2026-11-10T10:00:00.000Z (openrig-context-entry.md)");
    expect(result.detail).toContain("1 before it");
    expect(result.detail).toContain("OpenRig doesn't record what an agent read.");
  });

  // A write before the startup mark isn't a claim that the agent had it: the harness read the file earlier in startup, and
  // a readiness recovery can set the mark long after. The report says it's chronology.
  it("a write before a later readiness mark reads 'before' the mark, and the report says that's chronology, not loading", () => {
    written("CULTURE-default.md", "Culture, rewritten by another seat's launch after this harness read the file.", "2026-11-10T10:05:00.000Z");
    const result = read(launched("2026-11-10T11:00:00.000Z"));
    expect(result.blocks[0]?.written).toBe("before");
    expect(result.detail).toContain("chronology, not loading");
    expect(result.detail).not.toMatch(/was in the file when|loaded it|has them/);
  });

  it("names the ways a running agent can get a later block, without saying any of them happened", () => {
    written("openrig-context-entry.md", "Where things are.", "2026-11-10T12:00:00.000Z");
    const claude = read(launched("2026-11-10T10:00:00.000Z")).detail;
    expect(claude).toContain("Claude Code reloads CLAUDE.md at session start and after /compact or /clear");
    expect(claude).toContain("rig send, rig walk or the refocus hook");
    expect(claude).not.toContain("only if");
    file = path.join(tmp, "AGENTS.md");
    written("openrig-context-entry.md", "Where things are.", "2026-11-10T12:00:00.000Z");
    const codex = read(launched("2026-11-10T10:00:00.000Z"), "codex").detail;
    expect(codex).toContain("Codex reads AGENTS.md at session start");
    expect(codex).toContain("isn't established");
    expect(codex).not.toContain("only if");
  });

  // The record is OpenRig's last write. A person can edit the block afterwards, and a later write whose record didn't save
  // leaves the older record: either way the bytes in the file aren't the ones the record's time belongs to.
  it("a block edited since OpenRig's recorded write can't be placed", () => {
    written("SOP.md", "How work flows here.", "2026-11-10T09:59:30.000Z");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("How work flows here.", "How work flows here, edited by hand."));
    const result = read(launched("2026-11-10T10:00:00.000Z"));
    expect(result.blocks).toEqual([{ id: "SOP.md", writtenAt: null, written: "unknown", reason: "differs from OpenRig's last recorded write" }]);
  });

  it("a later write whose record didn't save, so the record belongs to older bytes, can't be placed", () => {
    written("SOP.md", "Version one.", "2026-11-10T09:59:30.000Z");
    mergeManagedBlock(nodeFs, file, "SOP.md", "Version two, written at 12:00 with no record saved.");
    const result = read(launched("2026-11-10T10:00:00.000Z"));
    expect(result.blocks[0]).toMatchObject({ written: "unknown", reason: "differs from OpenRig's last recorded write" });
  });

  // A block missing its END marker has no complete body to match against the record, so it gets no time from it; nor does
  // an unclosed copy beside a complete matching one.
  it("a recorded block whose END marker is gone can't be placed, and borrows no time", () => {
    written("SOP.md", "How work flows here.", "2026-11-10T09:59:30.000Z");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("<!-- END OpenRig MANAGED BLOCK: SOP.md -->", ""));
    const result = read(launched("2026-11-10T10:00:00.000Z"));
    expect(result.blocks).toEqual([{ id: "SOP.md", writtenAt: null, written: "unknown", reason: "holds only part of this block" }]);
  });

  it("a complete matching block followed by an unclosed copy of the same id can't be placed", () => {
    written("SOP.md", "How work flows here.", "2026-11-10T09:59:30.000Z");
    fs.appendFileSync(file, "\n<!-- BEGIN OpenRig MANAGED BLOCK: SOP.md -->\nHow work flows here.\n");
    const result = read(launched("2026-11-10T10:00:00.000Z"));
    expect(result.blocks).toEqual([{ id: "SOP.md", writtenAt: null, written: "unknown", reason: "holds only part of this block" }]);
  });

  it("a sole unplaced block is never summarised as 'none written after'", () => {
    mergeManagedBlock(nodeFs, file, "SOP.md", "How work flows here.");
    const result = read(launched("2026-11-10T10:00:00.000Z"));
    expect(result.blocks).toEqual([{ id: "SOP.md", writtenAt: null, written: "unknown", reason: "no write record" }]);
    expect(result.detail).not.toMatch(/none/i);
    expect(result.detail).toContain("1 can't be placed (no write record: 1)");
  });

  it("mixed placed and unplaced blocks are counted, never summarised as 'none written after'", () => {
    written("openrig-start.md", "Identity.", "2026-11-10T09:59:30.000Z");
    mergeManagedBlock(nodeFs, file, "SOP.md", "How work flows here.");
    const result = read(launched("2026-11-10T10:00:00.000Z"));
    expect(result.blocks.map((block) => block.written)).toEqual(["before", "unknown"]);
    expect(result.detail).not.toMatch(/none/i);
    expect(result.detail).toContain("0 were written after");
    expect(result.detail).toContain("1 before it, and 1 can't be placed");
  });

  it("a time that can't be read is never 'before': an unreadable write time or session mark reads unknown", () => {
    written("openrig-start.md", "Identity.", "2026-11-10T09:59:30.000Z");
    db.prepare("UPDATE managed_block_writes SET written_at = 'not a time'").run();
    expect(read(launched("2026-11-10T10:00:00.000Z")).blocks[0]).toMatchObject({ written: "unknown", reason: "its write time can't be read" });
    db.prepare("UPDATE managed_block_writes SET written_at = '2026-11-10T09:59:30.000Z'").run();
    expect(read(launched("garbage")).blocks[0]).toMatchObject({ written: "unknown", reason: "the session time can't be read" });
  });

  it("a claimed session places later writes, and an earlier write is unknown: its process started at some earlier moment", () => {
    written("CULTURE-default.md", "Culture.", "2026-11-07T18:00:00.000Z");
    written("openrig-context-entry.md", "Where things are.", "2026-11-09T17:17:26.292Z");
    // SQLite's datetime('now') text, UTC without a zone.
    const result = read({ origin: "claimed", createdAt: "2026-11-07 18:51:57", startupCompletedAt: null });
    expect(result.mark).toEqual({ at: "2026-11-07 18:51:57", kind: "session_recorded" });
    expect(result.blocks.map((block) => [block.id, block.written])).toEqual([["CULTURE-default.md", "unknown"], ["openrig-context-entry.md", "after"]]);
    expect(result.blocks[0]?.reason).toContain("already running");
    expect(result.detail).toContain("after OpenRig recorded this session at 2026-11-07 18:51:57");
  });

  it("compares SQLite's zone-less session times as UTC", () => {
    written("openrig-start.md", "Identity.", "2026-11-07T18:52:30.000Z");
    const result = read({ origin: "claimed", createdAt: "2026-11-07 18:51:57", startupCompletedAt: null });
    expect(result.blocks[0]?.written).toBe("after");
  });

  it("a launched session with no recorded startup finish can't place any write", () => {
    written("openrig-start.md", "Identity.", "2026-11-10T09:59:30.000Z");
    const result = read(launched(null));
    expect(result.mark).toBeNull();
    expect(result.blocks[0]).toMatchObject({ written: "unknown", reason: "this session has no recorded startup finish" });
    expect(result.detail).not.toMatch(/none/i);
  });

  it("records that can't be read leave every block unknown, with the reason", () => {
    written("openrig-start.md", "Identity.", "2026-11-10T12:00:00.000Z");
    const broken = { prepare: () => { throw new Error("database is locked"); } } as unknown as Database.Database;
    const result = readGuidanceProjection({ db: broken, file, runtime: "claude-code", session: launched("2026-11-10T10:00:00.000Z") });
    expect(result.blocks.map((block) => block.written)).toEqual(["unknown"]);
    expect(result.detail).toContain("couldn't be read (database is locked)");
  });

  it("a missing file holds nothing; an unreadable one is unknown, not empty", () => {
    expect(read(null).detail).toContain("doesn't exist");
    const denied = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
    const result = readGuidanceProjection({ db, file, runtime: "claude-code", session: null, readFile: denied });
    expect(result.blocks).toEqual([]);
    expect(result.detail).toContain("couldn't be read (EACCES)");
  });

  it("a file with no OpenRig blocks says so", () => {
    fs.writeFileSync(file, "Only the person's notes.\n");
    expect(read(null).detail).toContain("holds no OpenRig guidance blocks");
  });
});
