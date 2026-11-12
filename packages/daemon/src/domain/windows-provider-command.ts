import { resolveWindowsCommand } from "./windows-command.js";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { readPlatformEnv } from "./platform-env.js";

/** Read-only recognition of an already running npm Claude entry. This proves
 * its declared entry path, not package authenticity or a conversation. */
export function recognizedWindowsClaudeScript(script: string): string | null {
  if (!path.win32.isAbsolute(script) || script.includes("\0")) return null;
  const match = /^(.*[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code)[\\/].+$/i.exec(script);
  if (!match) return null;
  try {
    const root = match[1]!;
    const manifestPath = path.join(root, "package.json");
    const info = statSync(manifestPath);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.claude;
    if (manifest.name !== "@anthropic-ai/claude-code" || typeof entry !== "string" || path.isAbsolute(entry)) return null;
    const file = path.resolve(root, entry), relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || !statSync(file).isFile()) return null;
    const realpath = process.platform === "win32" ? realpathSync.native : realpathSync;
    const declared = realpath(file);
    return realpath(script) === declared ? declared : null;
  } catch { return null; }
}

/** Native spawn cannot execute npm's .cmd launcher. Recognize the installed
 * provider package and invoke its JS entry through Node without cmd.exe quoting. */
export function resolveCodexCommand(env: NodeJS.ProcessEnv, cwd = process.cwd()): { command: string; prefix: string[] } {
  return resolveWindowsProviderCommand("codex", env, cwd);
}

export function resolveWindowsProviderCommand(name: "codex" | "claude", env: NodeJS.ProcessEnv, cwd = process.cwd(), platform: NodeJS.Platform = process.platform): { command: string; prefix: string[] } {
  if (platform !== "win32") return { command: name, prefix: [] };
  const selected = resolveWindowsCommand([name], readPlatformEnv(env, "PATH", platform) ?? "", readPlatformEnv(env, "PATHEXT", platform), cwd,
    { packageName: name === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code" });
  if (selected[0] === name) throw Object.assign(new Error('No '+name+' executable on the Windows launch PATH'), { code: "ENOENT" });
  return { command: selected[0]!, prefix: selected.slice(1) };
}
