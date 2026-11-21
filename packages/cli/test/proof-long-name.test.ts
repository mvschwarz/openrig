import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { replaceArtifactFile } from "../src/commands/proof.js";

it.each([false, true])("replaces a valid long artifact name (existing=%s)", existing => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proof-long-"));
  const name = "x".repeat(230) + ".md", file = path.join(root, name);
  try {
    if (existing) fs.writeFileSync(file, "old owned evidence");
    replaceArtifactFile(file, "new owned evidence");
    expect(fs.readFileSync(file, "utf8")).toBe("new owned evidence");
    expect(fs.readdirSync(root)).toEqual([name]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
