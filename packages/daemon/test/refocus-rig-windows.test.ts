import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const scripts = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts");
const { resolveRigCommand, spawnRig } = require(path.join(scripts, "rig-command.cjs"));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "refocus O'Brien Ω ")); roots.push(root);
  const bin = path.join(root, "bin & tools");
  const pkg = path.join(bin, "node_modules", "@openrig", "cli");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  const manifest = path.join(pkg, "package.json");
  fs.writeFileSync(manifest, JSON.stringify({ name: "@openrig/cli", bin: { rig: "dist/probe.cjs" } }));
  const shim = path.join(bin, "rig.cmd");
  fs.writeFileSync(shim, '@echo off\r\n"%dp0%\\node_modules\\@openrig\\cli\\dist\\probe.cjs" %*\r\n');
  const entry = path.join(pkg, "dist", "probe.cjs");
  fs.writeFileSync(entry, 'process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));');
  return { root, bin, pkg, manifest, shim, entry, env: { ...process.env, PATH: bin } };
}

describe.skipIf(process.platform !== "win32")("refocus Windows rig npm dispatch", () => {
  it.each(["PATHEXT", "pAtHeXt"])("honors selected %s before a COM decoy through the actual npm child", key => {
    const f = fixture();
    fs.writeFileSync(path.join(f.bin, "rig.com"), "Owned decoy; must not execute.");
    for (const name of Object.keys(f.env)) if (name.toUpperCase() === "PATHEXT") delete f.env[name];
    const env = { ...f.env, [key]: ".CMD;.COM" };
    const args = ["context", "get", "packs/用户 O'Brien & %PATH%"];
    const result = spawnRig(args, { env, cwd: f.root, encoding: "utf8", timeout: 5000 });
    expect(result.status, result.error?.message).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args, cwd: f.root });
    expect(resolveRigCommand({ PATH: f.bin, [key]: ".COM;.CMD" })).toMatchObject({ command: fs.realpathSync(path.join(f.bin, "rig.com")), prefix: [] });
    expect(() => resolveRigCommand({ PATH: f.bin, [key]: "" })).toThrow("No rig executable");
  });
  it("reproduces direct-spawn failure and preserves literal arguments through the owned npm entry", () => {
    const f = fixture();
    const args = ["context", "get", "packs/Ω O'Brien & %PATH% $(echo x)"];
    const before = spawnSync("rig", args, { env: f.env, encoding: "utf8" });
    expect(before.error).toBeDefined();
    const result = spawnRig(args, { env: f.env, cwd: f.root, encoding: "utf8", timeout: 5000 });
    expect(result.status, result.error?.message).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ args, cwd: f.root });
  });

  it.each(["package", "escape", "absolute", "shim", "bat"])("refuses an unrecognized %s", kind => {
    const f = fixture();
    if (kind === "package") fs.writeFileSync(f.manifest, JSON.stringify({ name: "other", bin: { rig: "dist/probe.cjs" } }));
    if (kind === "escape") fs.writeFileSync(f.manifest, JSON.stringify({ name: "@openrig/cli", bin: { rig: "../probe.cjs" } }));
    if (kind === "absolute") fs.writeFileSync(f.manifest, JSON.stringify({ name: "@openrig/cli", bin: { rig: f.entry } }));
    if (kind === "shim") fs.writeFileSync(f.shim, "@echo unrecognized");
    if (kind === "bat") fs.renameSync(f.shim, path.join(f.bin, "rig.bat"));
    const result = spawnRig(["context", "get", "x"], { env: f.env, encoding: "utf8" });
    expect(result.error).toBeDefined();
    expect(result.status).toBeNull();
    expect(result.stdout).toBe("");
  });

  it("delivers configured context through the actual hook without invoking a live CLI", () => {
    const f = fixture();
    const home = path.join(f.root, "home"); fs.mkdirSync(home);
    fs.writeFileSync(f.entry, 'process.stdout.write("# Owned native context Ω\\n");');
    const result = spawnSync(process.execPath, [path.join(scripts, "refocus.cjs"), "--runtime", "claude"], {
      encoding: "utf8", timeout: 10000,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "owned-test" }),
      env: { ...f.env, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: "owned@fixture", OPENRIG_REFOCUS_NOW: "1",
        OPENRIG_REFOCUS_WORK_PACKET: "0", OPENRIG_REFOCUS_CONTENT_REF: "packs/owned", OPENRIG_SEAT_PROJECT_DIR: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain("# Owned native context Ω\n");
  });

  it("reports the third failure through the owned entry once, retaining its issue identity", () => {
    const f = fixture();
    const capture = path.join(f.root, "stream-args.json");
    fs.writeFileSync(f.entry, `require('fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)));`);
    const { recordRefocusResult } = require(path.join(scripts, "refocus-health.cjs"));
    const input = { home: f.root, seat: "owned@fixture", identity: "owned", failed: true, env: f.env,
      deadlineMs: Math.floor(process.uptime() * 1000) + 10000 };
    recordRefocusResult(input); recordRefocusResult(input);
    expect(fs.existsSync(capture)).toBe(false);
    recordRefocusResult(input);
    const args = JSON.parse(fs.readFileSync(capture, "utf8"));
    expect(args.slice(0, 4)).toEqual(["stream", "emit", "--source", "owned@fixture"]);
    const healthFile = path.join(f.root, "refocus", fs.readdirSync(path.join(f.root, "refocus"))[0]!);
    const health = JSON.parse(fs.readFileSync(healthFile, "utf8"));
    expect(args[args.indexOf("--id") + 1]).toBe(health.issueId);
    expect(health.reportedAt).toBeTruthy();
    fs.unlinkSync(capture);
    recordRefocusResult(input);
    expect(fs.existsSync(capture)).toBe(false);
  });
});
