import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const within = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return !!rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const patternFor = (relative: string) => `/${relative.split(path.sep).join("/").replace(/([\\*?\[\] !#])/g, "\\$1")}`;
// Git's ignore-case comparison folds ASCII bytes, not Unicode filenames.
const foldCase = (value: string) => value.replace(/[A-Z]/g, c => c.toLowerCase());

/** Only pass files this projection created. Existing names/bytes are not ownership. */
export function excludeNewGeneratedFiles(cwd: string, createdFiles: string[]): string[] {
  const warnings: string[] = [];
  const warn = (file: string, reason: string) => {
    const message = `generated_file_exclude_skipped: ${file}: ${reason}`;
    warnings.push(message);
    console.warn(`[openrig] ${message}`);
  };
  const deadline = performance.now() + 5000;
  const remaining = () => {
    const ms = Math.floor(deadline - performance.now());
    if (ms <= 0) throw new Error("Git hygiene deadline exceeded; exclusions left unapplied");
    return ms;
  };
  const git = (dir: string, args: string[], input?: string, allowAbsent = false): string => {
    try {
      return execFileSync("git", ["-C", dir, "--literal-pathspecs", ...args], {
        encoding: "utf8", timeout: remaining(), killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
        input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      if (allowAbsent && (error as { status?: number }).status === 1) return "";
      throw error;
    }
  };
  const files = createdFiles.filter(file => fs.existsSync(file));
  if (!files.length) return warnings; // In-memory adapters have no disk projection.
  let root: string;
  try { root = fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim()); }
  catch (error) {
    if ((error as { status?: number }).status !== 128) warn(cwd, (error as Error).message);
    return warnings; // Non-Git workspaces are supported.
  }
  try {
    const [exclude, common] = git(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude", "--git-common-dir"]).trimEnd().split("\n");
    if (!exclude || !common) throw new Error("Git did not return exclusion and common metadata paths");
    const metadataIdentity = (file: string) => fs.existsSync(file) ? fs.realpathSync(file)
      : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    // One index/untracked listing per worktree, including ignored files. No per-file Git probes.
    const inventory = (dir: string) => git(dir, ["ls-files", "--cached", "--others", "-t", "-z"])
      .split("\0").filter(Boolean).map(record => ({ tracked: record[0] !== "?", name: record.slice(2) }));
    const own = inventory(root);
    const ignored = new Set(git(root, ["check-ignore", "--stdin", "-z"], files.join("\0") + "\0", true).split("\0"));
    const candidates: Array<{ file: string; relative: string }> = [];
    for (const file of files) {
      remaining();
      const canonical = fs.realpathSync(file);
      if (!within(root, canonical) || !fs.lstatSync(file).isFile()) { warn(file, "not a regular file inside this worktree"); continue; }
      const relative = path.relative(root, canonical);
      if (/[\r\n]/.test(relative)) { warn(file, "Git exclude cannot represent this filename on one line"); continue; }
      if (own.some(item => item.tracked && item.name === relative) || ignored.has(file)) continue;
      if (!path.relative(path.resolve(cwd), canonical).split(path.sep).join("/").startsWith(".codex/plugins/openrig-core/")) {
        const message = `${file} was created by OpenRig and is untracked. If you do not want to commit it, add this line to ${exclude}: ${patternFor(relative)} (shared by linked worktrees).`;
        warnings.push(message);
        console.warn(`[openrig] ${message}`);
        continue;
      }
      candidates.push({ file, relative });
    }
    if (!candidates.length) return warnings;
    const peers = git(root, ["worktree", "list", "--porcelain", "-z"]).split("\0\0")
      .map(record => record.split("\0"))
      .filter(fields => !fields.includes("bare"))
      .map(fields => fields.find(field => field.startsWith("worktree "))?.slice(9))
      .filter((peer): peer is string => !!peer);
    const conflicts = new Set<string>();
    for (const peer of peers) {
      remaining();
      const isRoot = fs.realpathSync(peer) === root;
      const peerExclude = isRoot ? exclude : git(peer, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).trim();
      if (metadataIdentity(peerExclude) !== metadataIdentity(exclude)) continue;
      const ignoreCase = git(peer, ["config", "--type=bool", "--get", "core.ignorecase"], undefined, true).trim() === "true";
      const names = isRoot ? own : inventory(peer);
      const normalize = ignoreCase ? foldCase : (name: string) => name;
      for (const candidate of candidates) {
        remaining();
        const wanted = normalize(candidate.relative);
        if (names.some(item => !(isRoot && !item.tracked && item.name === candidate.relative)
          && (normalize(item.name) === wanted || normalize(item.name).startsWith(`${wanted}/`)))) {
          conflicts.add(candidate.relative);
          warn(candidate.file, `same path or Git case match already exists in worktree ${peer}`);
        }
      }
    }
    const patterns = candidates.filter(c => !conflicts.has(c.relative)).map(c => patternFor(c.relative));
    if (!patterns.length) return warnings;
    remaining();
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    if (!within(fs.realpathSync(common), fs.realpathSync(path.dirname(exclude)))
      || (fs.existsSync(exclude) && !within(fs.realpathSync(common), fs.realpathSync(exclude)))) {
      throw new Error("Git exclusion path resolves outside repository metadata");
    }
    if (fs.existsSync(exclude) && !fs.statSync(exclude).isFile()) throw new Error("Git exclusion target is not a regular file");
    const original = fs.existsSync(exclude) ? fs.readFileSync(exclude) : Buffer.alloc(0);
    const existing = new Set(original.toString("utf8").split(/\r?\n/));
    const added = [...new Set(patterns)].filter(pattern => !existing.has(pattern));
    if (!added.length) return warnings;
    remaining();
    const separator = original.length && original.at(-1) !== 10 ? "\n" : "";
    fs.appendFileSync(exclude, `${separator}# BEGIN OpenRig generated files\n${added.join("\n")}\n# END OpenRig generated files\n`);
  } catch (error) { warn(cwd, (error as Error).message); }
  return warnings;
}
