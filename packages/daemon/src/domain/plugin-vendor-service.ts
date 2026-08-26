// PluginVendorService — vendoring + auto-fetch for plugin trees.
//
// Per plugin-primitive Phase 3a slice 3.2 (IMPL-PRD §2.5 + DESIGN.md §5.5).
//
// Responsibilities:
//   1. ensureVendored(name): seed packages/daemon/assets/plugins/<name>/ into
//      ~/.openrig/plugins/<name>/ when absent, or advance an older manifest
//      version. Equal/newer installed bytes retain authority.
//   2. attemptAutoFetch(name): try to fetch latest from
//      github.com/mvschwarz/openrig-plugins. Tolerates 404, network errors,
//      and timeouts silently per orch direction 2026-05-10 (vendored is
//      always the fallback). Logs outcome for operator observability.
//   3. ensureLatest(name): resolves local vendored/installed authority first,
//      then attempts auto-fetch. A local copy remains if fetch fails.
//
// Design notes:
//   - All fs ops + httpClient are injectable (testable without real
//     filesystem or network).
//   - 5s network timeout per IMPL-PRD §2.5.
//   - The repo at github.com/mvschwarz/openrig-plugins is currently empty
//     per founder authorization 2026-05-10 (LICENSE only); 404 is the
//     expected normal-state response until a separate publish authorization.

import nodePath from "node:path";
import { createHash } from "node:crypto";

export interface PluginVendorFs {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles(dir: string): string[];
  rmrf?(path: string): void;
  /** Source file permission bits (for mode-preserving vendor staging). Optional: no-op if absent. */
  statMode?(path: string): number;
  /** Apply permission bits to a file (for mode-preserving vendor staging). Optional: no-op if absent. */
  chmod?(path: string, mode: number): void;
}

export interface HttpClientResponse {
  ok: boolean;
  status: number;
  /** Body parsed by caller — not exercised in v0 since fetch failures are
   *  the expected normal-state. Future tarball-extraction would consume this. */
  body?: unknown;
}

export type HttpClient = (url: string, opts?: { timeoutMs?: number }) => Promise<HttpClientResponse>;

export interface PluginVendorServiceDeps {
  vendoredAssetsDir: string;
  userPluginsDir: string;
  fs: PluginVendorFs;
  httpClient: HttpClient;
  logger?: (...args: unknown[]) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;
const REPO_BASE = "https://github.com/mvschwarz/openrig-plugins";
const PLUGIN_MANIFESTS = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"] as const;
const GLOBAL_VENDOR_VERSION = ".openrig-vendor-version";

function parseNumericVersion(raw: string, source: string): number[] {
  const value = raw.trim();
  if (!/^\d+(?:\.\d+){2}$/.test(value)) {
    throw new Error(`[plugin-vendor] invalid version '${value}' at ${source}; expected numeric x.y.z authority`);
  }
  return value.split(".").map(Number);
}

function compareVersions(a: string, b: string): number {
  const left = parseNumericVersion(a, "source version");
  const right = parseNumericVersion(b, "target version");
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}

export class PluginVendorService {
  private vendoredAssetsDir: string;
  private userPluginsDir: string;
  private fs: PluginVendorFs;
  private httpClient: HttpClient;
  private logger: (...args: unknown[]) => void;

  constructor(deps: PluginVendorServiceDeps) {
    this.vendoredAssetsDir = deps.vendoredAssetsDir;
    this.userPluginsDir = deps.userPluginsDir;
    this.fs = deps.fs;
    this.httpClient = deps.httpClient;
    this.logger = deps.logger ?? (() => {});
  }

  /** One plugin version across both harness manifests. Divergence is an
   * authority error: choosing either copy would make the other runtime lie. */
  private pluginVersion(pluginDir: string): string {
    const versions = PLUGIN_MANIFESTS
      .map((rel) => nodePath.join(pluginDir, rel))
      .filter((path) => this.fs.exists(path))
      .map((path) => {
        let parsed: { version?: unknown };
        try {
          parsed = JSON.parse(this.fs.readFile(path)) as { version?: unknown };
        } catch {
          throw new Error(`[plugin-vendor] invalid plugin manifest at ${path}`);
        }
        if (typeof parsed.version !== "string") {
          throw new Error(`[plugin-vendor] plugin manifest at ${path} has no string version`);
        }
        parseNumericVersion(parsed.version, path);
        return parsed.version;
      });
    if (versions.length === 0) {
      throw new Error(`[plugin-vendor] no plugin manifest found under ${pluginDir}`);
    }
    if (versions.some((version) => version !== versions[0])) {
      throw new Error(`[plugin-vendor] plugin manifests disagree under ${pluginDir}: ${versions.join(", ")}`);
    }
    return versions[0]!;
  }

