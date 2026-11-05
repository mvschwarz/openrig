// OPR.0.4.1.29 — save / switch / list: file-snapshot mode-guard, never echo contents.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexHome, authSave, authSwitch, authList } from "../src/lib/codex-auth.js";
import { expectPrivateFile } from "./helpers/private-file.js";

const SENTINEL = "SENTINEL_TOKEN_MUST_NEVER_APPEAR_sk-xyz789";
let home: string;
let paths: ReturnType<typeof resolveCodexHome>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-ss-"));
  paths = resolveCodexHome({ CODEX_HOME: home });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const writeActive = (mode = 0o600) => {
  fs.writeFileSync(paths.activeAuth, JSON.stringify({ OPENAI_API_KEY: SENTINEL }), { mode });
  fs.chmodSync(paths.activeAuth, mode);
};

describe("authSave (snapshot active auth -> named profile, 0600, no content echo)", () => {
  it("snapshots the active auth file into a 0600 profile and reports only name/path/mode", () => {
    writeActive();
    const r = authSave(paths, "work");
    expect(r).toMatchObject({ ok: true, name: "work", mode: "600" });
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
    const saved = path.join(paths.profileDir, "work.json");
    expect(fs.existsSync(saved)).toBe(true);
    expectPrivateFile(saved);
    if (process.platform === "win32") expectPrivateFile(paths.profileDir);
    else expect((fs.statSync(paths.profileDir).mode & 0o777).toString(8)).toBe("700");
  });

  it("reports not_configured when there is no active auth file", () => {
    expect(authSave(paths, "work")).toEqual({ ok: false, reason: "not_configured" });
  });

  it("rejects an invalid profile name fail-closed", () => {
    writeActive();
    expect(authSave(paths, "../evil")).toEqual({ ok: false, reason: "invalid_profile" });
  });

  it("refuses to write through a symlink target (unsafe_path)", () => {
    writeActive();
    fs.mkdirSync(paths.profileDir, { recursive: true });
    const outside = path.join(home, "outside.json");
    fs.symlinkSync(outside, path.join(paths.profileDir, "work.json"));
    expect(authSave(paths, "work")).toEqual({ ok: false, reason: "unsafe_path" });
    expect(fs.existsSync(outside)).toBe(false); // never wrote through the link
  });
});

describe("authSwitch (activate a saved profile, restart note, no content echo)", () => {
  it("copies the profile to the active auth at 0600 and returns a restart note, no secret", () => {
    writeActive();
    authSave(paths, "work");
    fs.rmSync(paths.activeAuth);
    const r = authSwitch(paths, "work");
    expect(r).toMatchObject({ ok: true, name: "work", mode: "600" });
    if (r.ok) expect(r.note).toMatch(/restart/i);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
    expectPrivateFile(paths.activeAuth);
  });

  it("reports missing_profile for an unsaved profile", () => {
    expect(authSwitch(paths, "ghost")).toEqual({ ok: false, reason: "missing_profile" });
  });

  it("refuses to overwrite an active auth that has unsafe permissions", () => {
    writeActive();
    authSave(paths, "work");
    fs.chmodSync(paths.activeAuth, 0o644);
    expect(authSwitch(paths, "work")).toEqual({ ok: false, reason: "unsafe_permissions" });
  });

  it("refuses a symlinked active auth and never writes profile bytes through it (unsafe_path)", () => {
    writeActive();
    authSave(paths, "work");
    // Replace the active auth with a symlink pointing OUTSIDE CODEX_HOME. copyFileSync would otherwise
    // follow it and write the profile's secret bytes to `outside`, escaping the managed boundary.
    const outside = path.join(home, "outside-target.json");
    fs.writeFileSync(outside, JSON.stringify({ note: "untouched" }), { mode: 0o600 });
    fs.rmSync(paths.activeAuth);
    fs.symlinkSync(outside, paths.activeAuth);
    expect(authSwitch(paths, "work")).toEqual({ ok: false, reason: "unsafe_path" });
    expect(fs.lstatSync(paths.activeAuth).isSymbolicLink()).toBe(true); // link not clobbered
    expect(fs.readFileSync(outside, "utf8")).toContain("untouched"); // target never written through
    expect(fs.readFileSync(outside, "utf8")).not.toContain(SENTINEL);
  });
});

describe("authList", () => {
  it("lists saved profile names sorted, never reading contents", () => {
    writeActive();
    authSave(paths, "team-b");
    authSave(paths, "acct-a");
    expect(authList(paths)).toEqual(["acct-a", "team-b"]);
  });
  it("returns [] when no profile dir", () => {
    expect(authList(paths)).toEqual([]);
  });
});
