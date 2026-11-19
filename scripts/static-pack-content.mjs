import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const outside = (root, file) => {
  const rel = path.relative(root, file);
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
};

/** Resolve only filesystem links or Git-index-attested Windows placeholders.
 * A normal file containing a relative path remains ordinary content. */
export function createStaticContentResolver({ repoRoot, sourceRoot, referenceRoot, platform = process.platform }) {
  const nativePath = file => {
    if (platform !== "win32") return file;
    try { return fs.realpathSync.native(file); } catch { return path.resolve(file); }
  };
  repoRoot = nativePath(repoRoot);
  sourceRoot = nativePath(sourceRoot);
  referenceRoot = nativePath(referenceRoot);
  let links;
  const indexedLinks = () => {
    if (links) return links;
    const result = new Map();
    if (platform !== "win32" || outside(repoRoot, sourceRoot) || !fs.existsSync(path.join(repoRoot, ".git"))) return (links = result);
    let listing;
    try {
      listing = execFileSync("git", ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", path.relative(repoRoot, sourceRoot) || "."], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
    } catch { throw Error("Cannot inspect Git symlink metadata for static packs"); }
    for (const row of listing.split("\0").filter(Boolean)) {
      const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) (\d)\t([\s\S]+)$/.exec(row);
      if (!match) throw Error("Invalid Git index metadata for static packs");
      if (match[3] !== "0") throw Error("Unmerged Git index entry in static packs");
      if (match[1] === "120000") result.set(nativePath(path.resolve(repoRoot, match[4])), match[2]);
    }
    return (links = result);
  };
  const allowedTarget = (file, target) => {
    const real = platform === "win32" ? fs.realpathSync.native(target) : fs.realpathSync(target);
    const reference = platform === "win32" ? fs.realpathSync.native(referenceRoot) : fs.realpathSync(referenceRoot);
    if (outside(reference, real) || !fs.statSync(real).isFile()) {
      throw Error(`static pack symlink ${file} must point to a file under docs/reference/`);
    }
    return real;
  };
  return (file, entry = fs.lstatSync(file)) => {
    if (entry.isSymbolicLink()) return allowedTarget(file, file);
    if (!entry.isFile()) return null;
    const oid = indexedLinks().get(nativePath(path.resolve(file)));
    if (!oid) return file;
    const bytes = fs.readFileSync(file);
    const hash = createHash(oid.length === 40 ? "sha1" : "sha256")
      .update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (hash !== oid) throw Error(`Git symlink placeholder differs from its index entry: ${file}`);
    return allowedTarget(file, path.resolve(path.dirname(file), bytes.toString("utf8")));
  };
}
