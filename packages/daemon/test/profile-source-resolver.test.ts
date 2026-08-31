// OPR.0.5.3.5 Atom 4a — the two pre-`#` resolvers behind ONE grammar
// (Q2-Amendment 1, the desk's grammar ruling): non-library sources use the SAME
// `#H2-slug/H3-slug` grammar; only the pre-`#` resolver differs — a library ref
// resolves against the pack, a tree ref (`project:` / `seat:` / `mission:` prefix) resolves
// from CONFIGURED roots (CE-v2 03-tree-addressability: from config, never
// literals) — and both resolve FAIL-LOUD. No second addressing convention.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  parseSourceRef,
  makeProfileReadFile,
  sourceKindForAddress,
  SourceResolutionError,
} from "../src/domain/context-packs/profile-source-resolver.js";

let root: string;
let packDir: string;
let projectRoot: string;
let seatRoot: string;
let missionRoot: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "s05-sources-"));
  packDir = join(root, "pack");
  projectRoot = join(root, "project-tree");
  seatRoot = join(root, "seat-tree");
  missionRoot = join(root, "mission-tree");
  for (const d of [packDir, projectRoot, seatRoot, missionRoot]) mkdirSync(d, { recursive: true });
  writeFileSync(join(packDir, "walk.md"), "## Welcome\nhello");
  writeFileSync(join(projectRoot, "SPEC.md"), "# Project\nproject intent");
  writeFileSync(join(seatRoot, "RECAP.md"), "## Recent Decisions\nwe chose X because Y");
  writeFileSync(join(missionRoot, "NOTES.md"), "## Watch Items\nW-1");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseSourceRef — one grammar, the pre-# kind prefix", () => {
  it("bare refs are library; project:/seat:/mission: prefixes name the tree resolvers", () => {
    expect(parseSourceRef("walk.md")).toEqual({ kind: "library", rel: "walk.md" });
    expect(parseSourceRef("project:SPEC.md")).toEqual({ kind: "project", rel: "SPEC.md" });
    expect(parseSourceRef("seat:RECAP.md")).toEqual({ kind: "seat", rel: "RECAP.md" });
    expect(parseSourceRef("mission:notes/NOTES.md")).toEqual({ kind: "mission", rel: "notes/NOTES.md" });
  });
  it("fails loud on an unknown prefix and on traversal-shaped refs (never a stack trace, never an escape)", () => {
    expect(() => parseSourceRef("library2:x.md")).toThrow(SourceResolutionError);
    expect(() => parseSourceRef("seat:../LEARNED.md")).toThrow(SourceResolutionError);
    expect(() => parseSourceRef("seat:/etc/passwd")).toThrow(SourceResolutionError);
    expect(() => parseSourceRef("seat:")).toThrow(SourceResolutionError);
  });
});

describe("makeProfileReadFile — config-resolved roots, fail-loud reads", () => {
  it("dispatches library refs to the pack dir and tree refs to their configured roots", () => {
    const read = makeProfileReadFile({ packDir, roots: { project: projectRoot, seat: seatRoot, mission: missionRoot } });
    expect(read("walk.md")).toContain("hello");
    expect(read("project:SPEC.md")).toContain("project intent");
    expect(read("seat:RECAP.md")).toContain("we chose X because Y");
    expect(read("mission:NOTES.md")).toContain("W-1");
  });

  it("a missing file fails loud NAMING the source kind and the resolved path", () => {
    const read = makeProfileReadFile({ packDir, roots: { seat: seatRoot, mission: missionRoot } });
    try {
      read("seat:GONE.md");
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SourceResolutionError);
      expect((err as Error).message).toContain("seat");
      expect((err as Error).message).toContain("GONE.md");
    }
  });

  it("a tree ref against an UNCONFIGURED root fails loud naming the missing config, never silently empty", () => {
    const read = makeProfileReadFile({ packDir, roots: {} });
    expect(() => read("seat:RECAP.md")).toThrow(/seat.*root|root.*seat/i);
  });
});

describe("sourceKindForAddress — the per-piece label feed (Q2-Amendment 1 binding)", () => {
  it("derives the composer's source label from the atom's address prefix", () => {
    expect(sourceKindForAddress("walk.md#welcome")).toBe("library");
    expect(sourceKindForAddress("project:SPEC.md")).toBe("project");
    expect(sourceKindForAddress("seat:RECAP.md#recent-decisions")).toBe("seat");
    expect(sourceKindForAddress("mission:NOTES.md")).toBe("mission");
  });
});
