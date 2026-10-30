import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Run standard npm Pi through Node, without evaluating a cmd.exe shim. */
export function resolveWindowsPiCommand(searchPath: string, nodeExecutable: string, cwd = process.cwd(), pathExt?: string): { command: string; prefix: string[] } {
  const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(ext => ext.toLowerCase());
  for (const pathEntry of searchPath.split(path.delimiter)) {
    const dir = path.resolve(cwd, pathEntry.replace(/^"(.*)"$/, "$1"));
    for (const extension of extensions) {
      const shim = path.join(dir, `pi${extension}`);
      if (!existsSync(shim) || !statSync(shim).isFile()) continue;
      if (extension === ".exe" || extension === ".com") return { command: realpathSync(shim), prefix: [] };
      if (extension !== ".cmd") throw new Error("Windows Pi requires a native executable or a recognized npm installation");
      const local = path.basename(dir).toLowerCase() === ".bin";
      const modules = local ? path.dirname(dir) : path.join(dir, "node_modules");
      const pkg = path.join(modules, "@earendil-works", "pi-coding-agent");
      const manifest = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8"));
      const bin = manifest.bin?.pi;
      if (manifest.name !== "@earendil-works/pi-coding-agent" || typeof bin !== "string" || path.isAbsolute(bin))
        throw new Error("Windows Pi requires a native executable or a recognized npm installation");
      const entry = path.resolve(pkg, bin);
      const relative = path.relative(pkg, entry);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Pi npm entry escapes its package");
      const needle = `%dp0%\\${local ? ".." : "node_modules"}\\@earendil-works\\pi-coding-agent\\${bin.replace(/\//g, "\\")}`;
      if (!readFileSync(shim, "utf8").includes(needle)) throw new Error("Unrecognized Windows Pi shim");
      return { command: nodeExecutable, prefix: [realpathSync(entry)] };
    }
  }
  throw new Error("Pi was not found on the Windows runner PATH");
}
