import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installed] = process.argv.slice(2);
if (!installed) throw new Error("An isolated installed CLI root is required");
const { defaultWindowDeps } = await import(pathToFileURL(join(installed, "dist", "terminal-window.js")).href);
const values = ["", 'embedded"quote', "end\\", "中文", "%PATH%!&|"];
const stdout = await defaultWindowDeps().exec(process.execPath,
  ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...values], 5000);
assert.deepEqual(JSON.parse(stdout), values);
console.log(JSON.stringify({ nativeControl: process.platform === "win32", literalArgv: true }));
