import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCodexAuthMetadata } from "../src/domain/provider/codex-auth-reader.js";

// Slice-04 (OPR.0.5.0.4) seam C1 — a DAEMON-LOCAL, secret-safe reader of the codex-auth on-disk
// contract ($CODEX_HOME||~/.codex : auth-profiles/*.json names + auth-seat-registry.tsv 6-col).
// The daemon cannot import packages/cli; this re-reads the same documented format. It reads profile
// NAMES and the TSV only — NEVER profile file contents (which hold token-class material).

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexhome-"));
  fs.mkdirSync(path.join(dir, "auth-profiles"), { recursive: true });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeProfile(name: string, contents: unknown): void {
  fs.writeFileSync(path.join(dir, "auth-profiles", `${name}.json`), JSON.stringify(contents));
}
function writeRegistry(rows: string[][]): void {
  const header = ["seat", "rig", "runtime", "cwd", "auth_profile", "updated_ts"].join("\t");
  const body = rows.map((r) => r.join("\t")).join("\n");
  fs.writeFileSync(path.join(dir, "auth-seat-registry.tsv"), `${header}\n${body}\n`);
}

describe("readCodexAuthMetadata — daemon-local, secret-safe", () => {
  it("lists profile NAMES (sorted) and parses the 6-column seat registry", () => {
    writeProfile("beta", { OPENAI_API_KEY: "sk-SECRET-TOKEN-must-never-surface" });
    writeProfile("alpha", { OPENAI_API_KEY: "sk-ANOTHER-SECRET" });
    writeRegistry([
      ["seat-1", "rig-a", "codex", "/w/a", "alpha", "2026-08-03T12:00:00.000Z"],
      ["seat-2", "rig-a", "codex", "/w/b", "beta", "2026-08-03T11:00:00.000Z"],
    ]);

    const meta = readCodexAuthMetadata({ CODEX_HOME: dir } as NodeJS.ProcessEnv);
    expect(meta.profiles).toEqual(["alpha", "beta"]); // sorted names, no .json
    expect(meta.seats).toHaveLength(2);
    const s1 = meta.seats.find((s) => s.seat === "seat-1");
    expect(s1).toMatchObject({ seat: "seat-1", rig: "rig-a", runtime: "codex", authProfile: "alpha", updatedTs: "2026-08-03T12:00:00.000Z" });
  });

  it("NEVER surfaces token-class content from profile files (reads names only)", () => {
    writeProfile("alpha", { OPENAI_API_KEY: "sk-SECRET-TOKEN-must-never-surface", access_token: "tok-DEADBEEF" });
    writeRegistry([["seat-1", "rig-a", "codex", "/w/a", "alpha", "2026-08-03T12:00:00.000Z"]]);

    const meta = readCodexAuthMetadata({ CODEX_HOME: dir } as NodeJS.ProcessEnv);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("sk-SECRET-TOKEN");
    expect(serialized).not.toContain("tok-DEADBEEF");
    expect(serialized).not.toContain("access_token");
    expect(meta.profiles).toEqual(["alpha"]);
  });

  it("returns empty (never throws) when the codex home / files are absent", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "codexempty-"));
    try {
      const meta = readCodexAuthMetadata({ CODEX_HOME: empty } as NodeJS.ProcessEnv);
      expect(meta.profiles).toEqual([]);
      expect(meta.seats).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("skips malformed registry rows (wrong column count) rather than fabricating fields", () => {
    fs.writeFileSync(
      path.join(dir, "auth-seat-registry.tsv"),
      ["seat\trig\truntime\tcwd\tauth_profile\tupdated_ts", "seat-1\trig-a\tcodex\t/w/a\talpha\t2026-08-03T12:00:00.000Z", "broken\trow", ""].join("\n"),
    );
    const meta = readCodexAuthMetadata({ CODEX_HOME: dir } as NodeJS.ProcessEnv);
    expect(meta.seats).toHaveLength(1);
    expect(meta.seats[0].seat).toBe("seat-1");
  });
});
