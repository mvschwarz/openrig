import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { followLog, lastLogLines } from "../src/log-tail.js";

const homes: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true });
});
function log(contents: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rig-log-"));
  homes.push(home);
  const file = path.join(home, "日志 space.log");
  fs.writeFileSync(file, contents);
  return file;
}
describe("native daemon logs", () => {
  it.each([true, false])("prints the last ten lines, trailing newline=%s", (trailing) => {
    const lines = Array.from({ length: 30 }, (_, i) => `${i}: 日志 ${"x".repeat(8000)}`);
    const text = lines.join("\n") + (trailing ? "\n" : "");
    const file = log(text);
    expect(lastLogLines(file)).toEqual({ text: lines.slice(-10).join("\n") + (trailing ? "\n" : ""), position: Buffer.byteLength(text) });
  });
  it("handles empty and short logs", () => {
    expect(lastLogLines(log("")).text).toBe("");
    expect(lastLogLines(log("one\r\ntwo\r\n")).text).toBe("one\r\ntwo\r\n");
  });
  it("follows appends, preserves split Unicode, and continues after truncation", async () => {
    const file = log("before\n");
    let output = "";
    closers.push(followLog(file, (text) => { output += text; }, 10));
    const bytes = Buffer.from("中文\n");
    fs.appendFileSync(file, bytes.subarray(0, 2));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(output).toBe("before\n");
    fs.appendFileSync(file, bytes.subarray(2));
    await expect.poll(() => output).toBe("before\n中文\n");
    fs.truncateSync(file, 0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    fs.appendFileSync(file, "after\n");
    await expect.poll(() => output).toBe("before\n中文\nafter\n");
  });
  it("preserves a Unicode character split across initial read and first append", async () => {
    const file = log("before\n");
    const bytes = Buffer.from("中文\n");
    fs.appendFileSync(file, bytes.subarray(0, 2));
    let output = "";
    closers.push(followLog(file, (text) => { output += text; }, 10));
    expect(output).toBe("before\n");
    fs.appendFileSync(file, bytes.subarray(2));
    await expect.poll(() => output).toBe("before\n中文\n");
  });
});
