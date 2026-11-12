import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultTmuxFileOps } from "../src/adapters/tmux.js";
import { expectPrivateFile } from "./helpers/private-file.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("stages exact native input privately and refuses to overwrite a competing file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-private-staging-"));
  dirs.push(dir);
  const file = path.join(dir, "input ' 中文.txt"), ops = defaultTmuxFileOps();
  const content = "synthetic 中文\r\n'quote' $literal ;\n";
  await ops.writeFile(file, content, { mode: 0o600, flag: "wx" });
  expectPrivateFile(file);
  expect(fs.readFileSync(file, "utf8")).toBe(content);
  await expect(ops.writeFile(file, "replacement", { mode: 0o600, flag: "wx" })).rejects.toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe(content);
  expectPrivateFile(file);
  await ops.unlink(file);
  expect(fs.readdirSync(dir)).toEqual([]);
});
