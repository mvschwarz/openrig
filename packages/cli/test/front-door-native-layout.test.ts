import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveTuiPath } from "../src/front-door.js";

it.runIf(process.platform === "win32")("finds the paired TUI from a differently cased native commands directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "front-door-native-"));
  try {
    const commands = path.join(root, "packages", "cli", "dist", "commands");
    const entry = path.join(root, "packages", "tui", "dist", "main.js");
    fs.mkdirSync(commands, { recursive: true }); fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "// owned layout witness; never executed");
    expect(resolveTuiPath(path.join(path.dirname(commands), "COMMANDS"))).toBe(entry);
    fs.unlinkSync(entry);
    const bundled = path.join(root, "packages", "cli", "tui", "dist", "main.js");
    fs.mkdirSync(path.dirname(bundled), { recursive: true }); fs.writeFileSync(bundled, "// owned fallback");
    expect(resolveTuiPath(path.join(path.dirname(commands), "COMMANDS"))).toBe(bundled);
    fs.unlinkSync(bundled);
    expect(resolveTuiPath(path.join(path.dirname(commands), "COMMANDS"))).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
