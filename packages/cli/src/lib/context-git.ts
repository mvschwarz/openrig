// Git owns history and merges. The context library serves an explicit selection;
// a failed update never publishes a half-merged checkout as agent context.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertDestinationNamespaceContained, assertSafeInstallRef, assertTreeHasNoSymlinks, validateContextPackManifestForInstall } from "./context-install.js";

const RECEIPT = ".openrig-git-source.json";
interface Selection {
  format: 1;
  checkout: string;
  libraryRoot: string;
  pack: string;
  revision: string;
  digest: string;
  selectedAt: string;
}

function git(checkout: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  try {
    return execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, ...extraEnv, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch (err) {
    // Git's stderr can echo a credential-bearing remote. Never export it.
    const status = (err as { status?: number }).status;
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    throw Object.assign(new Error(`git ${args[0]} failed${status == null ? " or timed out" : ` (exit ${status})`}. Checkout retained at ${checkout}; inspect with Git using your existing credentials.`), {
      shallowUnsupported: /^(?:fatal: )?(?:dumb http transport does not support shallow capabilities|Server does not support shallow (?:clients|requests))\s*$/m.test(stderr),
    });
  }
}

function optionalGit(checkout: string, args: string[]): string | null {
  try { return git(checkout, args); } catch { return null; }
}

function originLabel(origin: string | null): string | null {
  if (!origin) return null;
  try {
    const url = new URL(origin);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString();
  } catch { return origin; } // ordinary local paths and Git's user@host:path
}

function checkoutRoot(checkout: string): string {
  const root = realpathSync(checkout);
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== root) {
    throw new Error(`Select the Git checkout root, not a subdirectory: ${checkout}`);
  }
  return root;
}

function packDirectory(checkout: string, pack: string): string {
  if (isAbsolute(pack) || pack.split(/[\\/]/).includes("..")) throw new Error("Pack must be a relative directory inside the checkout.");
  const path = realpathSync(resolve(checkout, pack));
  const rel = relative(checkout, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Pack escapes the checkout.");
  assertTreeHasNoSymlinks(path);
  validateContextPackManifestForInstall(join(path, "manifest.yaml"));
  return path;
}

function discoverPack(checkout: string, selected?: string): string {
  if (selected !== undefined) return relative(checkout, packDirectory(checkout, selected)) || ".";
  // Use the existing repository convention; avoid treating arbitrary mission
  // manifests as packs or recursively walking a private repository's contents.
  const candidates: string[] = [];
  if (existsSync(join(checkout, "manifest.yaml"))) candidates.push(".");
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (existsSync(join(child, "manifest.yaml"))) candidates.push(relative(checkout, child));
      else walk(child);
    }
  };
  walk(join(checkout, ".openrig", "context-packs"));
  if (candidates.length !== 1) throw new Error(`Select a pack with --pack <relative-path>. Discovered ${candidates.length}: ${candidates.join(", ") || "none"}. Checkout retained at ${checkout}.`);
  return candidates[0]!;
}

