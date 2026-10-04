import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const within = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return !!rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "--literal-pathspecs", ...args], {
    encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Call only for files this projection actually created, never existing files
 * inferred to be ours from their name, content or managed-block markers. */
export function excludeNewGeneratedFiles(cwd: string, createdFiles: string[]): void {
  // In-memory adapter files are not filesystem projections.
  const files = createdFiles.filter(file => fs.existsSync(file));
  if (!files.length) return;
  let root: string;
  try { root = fs.realpathSync(git(cwd, "rev-parse", "--show-toplevel").trim()); }
  catch (error) {
    if ((error as { status?: number }).status === 128) return; // Non-Git workspaces are supported.
    console.warn(`[openrig] generated_file_exclude_skipped: ${cwd}: ${(error as Error).message}`);
    return;
  }
  try {
    const exclude = git(root, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
    const common = fs.realpathSync(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").trim());
    const metadataIdentity = (file: string) => fs.existsSync(file) ? fs.realpathSync(file)
      : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    const peers = git(root, "worktree", "list", "--porcelain", "-z").split("\0")
      .filter(field => field.startsWith("worktree ")).map(field => field.slice(9))
      .filter(peer => fs.realpathSync(peer) !== root);
    const patterns: string[] = [];
    for (const file of files) {
      try {
        const canonical = fs.realpathSync(file);
        if (!within(root, canonical) || !fs.lstatSync(file).isFile()) throw new Error("not a regular file inside this worktree");
        const relative = path.relative(root, canonical);
        if (/[\r\n]/.test(relative)) throw new Error("Git exclude cannot represent this filename on one line");
        if (git(root, "ls-files", "-z", "--", relative)) continue; // A tracked deletion may have been recreated.
        for (const peer of peers) {
          const peerExclude = git(peer, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
          if (metadataIdentity(peerExclude) !== metadataIdentity(exclude)) continue;
          // A common info/exclude also affects linked siblings. Unknown origins
          // there are not permission to hide their user-authored files.
          try {
            fs.lstatSync(path.join(peer, relative));
            throw new Error(`same path already exists in sibling worktree ${peer}`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (git(peer, "ls-files", "-z", "--", relative)) throw new Error(`same path is tracked in sibling worktree ${peer}`);
        }
        patterns.push(`/${relative.split(path.sep).join("/").replace(/([\\*?\[\] !#])/g, "\\$1")}`);
      } catch (error) {
        console.warn(`[openrig] generated_file_exclude_skipped: ${file}: ${(error as Error).message}`);
      }
    }
    if (!patterns.length) return;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    if (!within(common, fs.realpathSync(path.dirname(exclude)))
      || (fs.existsSync(exclude) && !within(common, fs.realpathSync(exclude)))) {
      throw new Error("Git exclusion path resolves outside repository metadata");
    }
    if (fs.existsSync(exclude) && !fs.statSync(exclude).isFile()) throw new Error("Git exclusion target is not a regular file");
    const original = fs.existsSync(exclude) ? fs.readFileSync(exclude) : Buffer.alloc(0);
    const existing = new Set(original.toString("utf8").split(/\r?\n/));
    const added = [...new Set(patterns)].filter(pattern => !existing.has(pattern));
    if (!added.length) return;
    const separator = original.length && original.at(-1) !== 10 ? "\n" : "";
    // Append only: user bytes (including line endings) are never rewritten.
    fs.appendFileSync(exclude, `${separator}# BEGIN OpenRig generated files\n${added.join("\n")}\n# END OpenRig generated files\n`);
  } catch (error) {
    // Hygiene failure is visible, but cannot turn a successful projection into
    // a launch refusal or justify a broader ignore rule.
    console.warn(`[openrig] generated_file_exclude_skipped: ${cwd}: ${(error as Error).message}`);
  }
}