  /**
   * Seed the vendored asset tree at <vendoredAssetsDir>/<pluginName>/ into the
   * user plugin dir <userPluginsDir>/<pluginName> when absent, or advance it
   * only when the bundled manifest version is strictly newer. Equal versions
   * reconcile mode only on byte-identical files.
   * No-op when the vendored asset doesn't exist (e.g. plugin not bundled).
   */
  async ensureVendored(pluginName: string): Promise<void> {
    const sourceDir = nodePath.join(this.vendoredAssetsDir, pluginName);
    const targetDir = nodePath.join(this.userPluginsDir, pluginName);

    if (!this.fs.exists(sourceDir)) {
      this.logger(`[plugin-vendor] no vendored asset for "${pluginName}" at ${sourceDir}; skipping`);
      return;
    }

    const sourceVersion = this.pluginVersion(sourceDir);
    if (this.fs.exists(targetDir)) {
      const hasTargetManifest = PLUGIN_MANIFESTS.some((rel) => this.fs.exists(nodePath.join(targetDir, rel)));
      if (!hasTargetManifest) {
        this.logger(`[plugin-vendor] existing plugin '${pluginName}' has no version authority at ${targetDir}; leaving it unchanged`);
        return;
      }
      const targetVersion = this.pluginVersion(targetDir);
      const order = compareVersions(sourceVersion, targetVersion);
      if (order < 0) {
        this.logger(`[plugin-vendor] bundled '${pluginName}' ${sourceVersion} is not newer than installed ${targetVersion}; leaving installed bytes unchanged`);
        return;
      }
      if (order === 0) {
        // Equal versions make the installed bytes authoritative. Still repair
        // mode on byte-identical paths: this is metadata reconciliation, not a
        // rollback, and preserves the established executable-helper repair.
        for (const relPath of this.fs.listFiles(sourceDir)) {
          const srcPath = nodePath.join(sourceDir, relPath);
          const destPath = nodePath.join(targetDir, relPath);
          if (
            this.fs.exists(destPath) &&
            hashContent(this.fs.readFile(destPath)) === hashContent(this.fs.readFile(srcPath))
          ) {
            this.preserveMode(srcPath, destPath);
          }
        }
        this.logger(`[plugin-vendor] bundled '${pluginName}' ${sourceVersion} equals installed ${targetVersion}; leaving installed bytes unchanged`);
        return;
      }
    }

    this.fs.mkdirp(targetDir);

    const files = this.fs.listFiles(sourceDir);
    for (const relPath of files) {
      const srcPath = nodePath.join(sourceDir, relPath);
      const destPath = nodePath.join(targetDir, relPath);
      const content = this.fs.readFile(srcPath);
      // Hash-skip: only write if content differs (idempotent re-runs). Reconcile mode even on
      // skip — a byte-identical copy staged earlier may still carry the wrong (default) mode.
      if (this.fs.exists(destPath) && hashContent(this.fs.readFile(destPath)) === hashContent(content)) {
        this.preserveMode(srcPath, destPath);
        continue;
      }
      this.fs.mkdirp(nodePath.dirname(destPath));
      this.fs.writeFile(destPath, content);
      this.preserveMode(srcPath, destPath);
    }
  }

  /**
   * Reapply the source file's permission bits to the staged/projected dest. Plain
   * readFile+writeFile (writeFileSync) creates the dest with the process default mode,
   * dropping executable bits on nested plugin helpers (e.g. claude-compaction-restore/
   * scripts/*.mjs, 0755). This vendor-staging hop (assets -> ~/.openrig/plugins) runs
   * UPSTREAM of the adapter CWD projection, so an unfixed mode here strands 0644 in the
   * staged copy that the adapters then faithfully preserve. No-op when the fs adapter does
   * not expose mode primitives (keeps existing mock-fs callers unaffected).
   */
  private preserveMode(src: string, dest: string): void {
    if (!this.fs.statMode || !this.fs.chmod) return;
    const srcMode = this.fs.statMode(src) & 0o777;
    if ((this.fs.statMode(dest) & 0o777) !== srcMode) this.fs.chmod(dest, srcMode);
  }

