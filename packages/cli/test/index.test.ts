import { describe, it, expect } from "vitest";
import { mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProgram, isDirectRun } from "../src/index.js";
import { CLI_VERSION } from "../src/version.js";

describe("CLI entrypoint direct-run detection", () => {
  it("treats a symlinked bin path as direct execution", () => {
    const actualPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const tmpDir = mkdtempSync(join(tmpdir(), "rigged-index-"));
    const symlinkPath = join(tmpDir, "rig");
    symlinkSync(actualPath, symlinkPath);

    expect(isDirectRun(symlinkPath, pathToFileURL(actualPath).href)).toBe(true);
  });

  it("reports the package version through commander", () => {
    const program = createProgram();
    expect(program.version()).toBe(CLI_VERSION);
  });

  it("registers the native heartbeat command", () => {
    const program = createProgram();
    expect(program.commands.some((cmd) => cmd.name() === "heartbeat")).toBe(true);
  });

  it("registers the native seat command namespace", () => {
    const program = createProgram();
    expect(program.commands.some((cmd) => cmd.name() === "seat")).toBe(true);
  });
});
