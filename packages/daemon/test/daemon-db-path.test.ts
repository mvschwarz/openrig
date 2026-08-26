import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { resolveDaemonDbPath } from "../src/daemon-db-path.js";

describe("resolveDaemonDbPath — D15: db derives from OPENRIG_HOME, never CWD-relative", () => {
  it("derives the db under OPENRIG_HOME when OPENRIG_DB is unset — NOT a bare CWD-relative filename", () => {
    const p = resolveDaemonDbPath(undefined, "/scratch/home");
    // The tonight incident: a bare 'openrig.sqlite' resolved against the process
    // CWD -> could land on the SHARED fleet db. The default must be home-anchored.
    expect(p).toBe("/scratch/home/openrig.sqlite");
    expect(p).not.toBe("openrig.sqlite");
    expect(p.startsWith("/")).toBe(true); // absolute, CWD-independent
  });

  it("isolates two daemons with different OPENRIG_HOME even from the same CWD", () => {
    expect(resolveDaemonDbPath(undefined, "/tmp/iso-a")).toBe("/tmp/iso-a/openrig.sqlite");
    expect(resolveDaemonDbPath(undefined, "/home/fleet")).toBe("/home/fleet/openrig.sqlite");
  });

  it("honors an explicit OPENRIG_DB path verbatim", () => {
    expect(resolveDaemonDbPath("/iso/custom.sqlite", "/scratch/home")).toBe("/iso/custom.sqlite");
  });

  it("treats an empty OPENRIG_DB as unset (falls back to home-anchored default)", () => {
    expect(resolveDaemonDbPath("", "/scratch/home")).toBe("/scratch/home/openrig.sqlite");
  });

  it("fails loud when the implicit database resolves through a symlink outside resolved OPENRIG_HOME", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-db-home-guard-"));
    const home = join(root, "home");
    const outsideDb = join(root, "shared.sqlite");
    try {
      // The home-local filename is only lexical: following it reaches shared state.
      // An ambient implicit path must never gain that authority.
      mkdirSync(home);
      writeFileSync(outsideDb, "shared fleet sentinel");
      symlinkSync(outsideDb, join(home, "openrig.sqlite"));
      let message = "";
      try {
        resolveDaemonDbPath(undefined, home);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/outside|escape|OPENRIG_HOME/i);
      expect(message).toContain(realpathSync(home));
      expect(message).toContain(realpathSync(outsideDb));
      expect(readFileSync(outsideDb, "utf-8")).toBe("shared fleet sentinel");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicit outside OPENRIG_DB as the deliberate split-path override", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-db-explicit-"));
    const home = join(root, "home");
    const explicitDb = join(root, "shared", "fleet.sqlite");
    try {
      mkdirSync(home);
      mkdirSync(join(root, "shared"));
      const resolved = resolveDaemonDbPath(explicitDb, home);
      const db = new Database(resolved);
      db.exec("CREATE TABLE effect_evidence (value TEXT NOT NULL); INSERT INTO effect_evidence VALUES ('split path used')");
      db.close();

      expect(resolved).toBe(explicitDb);
      expect(existsSync(explicitDb)).toBe(true);
      const verify = new Database(explicitDb, { readonly: true });
      expect(verify.prepare("SELECT value FROM effect_evidence").pluck().get()).toBe("split path used");
      verify.close();
      expect(existsSync(join(home, "openrig.sqlite"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reinterpret a non-directory path component as a missing tail", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-db-nondir-"));
    const notAHome = join(root, "not-a-directory");
    try {
      writeFileSync(notAHome, "not a directory");
      expect(() => resolveDaemonDbPath(undefined, notAHome)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
