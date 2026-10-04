import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { Command } from "commander";
import { writeTextAtomically } from "../src/atomic-text-write.js";
import { exportCommand } from "../src/commands/export.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import { allowFetchTarget, resetFetchAllowlist } from "./fetch-guard.js";
import { assertFixtureScopedHome } from "./live-daemon-guard.js";

const failure = vi.hoisted(() => ({ active: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const writeFileSync = (...args: Parameters<typeof fs.writeFileSync>) => {
    if (failure.active) {
      failure.active = false;
      actual.writeFileSync(args[0], "partial YAML");
      throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
    }
    return actual.writeFileSync(...args);
  };
  return { ...actual, writeFileSync, default: { ...actual.default, writeFileSync } };
});
let dir: string | undefined;
afterEach(() => { failure.active = false; if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
it("preserves an existing export and removes staging after a partial failed write", () => {
  dir = fs.mkdtempSync(join(tmpdir(), "export-atomic-"));
  const target = join(dir, "rig.yaml");
  fs.writeFileSync(target, "name: original\n");
  failure.active = true;
  expect(() => writeTextAtomically(target, "name: replacement\n", "export")).toThrow(/no space left/);
  expect(fs.readFileSync(target, "utf8")).toBe("name: original\n");
  expect(fs.readdirSync(dir)).toEqual(["rig.yaml"]);
});
it("retains export symlinks and target permissions on successful replacement", () => {
  dir = fs.mkdtempSync(join(tmpdir(), "export-atomic-"));
  const target = join(dir, "saved.yaml"), link = join(dir, "rig.yaml");
  fs.writeFileSync(target, "name: original\n"); fs.chmodSync(target, 0o640); fs.symlinkSync(target, link);
  writeTextAtomically(link, "name: replacement\n", "export");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(target, "utf8")).toBe("name: replacement\n");
  if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  expect(fs.readdirSync(dir).sort()).toEqual(["rig.yaml", "saved.yaml"]);
});
it.skipIf(process.platform === "win32")("keeps staging names within native filename limits", () => {
  dir = fs.mkdtempSync(join(tmpdir(), "export-atomic-"));
  const name = "r".repeat(250) + ".yaml";
  const target = join(dir, name);
  fs.writeFileSync(target, "name: original\n");
  writeTextAtomically(target, "name: replacement\n", "export");
  expect(fs.readFileSync(target, "utf8")).toBe("name: replacement\n");
  expect(fs.readdirSync(dir)).toEqual([name]);
});
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("overwrites a native write-only export without requiring read access", () => {
  dir = fs.mkdtempSync(join(tmpdir(), "export-atomic-"));
  const target = join(dir, "rig.yaml");
  fs.writeFileSync(target, "name: original\n"); fs.chmodSync(target, 0o200);
  writeTextAtomically(target, "name: replacement\n", "export");
  expect(fs.statSync(target).mode & 0o777).toBe(0o200);
  fs.chmodSync(target, 0o600);
  expect(fs.readFileSync(target, "utf8")).toBe("name: replacement\n");
});
it.skipIf(process.platform === "win32")("writes content to a native FIFO without replacing it or delivering an empty EOF", async () => {
  dir = fs.mkdtempSync(join(tmpdir(), "export-atomic-"));
  const target = join(dir, "rig.fifo"), content = "name: exported\n";
  execFileSync("mkfifo", [target]);
  const reader = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    process.send("ready");
    const content = fs.readFileSync(process.argv[1], "utf8");
    process.send({ content });
    process.disconnect();
  `, target], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages = new Promise<string>((resolve, reject) => {
    reader.on("message", (message) => {
      if (typeof message === "object" && message && "content" in message) resolve(String(message.content));
    });
    reader.on("error", reject);
    reader.once("exit", () => reject(new Error("FIFO reader exited without content")));
  });
  const timeout = setTimeout(() => reader.kill(), 5000);
  try {
    await new Promise<void>((resolve, reject) => {
      reader.once("message", () => resolve());
      reader.once("error", reject);
      reader.once("exit", () => reject(new Error("FIFO reader exited before opening")));
    });
    writeTextAtomically(target, content, "export");
    expect(await messages).toBe(content);
    expect(fs.statSync(target).isFIFO()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["rig.fifo"]);
  } finally {
    clearTimeout(timeout);
    reader.kill();
  }
});
it("uses the default export writer to preserve the saved spec after a partial write failure", async () => {
  assertFixtureScopedHome(dirname(STATE_FILE));
  dir = fs.mkdtempSync(join(tmpdir(), "export-atomic-"));
  const target = join(dir, "rig.yaml"), original = "name: original\n";
  const previousState = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE) : undefined;
  const server = http.createServer((req, res) => {
    res.end(req.url === "/healthz" ? "{}" : "schema_version: 1\nname: replacement\nnodes: []\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    allowFetchTarget(`http://127.0.0.1:${port}`);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port, db: "fixture.sqlite", startedAt: new Date().toISOString() }));
    fs.writeFileSync(target, original);
    const program = new Command().addCommand(exportCommand());
    failure.active = true;
    await expect(program.parseAsync(["node", "rig", "export", "fixture", "-o", target])).rejects.toThrow(/no space left/);
    expect(fs.readFileSync(target, "utf8")).toBe(original);
    expect(fs.readdirSync(dir)).toEqual(["rig.yaml"]);
  } finally {
    failure.active = false;
    resetFetchAllowlist();
    if (previousState) fs.writeFileSync(STATE_FILE, previousState);
    else fs.unlinkSync(STATE_FILE);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
