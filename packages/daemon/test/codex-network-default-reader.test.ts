import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, it, expect } from "vitest";
import { codexNetworkDefaultReader } from "../src/domain/codex-network-default.js";

// #275 — the production reader against a fake `codex` on a temporary PATH. The fake speaks the
// app-server JSON-lines exchange from the architecture review's 0.160.0 records and behaves as
// told by mode.json beside it. No real Codex, credentials or network.

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), { spawn } = require("node:child_process");
const dir = __dirname, mode = JSON.parse(fs.readFileSync(path.join(dir, "mode.json"), "utf8"));
fs.writeFileSync(path.join(dir, "seen.json"), JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(),
  HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, PATH: process.env.PATH, pid: process.pid }));
if (mode.grandchild) {
  const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "grandchild.pid"), String(g.pid));
}
if (mode.ignoreTerm) process.on("SIGTERM", () => {});
if (mode.exitEarly) process.exit(0);
const received = [];
let buf = "";
const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    received.push(msg); fs.writeFileSync(path.join(dir, "received.json"), JSON.stringify(received));
    if (mode.hang) continue;
    if (msg.method === "initialize") { out({ method: "some/notification", params: {} }); out({ id: msg.id, result: { userAgent: "fake/0.0.0" } }); }
    else if (msg.method === "config/read") out(mode.configError ? { id: msg.id, error: { code: -32603, message: "failed to read configuration layers" } } : { id: msg.id, result: mode.config });
    else if (msg.method === "configRequirements/read") out({ id: msg.id, result: mode.requirements });
  }
});
process.stdin.on("end", () => { if (!mode.ignoreEof) process.exit(0); });
if (mode.ignoreEof) setInterval(() => {}, 1000);
`;

const FLOOR_CONFIG = {
  config: { sandbox_mode: "workspace-write", sandbox_workspace_write: null, default_permissions: null, profile: null },
  origins: { sandbox_mode: { name: { type: "sessionFlags" }, version: "sha256:session" } },
  layers: [{ name: { type: "sessionFlags" }, version: "sha256:session" }],
};
const USER_FALSE_CONFIG = {
  ...FLOOR_CONFIG,
  config: { ...FLOOR_CONFIG.config, sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false } },
  origins: { ...FLOOR_CONFIG.origins, "sandbox_workspace_write.network_access": { name: { type: "user", file: "/u/.codex/config.toml", profile: null }, version: "sha256:u" } },
};

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fakeCodex(mode: Record<string, unknown>) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or275-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = nodePath.join(root, "bin");
  const cwd = nodePath.join(root, "seat dir");
  const home = nodePath.join(root, "home");
  fs.mkdirSync(bin); fs.mkdirSync(cwd); fs.mkdirSync(home);
  fs.writeFileSync(nodePath.join(bin, "codex"), FAKE_CODEX, { mode: 0o755 });
  fs.writeFileSync(nodePath.join(bin, "mode.json"), JSON.stringify({ config: FLOOR_CONFIG, requirements: { requirements: null }, ...mode }));
  const launchPath = `${bin}:${process.env.PATH}`;
  const read = (file: string) => JSON.parse(fs.readFileSync(nodePath.join(bin, file), "utf8"));
  return { bin, cwd, home, codexHome: nodePath.join(home, ".codex"), launchPath, read, exists: (file: string) => fs.existsSync(nodePath.join(bin, file)) };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("#275 codexNetworkDefaultReader (fake codex)", () => {
  it("runs the seat's executable with its PATH, HOME, CODEX_HOME and cwd, and asks only for config", async () => {
    const f = fakeCodex({});
    const result = await codexNetworkDefaultReader({ launchPath: f.launchPath, home: f.home, codexHome: f.codexHome })(f.cwd);
    expect(result.apply).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    const seen = f.read("seen.json");
    expect(seen.argv).toEqual(["-c", 'sandbox_mode="workspace-write"', "-c", "features.plugins=false", "-c", "features.apps=false", "app-server"]);
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(f.cwd));
    expect({ HOME: seen.HOME, CODEX_HOME: seen.CODEX_HOME, PATH: seen.PATH }).toEqual({ HOME: f.home, CODEX_HOME: f.codexHome, PATH: f.launchPath });
    const received = f.read("received.json") as Array<{ id?: number; method: string; params: Record<string, unknown> }>;
    expect(received.map((m) => m.method)).toEqual(["initialize", "initialized", "config/read", "configRequirements/read"]);
    expect(received[0]!.params).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(received[2]!.params).toEqual({ includeLayers: true, cwd: f.cwd });
    expect(alive(seen.pid)).toBe(false);
  });

  it("an explicit opt-out is preserved", async () => {
    const f = fakeCodex({ config: USER_FALSE_CONFIG });
    const result = await codexNetworkDefaultReader({ launchPath: f.launchPath })(f.cwd);
    expect(result).toMatchObject({ apply: false, reason: "network access is set explicitly in Codex configuration" });
  });

  it("an RPC error is not success, even though the process would exit 0", async () => {
    const f = fakeCodex({ configError: true });
    const result = await codexNetworkDefaultReader({ launchPath: f.launchPath })(f.cwd);
    expect(result).toMatchObject({ apply: false, reason: "codex app-server returned an error for request 2" });
  });

  it("no answer by the deadline adds nothing, and the reader is gone", async () => {
    const f = fakeCodex({ hang: true });
    const result = await codexNetworkDefaultReader({ launchPath: f.launchPath, deadlineMs: 300, graceMs: 200 })(f.cwd);
    expect(result).toMatchObject({ apply: false, reason: "codex app-server did not answer within 300 ms" });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(300);
    expect(alive(f.read("seen.json").pid)).toBe(false);
  });

  it("a reader that ignores EOF and TERM is killed, and an unrelated process survives", async () => {
    const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    cleanups.push(() => { try { unrelated.kill("SIGKILL"); } catch { /* gone */ } });
    const f = fakeCodex({ ignoreEof: true, ignoreTerm: true });
    const result = await codexNetworkDefaultReader({ launchPath: f.launchPath, deadlineMs: 2_000, graceMs: 200 })(f.cwd);
    expect(result.apply).toBe(true); // it answered; cleanup is separate from the decision
    expect(alive(f.read("seen.json").pid)).toBe(false);
    expect(alive(unrelated.pid!)).toBe(true);
  });

  it("cleanup reaches the reader's own descendants after it exits", async () => {
    const f = fakeCodex({ grandchild: true });
    const result = await codexNetworkDefaultReader({ launchPath: f.launchPath, graceMs: 200 })(f.cwd);
    expect(result.apply).toBe(true);
    const grandchild = Number(fs.readFileSync(nodePath.join(f.bin, "grandchild.pid"), "utf8"));
    expect(alive(grandchild)).toBe(false);
  });

  it("a missing executable or an early exit adds nothing", async () => {
    const f = fakeCodex({ exitEarly: true });
    expect(await codexNetworkDefaultReader({ launchPath: f.launchPath })(f.cwd))
      .toMatchObject({ apply: false, reason: "codex app-server exited before answering" });
    const empty = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or275-empty-"));
    cleanups.push(() => fs.rmSync(empty, { recursive: true, force: true }));
    const missing = await codexNetworkDefaultReader({ launchPath: empty })(f.cwd);
    expect(missing).toMatchObject({ apply: false });
    expect(missing.apply === false && missing.reason).toMatch(/could not start/);
  });

  it("does not block the daemon's event loop while Codex starts", async () => {
    const f = fakeCodex({ hang: true });
    let settled = false;
    const pending = codexNetworkDefaultReader({ launchPath: f.launchPath, deadlineMs: 400, graceMs: 100 })(f.cwd).then((r) => { settled = true; return r; });
    let ticked = false;
    setTimeout(() => { ticked = true; }, 10);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ticked).toBe(true);
    expect(settled).toBe(false);
    expect((await pending).apply).toBe(false);
  });
});
