import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, realpathSync, statSync, lstatSync, readdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { resolveEffectiveHost } from "../host-selection.js";
import { readLocalOrigin } from "../local-origin.js";
import { getOpenRigHome } from "../openrig-compat.js";
import type { StatusDeps } from "../commands/status.js";
import { authoredMapping, readDeclaredConfigurations, resolveConfiguration, stageConfiguration, ConfigurationError } from "./bundle-configuration.js";

export interface BundleSource {
  repository: string;
  folder: string;
  requestedRef: string;
  resolvedCommit: string;
  canonicalUrl: string;
}

const LINK_HELP = "Use a credential-free HTTPS GitHub folder link: https://github.com/owner/repo/tree/ref/folder.";
export const BUNDLE_LOCALITY_HELP = "GitHub bundle import needs a verified local daemon. Run this command on the daemon host, or create and transfer a .rigbundle there and use the existing path command. Nothing was fetched or installed.";

/** Only the new URL form enters this path; existing filesystem/name inputs keep their dispatch. */
export function isGitHubBundleLink(input: string): boolean {
  try { return new URL(input).hostname.toLowerCase() === "github.com"; }
  catch { return false; }
}

export function parseGitHubBundleLink(input: string): { repository: string; refAndFolder: string[] } {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash) throw new Error();
    const parts = url.pathname.replace(/\/$/, "").slice(1).split("/").map(decodeURIComponent);
    const [owner, rawRepo, kind, ...tail] = parts;
    const repo = rawRepo?.replace(/\.git$/, "");
    if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || [owner, repo].some(p => p === "." || p === "..")) throw new Error();
    if (kind !== undefined && (kind !== "tree" || tail.length === 0)) throw new Error();
    const refAndFolder = tail.flatMap(part => part.split("/"));
    if (refAndFolder.some(p => !p || p === "." || p === ".." || /[\x00-\x1f\\\x7f]/.test(p))) throw new Error();
    return { repository: `https://github.com/${owner}/${repo}`, refAndFolder };
  } catch { throw new Error(LINK_HELP); } // Never echo the input (it may contain credentials).
}

/** Resolve longest named ref, so branch names containing '/' do not become folder names. */
export function selectGitHubBundleSource(input: string, refs: string): BundleSource {
  const { repository, refAndFolder } = parseGitHubBundleLink(input);
  const named = new Map<string, string>();
  for (const line of refs.split("\n")) {
    const [sha, name] = line.split(/\s+/);
    if (!/^[a-f0-9]{40}$/.test(sha ?? "") || !name) continue;
    // A peeled annotated tag names the commit, not its tag object.
    named.set(name, sha!);
  }
  let requestedRef = "HEAD";
  let resolvedCommit = named.get("HEAD");
  let folderParts: string[] = [];
  if (refAndFolder.length) {
    resolvedCommit = undefined;
    if (/^[a-fA-F0-9]{40}$/.test(refAndFolder[0]!)) {
      requestedRef = refAndFolder[0]!;
      resolvedCommit = requestedRef.toLowerCase();
      folderParts = refAndFolder.slice(1);
    } else {
      for (let end = refAndFolder.length; end > 0; end--) {
        const ref = refAndFolder.slice(0, end).join("/");
        const commit = named.get(`refs/heads/${ref}`) ?? named.get(`refs/tags/${ref}^{}`) ?? named.get(`refs/tags/${ref}`);
        if (commit) { requestedRef = ref; resolvedCommit = commit; folderParts = refAndFolder.slice(end); break; }
      }
    }
  }
  if (!resolvedCommit) throw new Error("GitHub bundle ref was not found. Check the branch, tag or full commit in the folder link.");
  return { repository, requestedRef, resolvedCommit, folder: folderParts.join("/") || ".",
    canonicalUrl: `${repository}/tree/${resolvedCommit}${folderParts.length ? "/" + folderParts.map(encodeURIComponent).join("/") : ""}` };
}

