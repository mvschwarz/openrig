import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexHome } from "../src/domain/codex-auth.js";
import { resolveWindowsProviderCommand } from "../src/domain/windows-provider-command.js";
import { resolveClaudeExecutable } from "../src/domain/provider/claude-auth-status-reader.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it.runIf(process.platform === "win32")("uses selected PATHEXT order and preserves an explicitly empty list", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-native-ext-")); dirs.push(root);
  for (const ext of ["exe", "com"]) fs.writeFileSync(path.join(root, `codex.${ext}`), "selection only; never executed");
  expect(resolveWindowsProviderCommand("codex", { PATH: root, pAtHeXt: ".EXE;.COM" }).command).toBe(fs.realpathSync(path.join(root, "codex.exe")));
  expect(resolveWindowsProviderCommand("codex", { PATH: root, PATHEXT: ".COM;.EXE" }).command).toBe(fs.realpathSync(path.join(root, "codex.com")));
  expect(() => resolveWindowsProviderCommand("codex", { PATH: root, PATHEXT: "", pAtHeXt: ".EXE" })).toThrow("No codex executable");
  for (const ext of ["exe", "com"]) fs.writeFileSync(path.join(root, `claude.${ext}`), "selection only; never executed");
  expect(resolveClaudeExecutable({ PATH: root, PathExt: ".EXE;.COM" })).toBe(path.join(root, "claude.exe"));
  expect(resolveClaudeExecutable({ PATH: root, PATHEXT: "" })).toBeNull();
});

it.runIf(process.platform === "win32")("selects copied home variables with native case and duplicate-key precedence", () => {
  const root = path.join(os.tmpdir(), "synthetic-home"), chosen = path.join(root, "chosen");
  expect(resolveCodexHome({ home: root }).codexHome).toBe(path.join(root, ".codex"));
  expect(resolveCodexHome({ home: root, codex_home: chosen }).codexHome).toBe(chosen);
  expect(resolveCodexHome({ home: root, codex_home: chosen, CODEX_HOME: "" }).codexHome).toBe(path.join(root, ".codex"));
});

it.runIf(process.platform === "win32")("selects the native executable from mixed-case copied PATH and keeps its first duplicate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-native-path-")); dirs.push(root);
  const first = path.join(root, "first"), second = path.join(root, "second");
  fs.mkdirSync(first); fs.mkdirSync(second);
  for (const dir of [first, second]) for (const name of ["codex.exe", "claude.exe"]) fs.writeFileSync(path.join(dir, name), "synthetic selection witness, never executed");
  expect(resolveWindowsProviderCommand("codex", { pAtH: second })).toEqual({ command: fs.realpathSync(path.join(second, "codex.exe")), prefix: [] });
  expect(resolveWindowsProviderCommand("codex", { PATH: first, pAtH: second })).toEqual({ command: fs.realpathSync(path.join(first, "codex.exe")), prefix: [] });
  expect(resolveClaudeExecutable({ pAtH: second })).toBe(path.resolve(second, "claude.exe"));
  expect(resolveClaudeExecutable({ PATH: first, pAtH: second })).toBe(path.resolve(first, "claude.exe"));
});
