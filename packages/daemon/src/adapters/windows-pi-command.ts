import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** Run standard npm Pi through Node, without evaluating a cmd.exe shim. */
export function resolveWindowsPiCommand(searchPath: string, nodeExecutable: string): { command: string; prefix: string[] } {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const exe = path.join(dir, "pi.exe");
    if (existsSync(exe)) return { command: realpathSync(exe), prefix: [] };
    const shim = path.join(dir, "pi.cmd");
    if (!existsSync(shim)) continue;
    const pkg = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    const manifest = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8"));
    const bin = manifest.bin?.pi;
    if (manifest.name !== "@earendil-works/pi-coding-agent" || typeof bin !== "string" || path.isAbsolute(bin))
      throw new Error("Windows Pi requires a native executable or a recognized npm installation");
    const entry = path.resolve(pkg, bin);
    const relative = path.relative(pkg, entry);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Pi npm entry escapes its package");
    const needle = `%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\${bin.replace(/\//g, "\\")}`;
    if (!readFileSync(shim, "utf8").includes(needle)) throw new Error("Unrecognized Windows Pi shim");
    return { command: nodeExecutable, prefix: [realpathSync(entry)] };
  }
  throw new Error("Pi was not found on the Windows runner PATH");
}