export async function localBundleClient(deps: StatusDeps, host?: string): Promise<DaemonClient> {
  if (resolveEffectiveHost(host)) throw new Error(BUNDLE_LOCALITY_HELP);
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (status.state !== "running" || status.healthy === false) throw new Error(BUNDLE_LOCALITY_HELP);
  const client = deps.clientFactory(getDaemonUrl(status));
  const localId = readLocalOrigin();
  if (!localId) throw new Error(BUNDLE_LOCALITY_HELP);
  try {
    const health = await client.get<{ selfHostId?: string }>("/healthz", { timeoutMs: 3000 });
    if (health.status !== 200 || health.data.selfHostId !== localId) throw new Error();
  } catch { throw new Error(BUNDLE_LOCALITY_HELP); }
  return client;
}

const execFileAsync = promisify(execFile);
export async function bundleGit(cwd: string, args: string[]): Promise<string> {
  // Public HTTPS only, with no global credential helpers, URL rewrites, hooks or injected Git config.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    const result = await execFileAsync("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...args], {
      cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...env, HOME: cwd, XDG_CONFIG_HOME: path.join(cwd, ".config"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false", SSH_ASKPASS: "/usr/bin/false" },
    });
    return result.stdout.trimEnd();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && existsSync(cwd)) throw new Error("git is required for GitHub links.");
    throw new Error("GitHub bundle fetch failed or timed out. Check that the repository and ref are publicly readable; no credentials are requested.");
  }
}

/** The link path must not vendor files from the installing host through repository symlinks. */
function checkGitHubBundleSymlinks(checkoutDir: string): void {
  const root = realpathSync(checkoutDir);
  const visited = new Set<string>();
  const walk = (file: string): void => {
    if (lstatSync(file).isSymbolicLink()) {
      file = realpathSync(file);
      const relative = path.relative(root, file);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error();
    }
    if (!statSync(file).isDirectory()) return;
    const directory = realpathSync(file);
    if (visited.has(directory)) return;
    visited.add(directory);
    for (const name of readdirSync(directory)) if (name !== ".git") walk(path.join(directory, name));
  };
  try { walk(root); }
  catch { throw new Error("GitHub bundle symlinks must resolve inside the fetched repository; no bundle was built."); }
}

/** Match the assembler: member refs use the rig directory; imports use their agent directory. */
function checkGitHubBundleAgentRefs(folder: string, checkoutDir: string, retainedCheckoutDir?: string): void {
  const roots = [checkoutDir, ...(retainedCheckoutDir ? [retainedCheckoutDir] : [])].map(dir => realpathSync(dir));
  const contained = (file: string): string => {
    const real = realpathSync(file);
    if (!roots.some(root => {
      const relative = path.relative(root, real);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    })) throw new Error();
    return real;
  };
  const agent = (ref: unknown, from: string, ancestors = new Set<string>()): void => {
    if (ref === "builtin:terminal") return;
    if (typeof ref !== "string") throw new Error();
    const dir = ref.startsWith("local:") && ref.length > 6 ? path.resolve(from, ref.slice(6))
      : ref.startsWith("path:") && path.isAbsolute(ref.slice(5)) ? ref.slice(5) : undefined;
    if (!dir) throw new Error();
    const real = contained(dir);
    if (ancestors.has(real)) throw new Error();
    const spec = parseYaml(readFileSync(contained(path.join(dir, "agent.yaml")), "utf8")) as { imports?: Array<{ ref?: unknown }> };
    const next = new Set(ancestors).add(real);
    // Keep the lexical directory: resolving it first would change relative imports through an alias.
    for (const imp of spec.imports ?? []) agent(imp.ref, dir, next);
  };
  try {
    const spec = parseYaml(readFileSync(path.join(folder, "rig.yaml"), "utf8")) as { pods?: Array<{ members?: Array<{ agent_ref?: unknown }> }> };
    for (const pod of spec.pods ?? []) for (const member of pod.members ?? []) agent(member.agent_ref, folder);
  } catch {
    throw new Error("GitHub bundle agent refs and imports must resolve inside the fetched repository; no bundle was built.");
  }
}

export interface PreparedBundleSource {
  source: BundleSource;
  folder: string;
  checkoutDir: string;
  archivePath: string;
  receiptPath: string;
}

