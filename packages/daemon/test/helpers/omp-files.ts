import fs from "node:fs";
import path from "node:path";
import { lstatLinkInfo } from "../../src/domain/restore-guidance.js";

/** Actual disk operations: tests must catch links and missing parent directories. */
export const ompFiles = {
  readBytes: (p: string) => fs.readFileSync(p),
  readFile: (p: string) => fs.readFileSync(p, "utf8"),
  writeFile: (p: string, content: string) => fs.writeFileSync(p, content),
  exists: fs.existsSync,
  mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
  copyFile: fs.copyFileSync,
  listFiles: (p: string) => fs.readdirSync(p, { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory()).map(entry => path.relative(p, path.join(entry.parentPath, entry.name))),
  statMode: (p: string) => fs.statSync(p).mode,
  chmod: fs.chmodSync,
  linkInfo: lstatLinkInfo,
};

/** Model rename and removal of files and subtrees in the adapters' in-memory fixtures. */
export function memoryProjectionFiles(files: Record<string, string>) {
  const entries = (root: string) => Object.keys(files).filter(key => key === root || key.startsWith(root + "/"));
  return {
    rename(from: string, to: string) {
      const keys = entries(from);
      if (!keys.length) throw new Error("Missing " + from);
      for (const key of keys) {
        files[to + key.slice(from.length)] = files[key]!;
        delete files[key];
      }
    },
    remove(root: string) { for (const key of entries(root)) delete files[key]; },
  };
}
