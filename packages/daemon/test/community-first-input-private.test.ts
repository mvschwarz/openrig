import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeFirstInput } from "../src/domain/community-harness-first-input.js";
import { expectPrivateFile } from "./helpers/private-file.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("stores each first input privately and preserves exact Unicode bytes across attempts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "first input O'Brien Ω ")); roots.push(root);
  const text = "私密首输入 Ω\r\n'quoted' $literal & %PATH%\n";
  const first = writeFirstInput("owned@fixture", text, root);
  const second = writeFirstInput("owned@fixture", "next attempt", root);
  expect(first.submission).toBe("unconfirmed"); expect(second.submission).toBe("unconfirmed");
  expect(first.path).not.toBe(second.path);
  expect(fs.readFileSync(first.path)).toEqual(Buffer.from(text, "utf8"));
  expect(fs.readFileSync(second.path, "utf8")).toBe("next attempt");
  expectPrivateFile(first.path); expectPrivateFile(second.path);
});