export async function prepareGitHubBundle(input: string, git = bundleGit, importsRoot = path.join(getOpenRigHome(), "bundle-imports")): Promise<PreparedBundleSource> {
  const parsed = parseGitHubBundleLink(input);
  mkdirSync(importsRoot, { recursive: true, mode: 0o700 });
  const owned = mkdtempSync(path.join(importsRoot, "import-"));
  const checkoutDir = path.join(owned, "source");
  try {
    mkdirSync(checkoutDir);
    await git(checkoutDir, ["init", "--template=", "."]);
    const refs = await git(checkoutDir, ["ls-remote", parsed.repository]);
    const source = selectGitHubBundleSource(input, refs);
    await git(checkoutDir, ["fetch", "--depth=1", "--no-tags", "--", source.repository, source.resolvedCommit]);
    const fetched = await git(checkoutDir, ["rev-parse", "FETCH_HEAD^{commit}"]);
    if (fetched !== source.resolvedCommit) throw new Error("GitHub bundle fetch did not match the selected commit; no bundle was built.");
    await git(checkoutDir, ["checkout", "--detach", source.resolvedCommit]);
    let folder: string;
    try {
      folder = realpathSync(path.join(checkoutDir, source.folder));
      const relative = path.relative(realpathSync(checkoutDir), folder);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !statSync(folder).isDirectory() || !statSync(path.join(folder, "rig.yaml")).isFile()) throw new Error();
      const specRelative = path.relative(realpathSync(checkoutDir), realpathSync(path.join(folder, "rig.yaml")));
      if (specRelative === ".." || specRelative.startsWith(`..${path.sep}`) || path.isAbsolute(specRelative)) throw new Error();
    } catch { throw new Error("The selected GitHub bundle folder must contain rig.yaml inside the fetched repository."); }
    checkGitHubBundleSymlinks(checkoutDir);
    checkGitHubBundleAgentRefs(folder, checkoutDir);
    const receiptPath = path.join(owned, "source.json");
    writeFileSync(receiptPath, JSON.stringify(source, null, 2) + "\n");
    return { source, folder, checkoutDir, archivePath: path.join(owned, "bundle.rigbundle"), receiptPath };
  } catch (error) {
    rmSync(owned, { recursive: true, force: true });
    throw error;
  }
}

/** Authored minima enter the existing create/install contract only for the new source path. */
export function authoredCompatibility(folder: string): Record<string, string> {
  const file = path.join(folder, "bundle.yaml");
  if (!existsSync(file)) return {};
  const raw = parseYaml(readFileSync(file, "utf8")) as Record<string, unknown> | null;
  const value = raw?.compatibility;
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bundle.yaml compatibility must be an object.");
  const result: Record<string, string> = {};
  for (const [key, field] of [["min_cli_version", "minCliVersion"], ["min_daemon_version", "minDaemonVersion"]] as const) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(v)) throw new Error(`bundle.yaml compatibility.${key} must be a version string.`);
    result[field] = v;
  }
  return result;
}

export function bundleIdentityLines(data: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const source = data.source as BundleSource | undefined;
  if (source) lines.push(`Source: ${source.canonicalUrl}`, `Commit: ${source.resolvedCommit}`);
  if (typeof data.configurationId === "string") lines.push(`Configuration: ${data.configurationId}`);
  const digest = data.packageDigest as { value?: string; coverage?: string } | undefined;
  if (digest?.value) lines.push(`Package SHA-256: ${digest.value}`, `Coverage: ${digest.coverage}; packaged files only; excludes bundle.yaml, ignored junk and file modes; not host-resolved resources or execution.`);
  const assembler = data.assembler as { openrigVersion?: string; commit?: string } | undefined;
  if (assembler?.openrigVersion) lines.push(`Assembler: OpenRig ${assembler.openrigVersion}${assembler.commit ? ` (${assembler.commit})` : ""}`);
  if (typeof data.archiveHash === "string") lines.push(`Archive SHA-256: ${data.archiveHash}`);
  return lines;
}

export interface BundleLinkOptions {
  host?: string;
  output?: string;
  name?: string;
  bundleVersion?: string;
  preset?: string;
  seat?: string[];
  minDaemonVersion?: string;
  minCliVersion?: string;
  includePackages?: string[];
  contextPack?: string[];
  projectDir?: string;
  allowDrift?: boolean;
  provenance?: Record<string, unknown>;
}

