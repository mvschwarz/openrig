import fs from "node:fs";
import path from "node:path";

const regular = (file: string): boolean => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/** Select standard Node npm entries without evaluating a batch launcher.
 * Relative entries are resolved only against the supplied seat directory,
 * never implicitly against the daemon's directory. */
export function windowsCommunityCommand(words: string[], searchPath: string, pathExt = ".COM;.EXE;.BAT;.CMD", cwd?: string): string[] {
  const [program, ...args] = words;
  if (!program) return words;
  const seatCwd = cwd && path.win32.isAbsolute(cwd) ? cwd : undefined;
  const directories = searchPath.split(path.delimiter).map(dir => dir.replace(/^"(.*)"$/, "$1"))
    .map(dir => path.win32.isAbsolute(dir) || !seatCwd ? dir : path.resolve(seatCwd, dir));
  const configuredExtensions = pathExt.split(";").filter(Boolean);
  const extensionIsExplicit = [".exe", ".com", ".bat", ".cmd", ...configuredExtensions.map(ext => ext.toLowerCase())].includes(path.win32.extname(program).toLowerCase());
  const extensions = extensionIsExplicit ? [""] : ["", ...configuredExtensions];
  const candidates: string[] = [];
  if (path.win32.isAbsolute(program)) candidates.push(...extensions.map(ext => program + ext));
  else {
    if (/[\\/]/.test(program)) {
      if (!seatCwd) return words;
      candidates.push(...extensions.map(ext => path.resolve(seatCwd, program + ext)));
    } else for (const dir of directories) {
      if (!path.win32.isAbsolute(dir)) return words;
      candidates.push(...extensions.map(ext => path.join(dir, program + ext)));
      if (candidates.some(regular)) break;
    }
  }
  const selected = candidates.find(regular);
  if (!selected) return words;
  const extension = path.extname(selected).toLowerCase();
  if (extension === ".exe" || extension === ".com") return [fs.realpathSync.native(selected), ...args];
  if (extension === ".bat") throw new Error("Community launch requires a native executable or a standard Node npm entry");
  if (extension !== ".cmd") return [fs.realpathSync.native(selected), ...args];
  const source = fs.readFileSync(selected, "utf8");
  const invocation = /"(node(?:\.exe)?|%dp0%\\node\.exe|%_prog%)"\s+"(%dp0%[\\/][^"]+)"\s+%\*/i.exec(source);
  if (!invocation || (invocation[1]!.toLowerCase() === "%_prog%" && !/set\s+"?_prog=(?:node(?:\.exe)?|%dp0%\\node\.exe)(?:"|\s|$)/i.test(source))) {
    throw new Error("Unrecognized community Node npm shim");
  }
  const directory = path.dirname(selected);
  const parts = invocation[2]!.slice("%dp0%".length).split(/[\\/]/).filter(Boolean);
  const local = path.basename(directory).toLowerCase() === ".bin";
  if (parts.shift()?.toLowerCase() !== (local ? ".." : "node_modules")) throw new Error("Unrecognized community npm layout");
  if (parts.some(part => part === "." || part === "..")) throw new Error("Community npm entry escapes its package");
  const packageParts = parts.splice(0, parts[0]?.startsWith("@") ? 2 : 1);
  const packageRoot = path.join(local ? path.dirname(directory) : path.join(directory, "node_modules"), ...packageParts);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const name = path.basename(selected, path.extname(selected)).toLowerCase();
  const entries = typeof manifest.bin === "string"
    ? (String(manifest.name).split("/").at(-1)?.toLowerCase() === name ? [manifest.bin] : [])
    : Object.entries(manifest.bin ?? {}).filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
  if (manifest.name !== packageParts.join("/") || entries.length !== 1 || typeof entries[0] !== "string" || path.isAbsolute(entries[0])) throw new Error("Community npm entry does not match its package");
  const entry = path.resolve(packageRoot, entries[0]);
  const relative = path.relative(packageRoot, entry);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || !regular(entry)
    || fs.realpathSync.native(entry) !== fs.realpathSync.native(path.join(packageRoot, ...parts))) throw new Error("Community npm entry does not match its shim");
  const siblingNode = path.join(directory, "node.exe");
  let node = regular(siblingNode) ? siblingNode : undefined;
  if (!node) for (const dir of directories) {
    if (!path.win32.isAbsolute(dir)) return words;
    const candidate = path.join(dir, "node.exe");
    if (regular(candidate)) { node = candidate; break; }
  }
  if (!node) throw new Error("Community npm entry requires Node on its launch PATH");
  return [fs.realpathSync.native(node), fs.realpathSync.native(entry), ...args];
}