function digestTree(dir: string): string {
  const hash = createHash("sha256");
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(at, entry.name);
      if (path === join(dir, RECEIPT)) continue;
      if (entry.isDirectory()) walk(path);
      else {
        if (!entry.isFile()) throw new Error(`Context selection contains a non-regular file: ${path}`);
        const bytes = readFileSync(path);
        hash.update(JSON.stringify([relative(dir, path), bytes.length])).update(bytes);
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}

function readSelection(target: string): Selection {
  if (lstatSync(target).isSymbolicLink()) throw new Error("Git context selection must not be a symlink.");
  const value = JSON.parse(readFileSync(join(target, RECEIPT), "utf8")) as Selection;
  if (value.format !== 1 || typeof value.libraryRoot !== "string" || !isAbsolute(value.libraryRoot) || typeof value.checkout !== "string" || !isAbsolute(value.checkout) || typeof value.pack !== "string" || !/^[a-f0-9]{40,64}$/.test(value.revision) || !/^[a-f0-9]{64}$/.test(value.digest)) {
    throw new Error("Invalid Git source receipt; selection and checkout left unchanged.");
  }
  return value;
}

function cleanCheckout(checkout: string): void {
  if (git(checkout, ["status", "--porcelain"])) throw new Error(`Checkout has local changes or conflicts. Preserve/commit them with Git before updating: ${checkout}`);
  if (optionalGit(checkout, ["rev-parse", "--verify", "MERGE_HEAD"])) throw new Error(`A merge is still in progress at ${checkout}; complete or abort it with Git first.`);
}

function selectPack(checkout: string, pack: string, target: string, libraryRoot: string, previous?: Selection): Selection {
  cleanCheckout(checkout);
  const source = packDirectory(checkout, pack);
  const revision = git(checkout, ["rev-parse", "HEAD"]);
  const history = `${resolve(libraryRoot)}-git-history`;
  const staging = join(history, `staging-${randomUUID()}`);
  mkdirSync(staging, { recursive: true });
  // Copy only the declared reader inputs, never .git or unrelated private data.
  const manifest = parseYaml(readFileSync(join(source, "manifest.yaml"), "utf8")) as { files: Array<{ path: string }> };
  for (const file of ["manifest.yaml", ...manifest.files.map((f) => f.path)]) {
    const from = join(source, file);
    git(checkout, ["ls-files", "--error-unmatch", "--", relative(checkout, from)]);
    if (!lstatSync(from).isFile()) throw new Error(`Declared context input is not a regular file: ${from}. Staging retained at ${staging}`);
    mkdirSync(dirname(join(staging, file)), { recursive: true });
    copyFileSync(from, join(staging, file));
  }
  cleanCheckout(checkout);
  if (git(checkout, ["rev-parse", "HEAD"]) !== revision) throw new Error(`Checkout moved during selection; staging retained at ${staging}. Retry after its writer settles.`);
  const selection: Selection = { format: 1, checkout, libraryRoot: resolve(libraryRoot), pack, revision, digest: digestTree(staging), selectedAt: new Date().toISOString() };
  writeFileSync(join(staging, RECEIPT), JSON.stringify(selection, null, 2) + "\n");
  // Preserve the previous served directory, including its receipt. Never reset,
  // delete or silently absorb edits made directly to the installed selection.
  if (previous) {
    if (digestTree(target) !== previous.digest) throw new Error(`Served context changed during update; staging retained at ${staging}.`);
    const retained = join(history, `previous-${randomUUID()}`);
    renameSync(target, retained);
    try { renameSync(staging, target); }
    catch (err) { renameSync(retained, target); throw err; }
  } else {
    if (existsSync(target)) throw new Error(`Context destination already exists: ${target}`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(staging, target);
  }
  return selection;
}

export function inspectGitContext(target: string) {
  const selected = readSelection(target);
  const currentDigest = digestTree(target);
  const served = { path: target, ...selected, currentDigest, edited: currentDigest !== selected.digest };
  try {
    const checkout = checkoutRoot(selected.checkout);
    const revision = git(checkout, ["rev-parse", "HEAD"]);
    const upstream = optionalGit(checkout, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    const counts = upstream ? optionalGit(checkout, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])?.split(/\s+/).map(Number) : null;
    const branch = optionalGit(checkout, ["symbolic-ref", "--short", "HEAD"]);
    const remote = branch ? optionalGit(checkout, ["config", "--get", `branch.${branch}.remote`]) : null;
    const origin = remote ? optionalGit(checkout, ["remote", "get-url", "--", remote]) : null;
    return {
      served, checkout: { path: checkout, revision, branch, remote, origin: originLabel(origin),
        status: git(checkout, ["status", "--porcelain"]), conflicts: git(checkout, ["diff", "--name-only", "--diff-filter=U"]),
        upstream, ahead: counts?.[0] ?? null, behind: counts?.[1] ?? null,
        selectedRevisionMatches: revision === selected.revision,
        selectedPackDiff: git(checkout, ["diff", "--stat", selected.revision, "--", selected.pack]),
      },
      remoteAvailability: "UNVERIFIED; inspect uses local refs, update explicitly fetches",
      consumption: "UNVERIFIED; selection is readable context, not evidence that an agent read or used it",
    };
  } catch (err) {
    return { served, checkout: { path: selected.checkout, unavailable: (err as Error).message }, remoteAvailability: "UNVERIFIED", consumption: "UNVERIFIED" };
  }
}

export function addGitContext(source: string, opts: { pack?: string; name?: string; checkout?: boolean; onWarning?: (message: string) => void }, targetRoot: string) {
  if (opts.name) assertSafeInstallRef(opts.name);
  let checkout: string;
  let warning: string | undefined;
  if (opts.checkout) checkout = checkoutRoot(source);
  else {
    // Existing Git credential helpers remain in charge; no secret arguments.
    if (source.startsWith("-") || /^(?:https?:\/\/[^/]*@|[a-z]+:\/\/[^/]*:[^/]*@)/i.test(source)) throw new Error("Use a repository path or credential-free Git URL with your existing Git credential mechanism.");
    const parent = `${resolve(targetRoot)}-git-checkouts`;
    mkdirSync(parent, { recursive: true });
    // Resolve a local path before changing Git's working directory.
    const remote = existsSync(source) ? resolve(source) : source;
    const advertised = git(parent, ["ls-remote", "--symref", "--", remote, "HEAD", "refs/heads/*"]);
    const revision = /^([a-f0-9]{40}|[a-f0-9]{64})\tHEAD$/m.exec(advertised)?.[1];
    let branchRef = /^ref: (refs\/heads\/[^\t\r\n]+)\tHEAD$/m.exec(advertised)?.[1];
    if (!revision) throw new Error("Git source has no advertised HEAD commit. Check its default branch before retrying.");
    checkout = join(parent, randomUUID());
    // Old Git ignores this environment variable and retains its SHA-1 default.
    git(parent, ["init", "--", checkout], { GIT_DEFAULT_HASH: revision.length === 64 ? "sha256" : "sha1" });
    if (!branchRef) {
      // Match clone's inference: configured initial branch, then master, then
      // the first matching advertised branch. Ref metadata fetches no objects.
      const matching = advertised.split("\n")
        .filter(line => line.startsWith(`${revision}\trefs/heads/`))
        .map(line => line.split("\t")[1]!);
      const initialBranch = git(checkout, ["symbolic-ref", "HEAD"]);
      branchRef = matching.find(ref => ref === initialBranch)
        ?? matching.find(ref => ref === "refs/heads/master") ?? matching[0];
    }
    git(checkout, ["remote", "add", "origin", remote]);
    try {
      // Pin the advertised commit even if the branch advances during the fetch.
      // Depth and no-tags keep deleted catalog objects out of the initial download.
      git(checkout, ["fetch", "--depth=1", "--no-tags", "origin", revision]);
    } catch (err) {
      if (!(err as { shallowUnsupported?: boolean }).shallowUnsupported) throw err;
      warning = "Git source refused shallow retrieval; using a full clone, including repository history.";
      opts.onWarning?.(warning);
      // Keep the failed checkout for inspection, just as other Git failures do.
      checkout = join(parent, randomUUID());
      git(parent, ["clone", "--", remote, checkout]);
    }
    // Older transports can omit HEAD's symref. A full clone may still infer its
    // default branch; retain that relationship instead of detaching it.
    const branch = branchRef?.slice("refs/heads/".length) ?? (warning ? optionalGit(checkout, ["symbolic-ref", "--short", "HEAD"]) : null);
    if (branch) {
      if (!warning) git(checkout, ["update-ref", `refs/remotes/origin/${branch}`, revision]);
      // This is a newly created checkout: pin its branch even after a full fallback.
      git(checkout, ["checkout", "-B", branch, revision]);
      git(checkout, ["branch", "--set-upstream-to", `origin/${branch}`, "--", branch]);
    } else {
      git(checkout, ["checkout", "--detach", revision]);
    }
    checkout = checkoutRoot(checkout);
  }
  const pack = discoverPack(checkout, opts.pack);
  const manifest = parseYaml(readFileSync(join(packDirectory(checkout, pack), "manifest.yaml"), "utf8")) as { name: string };
  const name = opts.name ?? manifest.name;
  assertSafeInstallRef(name);
  assertDestinationNamespaceContained(targetRoot, name);
  const target = join(targetRoot, name);
  try { lstatSync(target); throw new Error(`Context destination already exists: ${target}. Checkout retained at ${checkout}`); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  const selected = selectPack(checkout, pack, target, targetRoot);
  return { installedAt: target, selected, ...(warning ? { warning } : {}) };
}

export function updateGitContext(target: string) {
  const selected = readSelection(target);
  if (digestTree(target) !== selected.digest) throw new Error(`Served context has local edits. Preserve them in ${selected.checkout}, commit with Git, then restore this selection explicitly before retrying. Nothing overwritten.`);
  const checkout = checkoutRoot(selected.checkout);
  cleanCheckout(checkout);
  const lock = `${target}.update-lock`;
  mkdirSync(lock); // fail visibly on an overlapping update; never steal a lock
  try {
    const branch = git(checkout, ["symbolic-ref", "--short", "HEAD"]);
    const remote = git(checkout, ["config", "--get", `branch.${branch}.remote`]);
    const merge = git(checkout, ["config", "--get", `branch.${branch}.merge`]);
    if (!remote || remote.startsWith("-") || !merge.startsWith("refs/heads/")) throw new Error("Select a branch with an ordinary Git upstream before updating.");
    git(checkout, ["fetch", "--", remote]);
    // Git preserves both parents on a true merge and leaves conflicts visible.
    // No autostash, reset, rebase, force, push or semantic conflict strategy.
    git(checkout, ["merge", "--no-edit", "@{upstream}"]);
    selectPack(checkout, selected.pack, target, selected.libraryRoot, selected);
    return inspectGitContext(target);
  } finally { rmdirSync(lock); }
}