/** Four commands share this preparation. The archive and receipt outlive install/history. */
export async function importGitHubBundle(input: string, deps: StatusDeps, opts: BundleLinkOptions, prepare = prepareGitHubBundle) {
  parseGitHubBundleLink(input); // Refuse credential-bearing input before even contacting a daemon.
  const client = await localBundleClient(deps, opts.host);
  const prepared = await prepare(input);
  let folder = prepared.folder;
  let specPath = path.join(folder, "rig.yaml");
  let configuration: { id: string; preset?: string } | undefined;
  let configurationStaging: string | undefined;
  let compatibility: Record<string, string>;
  try {
    compatibility = authoredCompatibility(folder);
    if (opts.minDaemonVersion) compatibility.minDaemonVersion = opts.minDaemonVersion;
    if (opts.minCliVersion) compatibility.minCliVersion = opts.minCliVersion;
    if (opts.preset !== undefined || (opts.seat?.length ?? 0) > 0) {
      const declared = readDeclaredConfigurations(folder);
      if (!declared) throw new ConfigurationError("This bundle has no configurations.yaml; build it as authored or choose a bundle with declared configurations.");
      const chosen = resolveConfiguration(declared, authoredMapping(specPath), { preset: opts.preset, seats: opts.seat });
      // Preserve monorepo-relative refs when a preset changes the selected rig.
      const staged = stageConfiguration(realpathSync(prepared.checkoutDir), specPath, declared, chosen);
      configurationStaging = staged.stagingDir;
      specPath = staged.rigSpecPath;
      folder = path.dirname(specPath);
      // An absolute in-checkout ref still names the retained original; both owned trees stay until create settles.
      checkGitHubBundleAgentRefs(folder, staged.stagingDir, prepared.checkoutDir);
      configuration = { id: chosen.configurationId, ...(chosen.preset ? { preset: chosen.preset } : {}) };
    }
  } catch (error) {
    rmSync(prepared.checkoutDir, { recursive: true, force: true });
    rmSync(prepared.receiptPath, { force: true });
    if (configurationStaging) rmSync(configurationStaging, { recursive: true, force: true });
    throw error;
  }
  const bundlePath = opts.output ? path.resolve(opts.output) : prepared.archivePath;
  let res: { status: number; data: Record<string, unknown> };
  try {
    res = await client.post<Record<string, unknown>>("/api/bundles/create", {
      specPath, rigRoot: folder, outputPath: bundlePath,
      bundleName: opts.name ?? "github-bundle", bundleVersion: opts.bundleVersion ?? "0.1.0",
      includePackages: opts.includePackages,
      ...(opts.projectDir ? { projectDir: path.resolve(opts.projectDir) } : {}),
      ...(opts.contextPack?.length ? { contextPackDirs: opts.contextPack.map(dir => path.resolve(dir)) } : {}),
      provenance: { ...opts.provenance, source: prepared.source },
      ...(configuration ? { configuration } : {}),
      ...(Object.keys(compatibility).length ? { compatibility } : {}),
      ...(opts.allowDrift ? { allowDrift: true } : {}),
    }, { timeoutMs: 120_000 });
  } catch {
    throw new Error(`Bundle creation outcome is unknown; inputs remain at ${path.dirname(prepared.receiptPath)}${configurationStaging ? ` and ${configurationStaging}` : ""}. Check the daemon and archive before retrying; no install was requested.`);
  }
  // A returned response settles this request. A timeout above does not authorize deleting its input.
  rmSync(prepared.checkoutDir, { recursive: true, force: true });
  if (configurationStaging) rmSync(configurationStaging, { recursive: true, force: true });
  if (res.status < 400 && (!(res.data.packageDigest as { value?: unknown } | undefined)?.value
    || (res.data.source as BundleSource | undefined)?.resolvedCommit !== prepared.source.resolvedCommit)) {
    throw new Error(`The daemon did not return bundle source/digest evidence. Update the local daemon before importing links. The created archive is retained at ${bundlePath}; no install was requested.`);
  }
  writeFileSync(path.join(path.dirname(prepared.receiptPath), "build.json"), JSON.stringify({ ...res.data, bundlePath }, null, 2) + "\n");
  return { client, bundlePath, res };
}

export function printBundleLinkError(error: unknown, json?: boolean): void {
  const message = error instanceof Error ? error.message : "Bundle link preparation failed";
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(message);
  process.exitCode = 2;
}
