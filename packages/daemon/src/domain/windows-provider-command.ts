import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { readPlatformEnv } from "./platform-env.js";

/** Native spawn cannot execute npm's .cmd launcher. Recognize the installed
 * provider package and invoke its JS entry through Node without cmd.exe quoting. */
export function resolveCodexCommand(env: NodeJS.ProcessEnv, cwd = process.cwd()): { command: string; prefix: string[] } {
  return resolveWindowsProviderCommand("codex", env, cwd);
}

export function resolveWindowsProviderCommand(name: "codex" | "claude", env: NodeJS.ProcessEnv, cwd = process.cwd(), platform: NodeJS.Platform = process.platform): { command: string; prefix: string[] } {
  if (platform !== "win32") return { command: name, prefix: [] };
  const packageName = name === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
  const searchPath = readPlatformEnv(env, "PATH", platform) ?? "";
  const extensions = (readPlatformEnv(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(value => value.toLowerCase());
  for (const value of searchPath.split(path.delimiter)) {
    const directory = path.resolve(cwd, value.replace(/^"(.*)"$/, "$1"));
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      if (extension === ".exe" || extension === ".com") return { command: realpathSync(candidate), prefix: [] };
      const local = path.basename(directory).toLowerCase() === ".bin";
      const modules = local ? path.dirname(directory) : path.join(directory, "node_modules");
      const root = path.join(modules, ...packageName.split("/"));
      const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
      if (extension !== ".cmd" || manifest.name !== packageName || typeof entry !== "string" || path.isAbsolute(entry)) {
        throw new Error(`Windows ${name} requires a native executable or a recognized npm installation`);
      }
      const file = path.resolve(root, entry), relative = path.relative(root, file);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error(`${name} npm entry escapes its package`);
      const needle = `%dp0%\\${local ? ".." : "node_modules"}\\${packageName.replaceAll("/", "\\")}\\${entry.replaceAll("/", "\\")}`;
      if (!readFileSync(candidate, "utf8").includes(needle)) throw new Error(`Unrecognized Windows ${name} shim`);
      const node = [path.join(directory, "node.exe"), ...searchPath.split(path.delimiter).map(dir => path.resolve(cwd, dir.replace(/^"(.*)"$/, "$1"), "node.exe"))].find(file => existsSync(file) && statSync(file).isFile());
      if (!node) throw new Error(`${name} npm installation requires Node on its launch PATH`);
      return { command: realpathSync(node), prefix: [realpathSync(file)] };
    }
  }
  const error = new Error(`No ${name} executable on the Windows launch PATH`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  throw error;
}
