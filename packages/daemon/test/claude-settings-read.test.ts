import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { settingsFileConflicts } from "../src/domain/claude-credential-precedence.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const fixture = () => { const root = mkdtempSync(path.join(tmpdir(), "claude-settings-read-")); roots.push(root); return root; };

it.skipIf(process.platform === "win32")("a settings FIFO without a writer is refused without blocking the switch", () => {
  const root = fixture(), file = path.join(root, "settings.json");
  execFileSync("mkfifo", [file]);
  // A separate process bounds the regression itself: the old blocking open cannot hang Vitest.
  const runner = path.join(root, "read.mjs");
  writeFileSync(runner, `import { settingsFileConflicts } from ${JSON.stringify(new URL("../src/domain/claude-credential-precedence.ts", import.meta.url).href)};
process.stdout.write(JSON.stringify(settingsFileConflicts(process.argv[2], "fixture")));`);
  const result = spawnSync(process.execPath, ["--import", "tsx", runner, file], { encoding: "utf8", timeout: 5000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ notChecked: expect.stringContaining("unreadable") });
});

it("oversized settings are unreadable rather than parsed or treated as clear", () => {
  const root = fixture(), file = path.join(root, "settings.json");
  writeFileSync(file, "{}"); truncateSync(file, 1024 * 1024 + 1);
  expect(settingsFileConflicts(file, "fixture")).toMatchObject({ notChecked: expect.stringContaining("unreadable") });
});

it("keeps absent, valid and malformed settings outcomes distinct", () => {
  const file = path.join(fixture(), "settings.json");
  expect(settingsFileConflicts(file, "fixture").checked).toContain("absent");
  writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_API_KEY: "synthetic-value" } }));
  expect(settingsFileConflicts(file, "fixture").conflicts).toMatchObject([{ name: "ANTHROPIC_API_KEY" }]);
  writeFileSync(file, "{invalid");
  expect(settingsFileConflicts(file, "fixture").notChecked).toContain("not valid JSON");
});
