import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateTextFile, createPrivateTextFileAsync } from "../src/domain/private-text-file.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it.each(["sync", "async", "async-large"])("reports EEXIST without overwriting an existing private file (%s)", async mode => {
  root = mkdtempSync(join(tmpdir(), "openrig-private-collision-"));
  const file = join(root, "owned.txt");
  createPrivateTextFile(file, "owned original content");
  if (mode === "sync") expect(() => createPrivateTextFile(file, "replacement")).toThrow(expect.objectContaining({ code: "EEXIST" }));
  else await expect(createPrivateTextFileAsync(file, "replacement".repeat(mode === "async-large" ? 256 * 1024 : 1))).rejects.toMatchObject({ code: "EEXIST" });
  expect(readFileSync(file, "utf8")).toBe("owned original content");
  expect(readdirSync(root)).toEqual(["owned.txt"]);
});
