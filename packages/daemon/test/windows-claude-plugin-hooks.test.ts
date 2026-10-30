import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { windowsClaudePluginHooks } from "../src/domain/windows-claude-plugin-hooks.js";

const manifestPath = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/claude.json");
const source = fs.readFileSync(manifestPath, "utf8");

it("preserves the complete shipped event/group/metadata vocabulary", () => {
  const original = JSON.parse(source), native = JSON.parse(windowsClaudePluginHooks(source));
  let count = 0;
  expect(Object.keys(native.hooks)).toEqual(Object.keys(original.hooks));
  for (const event of Object.keys(original.hooks)) {
    expect(native.hooks[event]).toHaveLength(original.hooks[event].length);
    original.hooks[event].forEach((group: any, index: number) => {
      const projected = native.hooks[event][index];
      expect({ ...projected, hooks: undefined }).toEqual({ ...group, hooks: undefined });
      expect(projected.hooks).toHaveLength(group.hooks.length);
      group.hooks.forEach((hook: any, h: number) => {
        const next = projected.hooks[h];
        expect({ ...next, command: undefined, shell: undefined }).toEqual({ ...hook, command: undefined, shell: undefined });
        expect(next.shell).toBe("powershell");
        count++;
      });
    });
  }
  expect(count).toBe(13);
  expect(fs.readFileSync(manifestPath, "utf8")).toBe(source);
});

it.each(["node arbitrary.js", '"${OPENRIG_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/../outside.cjs"',
  '"${OPENRIG_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/safe.cjs"; echo injected',
  '"${OPENRIG_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/safe.cjs" $(echo injected)'])("rejects unrecognized command text: %s", command => {
  expect(() => windowsClaudePluginHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }))).toThrow();
});

describe.skipIf(process.platform !== "win32")("native Claude plugin manifest commands", () => {
  it.each(["explicit", "legacy"])("executes every hook with %s Node selection and Unicode stdin", kind => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "插件 O'Brien %PATH% $HOME "));
    try {
      const native = JSON.parse(windowsClaudePluginHooks(source));
      const original = JSON.parse(source);
      const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (["PATH", "OPENRIG_NODE", "CLAUDE_PLUGIN_ROOT"].includes(key.toUpperCase())) delete env[key];
      env.PATH = kind === "explicit" ? "" : path.dirname(process.execPath);
      env.CLAUDE_PLUGIN_ROOT = root;
      if (kind === "explicit") env.OPENRIG_NODE = process.execPath;
      for (const event of Object.keys(native.hooks)) {
        native.hooks[event].forEach((group: any, g: number) => group.hooks.forEach((hook: any, h: number) => {
          const text = original.hooks[event][g].hooks[h].command as string;
          const match = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)"(.*)$/.exec(text)!;
          const script = path.join(root, match[1]!);
          fs.mkdirSync(path.dirname(script), { recursive: true });
          fs.writeFileSync(script, "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({node:process.execPath,args:process.argv.slice(2),input:JSON.parse(s)})))");
          const input = { event, value: "原生 O'Brien %PATH% $HOME" };
          const run = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", hook.command], {
            env, cwd: root, input: JSON.stringify(input), encoding: "utf8", timeout: 5000, windowsHide: true,
          });
          expect(run.error).toBeUndefined();
          expect(run.status, run.stderr).toBe(0);
          expect(JSON.parse(run.stdout)).toEqual({ node: process.execPath, args: match[2]!.trim() ? match[2]!.trim().split(" ") : [], input });
        }));
      }
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  }, 30000);
});
