import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authSave, authStatus, authSwitch, authValidate, copyOntoFresh, resolveCodexHome } from "../src/domain/codex-auth.js";
import { createPrivateTextFile } from "../src/domain/private-text-file.js";
import { expectPrivateFile } from "./helpers/private-file.js";

describe.skipIf(process.platform !== "win32")("native Windows auth file boundary", () => {
  let root: string;
  const synthetic = JSON.stringify({ access_token: "SYNTHETIC_AUTH_FIXTURE_NOT_A_CREDENTIAL" });
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-native-auth-")); });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

  it("saves, validates and switches private bytes without returning their contents", () => {
    const paths = resolveCodexHome({ CODEX_HOME: root });
    createPrivateTextFile(paths.activeAuth, synthetic);
    const saved = authSave(paths, "fixture");
    expect(saved).toMatchObject({ ok: true });
    const profile = path.join(paths.profileDir, "fixture.json");
    expectPrivateFile(profile);
    expect(fs.readFileSync(profile, "utf8")).toBe(synthetic);
    const validated = authValidate(paths, "fixture");
    expect(validated).toMatchObject({ ok: true });
    fs.unlinkSync(paths.activeAuth);
    const switched = authSwitch(paths, "fixture");
    expect(switched).toMatchObject({ ok: true });
    expectPrivateFile(paths.activeAuth);
    expect(fs.readFileSync(paths.activeAuth, "utf8")).toBe(synthetic);
    expect(JSON.stringify([saved, validated, switched])).not.toContain("SYNTHETIC_AUTH_FIXTURE");
    expect(fs.readdirSync(root).some(n => n.includes(".tmp-"))).toBe(false);
    expect(fs.readdirSync(paths.profileDir).some(n => n.includes(".tmp-"))).toBe(false);
  });

  it("refuses a source identity mismatch and a hard-linked source without changing the destination", () => {
    const source = path.join(root, "source.json"), dest = path.join(root, "dest.json");
    createPrivateTextFile(source, synthetic);
    createPrivateTextFile(dest, "previous");
    const st = fs.statSync(source, { bigint: true });
    expect(copyOntoFresh(source, dest, { dev: st.dev, ino: st.ino + 1n })).toBe(false);
    expect(fs.readFileSync(dest, "utf8")).toBe("previous");
    fs.linkSync(source, path.join(root, "alias.json"));
    expect(copyOntoFresh(source, dest)).toBe(false);
    expect(fs.readFileSync(dest, "utf8")).toBe("previous");
    expect(fs.readdirSync(root).some(n => n.includes(".tmp-"))).toBe(false);
  });

  it("rejects an inherited public profile DACL and a junction outside the auth home", () => {
    const paths = resolveCodexHome({ CODEX_HOME: path.join(root, "home") });
    fs.mkdirSync(paths.profileDir, { recursive: true });
    fs.writeFileSync(path.join(paths.profileDir, "fixture.json"), synthetic);
    expect(authValidate(paths, "fixture")).toEqual({ ok: false, reason: "unsafe_permissions" });
    fs.rmSync(paths.profileDir, { recursive: true });
    const outside = path.join(root, "outside");fs.mkdirSync(outside);
    fs.symlinkSync(outside, paths.profileDir, "junction");
    createPrivateTextFile(paths.activeAuth, synthetic);
    expect(authSave(paths, "fixture")).toEqual({ ok: false, reason: "unsafe_path" });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("probes a recognized native npm Codex entry by exit code only", () => {
    const bin = path.join(root, "bin"), pkg = path.join(bin, "node_modules", "@openai", "codex");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }));
    fs.writeFileSync(path.join(bin, "codex.cmd"), '@echo off\r\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js"\r\n');
    const marker = path.join(root, "observed.json");
    fs.writeFileSync(path.join(pkg, "bin", "codex.js"), `require('fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME}));console.log('SYNTHETIC_AUTH_FIXTURE');console.error('SYNTHETIC_AUTH_FIXTURE');`);
    vi.stubEnv("PATH", bin + path.delimiter + path.dirname(process.execPath));
    const paths = resolveCodexHome({ CODEX_HOME: path.join(root, "auth-home") });
    const result = authStatus(paths);
    expect(result.loginStatus).toBe("logged_in");
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual({ args: ["login", "status"], home: paths.codexHome });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_AUTH_FIXTURE");
  });
});
