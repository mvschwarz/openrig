import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { readBounded } from "../src/commands/project-jev.js";

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
