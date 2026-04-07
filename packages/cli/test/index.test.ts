import { describe, it, expect } from "vitest";
import { mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDirectRun } from "../src/index.js";

describe("CLI entrypoint direct-run detection", () => {
  it("treats a symlinked bin path as direct execution", () => {
    const actualPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const tmpDir = mkdtempSync(join(tmpdir(), "rigged-index-"));
    const symlinkPath = join(tmpDir, "rig");
    symlinkSync(actualPath, symlinkPath);

    expect(isDirectRun(symlinkPath, pathToFileURL(actualPath).href)).toBe(true);
  });
});