  /** Project one plugin skill into the harness-global skill roots. */
  ensureSkillGlobally(
    pluginName: string,
    skillName: string,
    globalSkillRoots: string[],
  ): void {
    const sourceDir = nodePath.join(
      this.userPluginsDir,
      pluginName,
      "skills",
      skillName,
    );
    if (!this.fs.exists(sourceDir)) {
      throw new Error(
        `Required global seed '${skillName}' is missing from plugin '${pluginName}'`,
      );
    }

    const sourceVersion = this.pluginVersion(nodePath.join(this.userPluginsDir, pluginName));
    const files = this.fs.listFiles(sourceDir);
    for (const root of globalSkillRoots) {
      const targetDir = nodePath.join(root, skillName);
      const versionMarker = nodePath.join(targetDir, GLOBAL_VENDOR_VERSION);
      if (this.fs.exists(targetDir)) {
        if (!this.fs.exists(versionMarker)) {
          this.logger(`[plugin-vendor] global skill '${skillName}' at ${targetDir} is unversioned/external authority; leaving it unchanged`);
          continue;
        }
        const targetVersion = this.fs.readFile(versionMarker).trim();
        parseNumericVersion(targetVersion, versionMarker);
        if (compareVersions(sourceVersion, targetVersion) <= 0) {
          this.logger(`[plugin-vendor] global skill '${skillName}' ${targetVersion} is equal/newer than bundled ${sourceVersion}; leaving it unchanged`);
          continue;
        }
      }
      this.fs.mkdirp(targetDir);
      for (const relPath of files) {
        const srcPath = nodePath.join(sourceDir, relPath);
        const destPath = nodePath.join(targetDir, relPath);
        const content = this.fs.readFile(srcPath);
        if (
          this.fs.exists(destPath) &&
          hashContent(this.fs.readFile(destPath)) === hashContent(content)
        ) {
          this.preserveMode(srcPath, destPath);
          continue;
        }
        this.fs.mkdirp(nodePath.dirname(destPath));
        this.fs.writeFile(destPath, content);
        this.preserveMode(srcPath, destPath);
      }
      this.fs.writeFile(versionMarker, `${sourceVersion}\n`);
    }
  }

  /**
   * Attempt to fetch the latest plugin tree from
   * github.com/mvschwarz/openrig-plugins. Tolerates 404, network errors,
   * and timeouts silently — vendored copy is ALWAYS the fallback.
   * Logs outcome for operator observability.
   */
  async attemptAutoFetch(pluginName: string): Promise<void> {
    const url = `${REPO_BASE}/releases/latest/download/${pluginName}.tar.gz`;
    try {
      const response = await this.httpClient(url, { timeoutMs: DEFAULT_TIMEOUT_MS });
      if (!response.ok) {
        if (response.status === 404) {
          this.logger(`[plugin-vendor] fetch ${pluginName} returned 404 (repo empty or release not published yet); falling back to vendored`);
        } else {
          this.logger(`[plugin-vendor] fetch ${pluginName} returned status ${response.status}; falling back to vendored`);
        }
        return;
      }
      // v0: tarball extraction NOT implemented — when slice 3.6 lands marketplace-
      // consumption, this is where fetch-then-extract logic lives. For now,
      // success path just logs. EXPLICIT MODE DECISION: v0 writes no files here, so there is
      // no mode to preserve; the future extract path MUST route its writes through
      // preserveMode() (or a tar extractor that preserves mode) so fetched executable helpers
      // keep 0755 — same invariant as ensureVendored/ensureSkillGlobally.
      this.logger(`[plugin-vendor] fetch ${pluginName} succeeded (${response.status}); v0 vendored copy still authoritative`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger(`[plugin-vendor] fetch ${pluginName} failed: ${msg}; falling back to vendored`);
    }
  }

  /**
   * Orchestrate vendored-first then fetch-attempt.
   * Local vendored/installed authority resolves first so a usable local copy
   * remains even if the fetch path fails for any reason.
   */
  async ensureLatest(pluginName: string): Promise<void> {
    await this.ensureVendored(pluginName);
    await this.attemptAutoFetch(pluginName);
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
