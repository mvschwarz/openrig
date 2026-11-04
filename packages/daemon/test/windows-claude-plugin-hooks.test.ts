import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { windowsClaudePluginHooks, windowsCodexPluginHooks } from "../src/domain/windows-claude-plugin-hooks.js";
import { PluginVendorService } from "../src/domain/plugin-vendor-service.js";
import { codexPluginContentHash, shippedCodexPluginContentHash } from "../src/domain/codex-owned-plugin-trust.js";

const manifestPath = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/claude.json");
const source = fs.readFileSync(manifestPath, "utf8");

it.runIf(process.platform === "win32")("runs the native Codex plugin command with stdin and preserves exit status", () => {
  const original = fs.readFileSync(path.join(path.dirname(manifestPath), "codex.json"), "utf8");
  const native = JSON.parse(windowsCodexPluginHooks(original));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native codex hook "));
  try {
    fs.mkdirSync(path.join(root, "hooks/scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "hooks/scripts/activity-relay.cjs"), "process.stdout.write(require('fs').readFileSync(0,'utf8'));process.exit(7);");
    const command = native.hooks.SessionStart[0].hooks[0].command.replaceAll("${PLUGIN_ROOT}", root);
    const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", "& " + command], { env: { ...process.env, OPENRIG_NODE: process.execPath, OPENRIG_SEAT_PROJECT_DIR: root }, input: '{"owned":true}', encoding: "utf8", windowsHide: true });
    expect(result.stdout).toBe('{"owned":true}');
    // PowerShell needs an explicit exit to propagate a native program's status.
    const exited = spawnSync("powershell.exe", ["-NoProfile", "-Command", "& " + command + "; exit $LASTEXITCODE"], { env: { ...process.env, OPENRIG_NODE: process.execPath, OPENRIG_SEAT_PROJECT_DIR: root }, input: '{}', encoding: "utf8", windowsHide: true });
    expect(exited.status).toBe(7);
    expect(Object.keys(native.hooks)).toEqual(Object.keys(JSON.parse(original).hooks));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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
        expect({ ...next, command: undefined, shell: undefined, args: undefined }).toEqual({ ...hook, command: undefined, shell: undefined, args: undefined });
        expect(next.shell).toBeUndefined();
        expect(next.command).toBe(process.execPath);
        expect(next.args.slice(0, 1)).toEqual(["-e"]);
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
  it.each([0, 2, 7])("preserves hook exit %s and refuses a missing selected Node", code => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-hook-exit-"));
    try {
      const script = path.join(root, "hook.cjs");
      fs.writeFileSync(script, `process.exit(${code});`);
      const command = '"${OPENRIG_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/hook.cjs"';
      const projected = JSON.parse(windowsClaudePluginHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } })));
      const hook = projected.hooks.Stop[0].hooks[0];
      const args = hook.args.map((arg: string) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", root));
      const env = { ...process.env, OPENRIG_NODE: process.execPath };
      expect(spawnSync(hook.command, args, { env, windowsHide: true, timeout: 5000 }).status).toBe(code);
      const missing = spawnSync(hook.command, args, { env: { ...env, OPENRIG_NODE: path.join(root, "missing-node.exe") }, encoding: "utf8", windowsHide: true, timeout: 5000 });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("ENOENT");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("stages a native versioned tree, preserves replaced bytes, and fingerprints actual installed bytes without rewriting them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native plugin staging "));
    const assets = path.resolve(import.meta.dirname, "../assets/plugins");
    const shipped = path.join(assets, "openrig-core");
    const plugins = path.join(root, "plugins"), installed = path.join(plugins, "openrig-core");
    const listFiles = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(file).map(child => path.join(entry.name, child));
      if (!entry.isFile()) throw Error("Unexpected fixture entry type");
      return [entry.name];
    });
    const vendor = new PluginVendorService({ vendoredAssetsDir: assets, userPluginsDir: plugins,
      httpClient: async () => { throw Error("No network expected"); },
      fs: { exists: fs.existsSync, readFile: file => fs.readFileSync(file, "utf8"),
        writeFile: (file, bytes) => fs.writeFileSync(file, bytes), mkdirp: dir => { fs.mkdirSync(dir, { recursive: true }); },
        listFiles, copyFileExclusive: (src, dest) => fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL) },
    });
    try {
      fs.cpSync(shipped, installed, { recursive: true });
      for (const manifest of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
        const file = path.join(installed, manifest), json = JSON.parse(fs.readFileSync(file, "utf8"));
        json.version = "0.1.31"; fs.writeFileSync(file, JSON.stringify(json));
      }
      await vendor.ensureVendored("openrig-core");
      const installedHooks = path.join(installed, "hooks/claude.json");
      expect(fs.readFileSync(installedHooks, "utf8")).toBe(windowsClaudePluginHooks(source));
      const backups = listFiles(path.join(root, "backups/managed-refresh"));
      const oldHooks = backups.find(file => file.replaceAll("\\", "/").endsWith("/hooks/claude.json"));
      expect(oldHooks).toBeDefined();
      expect(fs.readFileSync(path.join(root, "backups/managed-refresh", oldHooks!), "utf8")).toBe(source);
      const expected = shippedCodexPluginContentHash(shipped, true);
      expect(codexPluginContentHash(installed, true)).toBe(expected);
      expect(codexPluginContentHash(shipped, true)).not.toBe(expected);
      const before = fs.readFileSync(installedHooks);
      await vendor.ensureVendored("openrig-core");
      expect(fs.readFileSync(installedHooks)).toEqual(before);
      // Actual installed hashes never project, normalize, or overlook altered content.
      for (const relative of ["hooks/claude.json", "hooks/codex.json", "hooks/scripts/activity-relay.cjs"]) {
        const file = path.join(installed, relative), original = fs.readFileSync(file);
        fs.appendFileSync(file, "\nmodified-by-fixture\n");
        expect(codexPluginContentHash(installed, true), relative).not.toBe(expected);
        fs.writeFileSync(file, original);
      }
      fs.mkdirSync(path.join(installed, ".venv")); fs.writeFileSync(path.join(installed, ".venv/extra"), "not shipped");
      expect(codexPluginContentHash(installed, true)).not.toBe(expected);
      fs.rmSync(path.join(installed, ".venv"), { recursive: true });
      // Equal versions and operator edits keep their existing authority.
      fs.writeFileSync(installedHooks, "operator-owned equal-version bytes");
      await vendor.ensureVendored("openrig-core");
      expect(fs.readFileSync(installedHooks, "utf8")).toBe("operator-owned equal-version bytes");
      expect(codexPluginContentHash(installed, true)).not.toBe(expected);
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });

  it.each(["explicit", "legacy"])("executes every hook with %s Node selection and Unicode stdin", kind => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "插件 O'Brien %PATH% $HOME "));
    try {
      const native = JSON.parse(windowsClaudePluginHooks(source));
      const original = JSON.parse(source);
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
          const args = hook.args.map((arg: string) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", root));
          const run = spawnSync(hook.command, args, {
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
