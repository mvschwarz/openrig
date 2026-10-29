import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { readBounded, readExperiment, setExperiment } from "../src/commands/project-jev.js";
import { expectPrivateFile } from "./helpers/private-file.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-input-native-")); dirs.push(dir); return dir; }
it.skipIf(process.platform === "win32")("rejects an owned FIFO without waiting for its writer", async () => {
  const file = path.join(fixture(), "input.json"); execFileSync("mkfifo", [file]);
  const source = new URL("../src/commands/project-jev.ts", import.meta.url).href;
  const script = `import { readBounded } from ${JSON.stringify(source)}; try { readBounded(process.argv[1]); process.exitCode=2; } catch(e) { console.log(e.message); }`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, file], { stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (chunk) => { out += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10_000);
  const code = await new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  clearTimeout(timer);
  expect({ code, timedOut, out }).toEqual({ code: 0, timedOut: false, out: "input must be a bounded regular file\n" });
});
it("retains normal bounded-file reads and refuses an oversized regular file", () => {
  const file = path.join(fixture(), "input.json"); fs.writeFileSync(file, "source bytes");
  expect(readBounded(file, 12)).toBe("source bytes");
  expect(() => readBounded(file, 11)).toThrow("bounded regular file");
});

it.skipIf(process.platform !== "win32")("rejects an owned Windows named pipe without waiting for input", async () => {
  const pipe = `\\\\.\\pipe\\openrig-owned-input-${randomUUID()}`;
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
  try { expect(() => readBounded(pipe)).toThrow(); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it("updates an owned configuration, keeps exact UTF-8 reads and rejects hard-linked configuration writes", () => {
  const directory = fixture(), file = path.join(directory, "配置 ' experiment.json");
  setExperiment(file, true, { maxRequests: 2, timeoutMs: 1000 });
  expectPrivateFile(file);
  setExperiment(file, false);
  expect(readExperiment(file)).toEqual({ enabled: false, maxRequests: 2, timeoutMs: 1000 });
  const original = fs.readFileSync(file, "utf8"), linked = path.join(directory, "linked.json");
  fs.linkSync(file, linked);
  expect(() => setExperiment(linked, true)).toThrow(/owned regular file/);
  expect(fs.readFileSync(file, "utf8")).toBe(original);
  expect(fs.readFileSync(linked, "utf8")).toBe(original);
  const source = path.join(directory, "source.txt"), bytes = "中文\u0000\r\n";
  fs.writeFileSync(source, bytes);
  expect(readBounded(source, Buffer.byteLength(bytes))).toBe(bytes);
  expect(() => readBounded(source, Buffer.byteLength(bytes) - 1)).toThrow(/bounded regular file/);
});

it("refuses a final directory link without reading or changing its target", () => {
  const directory = fixture(), target = path.join(directory, "target"), link = path.join(directory, "linked");
  fs.mkdirSync(target);
  const marker = path.join(target, "keep.txt"); fs.writeFileSync(marker, "preserved");
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  expect(() => readBounded(link)).toThrow();
  expect(() => setExperiment(link, true)).toThrow();
  expect(fs.readFileSync(marker, "utf8")).toBe("preserved");
});
