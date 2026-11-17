import fs from "node:fs";
import path from "node:path";
import { lstatLinkInfo } from "../../src/domain/restore-guidance.js";

/** Actual disk operations: tests must catch links and missing parent directories. */
export const ompFiles = {
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
