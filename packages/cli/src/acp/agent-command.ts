import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { readPlatformEnv } from "../lib/codex-auth.js";

/** Run npm ACP agents through their declared Node entry, without a cmd.exe
 * round trip that would reinterpret protocol arguments. Native programs retain
 * ordinary spawn semantics; unrelated batch launchers are not inferred. */
export function resolveAcpAgentCommand(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): { command: string; prefix: string[] } {
  const unchanged = { command, prefix: [] as string[] };
  if (process.platform !== "win32") return unchanged;
  const searchPath = readPlatformEnv(env, "PATH") ?? "";
  const directories = searchPath.split(path.delimiter).map(value => path.resolve(cwd, value.replace(/^"(.*)"$/, "$1")));
  const explicit = /[\\/]/.test(command);
  const bases = explicit ? [path.resolve(cwd, command)] : directories.map(directory => path.join(directory, command));
  // Dots also occur in command stems: owned.agent may name owned.agent.cmd.
  // Prefer an exact dotted filename, then retain the selected PATHEXT order.
  const extensions = [...new Set([
    ...(path.extname(command) ? [""] : []),
    ...(readPlatformEnv(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean),
  ])];
  for (const base of bases) for (const extension of extensions) {
    const candidate = base + extension;
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    if (!/\.(cmd|bat)$/i.test(candidate)) return { command: realpathSync(candidate), prefix: [] };
    const fail = () => new Error("Windows ACP batch agents require a recognized npm Node launcher; use the native executable or Node entry explicitly");
    if (!/\.cmd$/i.test(candidate)) throw fail();
    const shim = readFileSync(candidate, "utf8");
    const match = shim.match(/"%_prog%"\s+"%dp0%[\\/]([^"\r\n]+)"\s+%\*/i);
    if (!match) throw fail();
    const directory = path.dirname(candidate);
    const target = match[1]!.split(/[\\/]/);
    const moduleDirectory = target[0]?.toLowerCase() === "node_modules" ? path.join(directory, "node_modules")
      : target[0] === ".." && path.basename(directory).toLowerCase() === ".bin" ? path.dirname(directory) : undefined;
    if (!moduleDirectory) throw fail();
    const parts = target.slice(1);
    const packageParts = parts[0]?.startsWith("@") ? 2 : 1;
    const packageName = parts.slice(0, packageParts).join("/");
    if (parts.length <= packageParts || parts.some(part => !part || part === "." || part === "..")) throw fail();
    const root = path.join(moduleDirectory, ...parts.slice(0, packageParts));
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const name = path.basename(candidate, path.extname(candidate));
    const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
    if (manifest.name !== packageName || typeof entry !== "string" || path.isAbsolute(entry)) throw fail();
    const file = path.resolve(root, entry);
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)
      || file.toLowerCase() !== path.resolve(moduleDirectory, ...parts).toLowerCase()) throw fail();
    const node = [path.join(directory, "node.exe"), ...directories.map(dir => path.join(dir, "node.exe"))]
      .find(file => existsSync(file) && statSync(file).isFile());
    if (!node) throw new Error("Windows npm ACP agent requires Node on its launch PATH");
    return { command: realpathSync(node), prefix: [realpathSync(file)] };
  }
  return unchanged; // spawn reports its normal ENOENT, through the existing outcome path.
}
