import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProjectionManifestStore } from "../src/domain/projection-manifest-store.js";

describe("ProjectionManifestStore — P20 atom 1 (mig-064)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createFullTestDb();
  });

  it("get / lastHash are null before any record", () => {
    const s = new ProjectionManifestStore(db);
    expect(s.get("/x/skill.md")).toBeNull();
    expect(s.lastHash("/x/skill.md")).toBeNull();
  });

  it("record → get returns the entry; lastHash returns the hash", () => {
    const s = new ProjectionManifestStore(db);
    s.record({ targetPath: "/x/skill.md", lastHash: "h1", writtenAt: "T0", sourceSpec: "spec-a", category: "skill" });
    const e = s.get("/x/skill.md")!;
    expect(e.lastHash).toBe("h1");
    expect(e.writtenAt).toBe("T0");
    expect(e.sourceSpec).toBe("spec-a");
    expect(e.category).toBe("skill");
    expect(s.lastHash("/x/skill.md")).toBe("h1");
  });

  it("record UPSERTS on target_path — a re-write keeps the LAST hash (record-on-write)", () => {
    const s = new ProjectionManifestStore(db);
    s.record({ targetPath: "/x/skill.md", lastHash: "h1", writtenAt: "T0" });
    s.record({ targetPath: "/x/skill.md", lastHash: "h2", writtenAt: "T1" });
    expect(s.lastHash("/x/skill.md")).toBe("h2");
    expect(s.get("/x/skill.md")!.writtenAt).toBe("T1");
  });

  it("records are per-target (distinct paths never collide)", () => {
    const s = new ProjectionManifestStore(db);
    s.record({ targetPath: "/a", lastHash: "ha", writtenAt: "T" });
    s.record({ targetPath: "/b", lastHash: "hb", writtenAt: "T" });
    expect(s.lastHash("/a")).toBe("ha");
    expect(s.lastHash("/b")).toBe("hb");
  });

  it("optional fields default to null", () => {
    const s = new ProjectionManifestStore(db);
    s.record({ targetPath: "/x", lastHash: "h", writtenAt: "T" });
    const e = s.get("/x")!;
    expect(e.sourceSpec).toBeNull();
    expect(e.category).toBeNull();
  });
});
