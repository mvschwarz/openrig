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

import fs from "node:fs";
import nodePath from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface PluginVendorFs {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  /** A file's raw bytes. With `writeBytes`, a plugin's files are copied and compared byte for byte, so a binary file
   *  (an icon) arrives intact. Optional: without them files are read and written as text. */
  readBytes?(path: string): Uint8Array;
  writeBytes?(path: string, content: Uint8Array): void;
  /** Copy raw bytes, failing if the recovery path already exists. */
  copyFileExclusive(source: string, target: string): void;
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
            hashContent(this.read(destPath)) === hashContent(this.read(srcPath))
          ) {
            this.preserveMode(srcPath, destPath);
          }
        }
        this.logger(`[plugin-vendor] bundled '${pluginName}' ${sourceVersion} equals installed ${targetVersion}; leaving installed bytes unchanged`);
        return;
      }
    }

    const updates: Array<[string, FileContent]> = this.fs.listFiles(sourceDir).map(rel => [rel, this.read(nodePath.join(sourceDir, rel))]);
    if (!this.preserveBeforeRefresh(targetDir, updates)) return;
    this.fs.mkdirp(targetDir);

    for (const [relPath, content] of updates) {
      const srcPath = nodePath.join(sourceDir, relPath);
      const destPath = nodePath.join(targetDir, relPath);
      // Hash-skip: only write if content differs (idempotent re-runs). Reconcile mode even on
      // skip — a byte-identical copy staged earlier may still carry the wrong (default) mode.
      if (this.fs.exists(destPath) && hashContent(this.read(destPath)) === hashContent(content)) {
        this.preserveMode(srcPath, destPath);
        continue;
      }
      this.fs.mkdirp(nodePath.dirname(destPath));
      this.write(destPath, content);
      this.preserveMode(srcPath, destPath);
    }
  }

  /** A plugin file as the fs reads it exactly: bytes when it can, else text. */
  private read(path: string): FileContent {
    return this.fs.readBytes ? this.fs.readBytes(path) : this.fs.readFile(path);
  }

  private write(path: string, content: FileContent): void {
    if (typeof content === "string") this.fs.writeFile(path, content);
    else if (this.fs.writeBytes) this.fs.writeBytes(path, content);
    else this.fs.writeFile(path, Buffer.from(content).toString("utf-8"));
  }

  /** Preserve every replaced file before touching a target, including its version authority. */
  private preserveBeforeRefresh(targetDir: string, updates: Array<[string, FileContent]>): boolean {
    const backupDir = nodePath.join(nodePath.dirname(this.userPluginsDir), "backups", "managed-refresh", randomUUID());
    try {
      for (const [rel, content] of new Map(updates)) {
        const dest = nodePath.join(targetDir, rel);
        if (!this.fs.exists(dest) || hashContent(this.read(dest)) === hashContent(content)) continue;
        const backup = nodePath.join(backupDir, rel);
        this.fs.mkdirp(nodePath.dirname(backup));
        this.fs.copyFileExclusive(dest, backup);
        this.logger(`[plugin-vendor] preserved previous contents of ${dest} at ${backup} before managed refresh`);
      }
      return true;
    } catch (error) {
      this.logger(`[plugin-vendor] preservation failed for ${targetDir}: ${(error as Error).message}; refresh skipped, existing files kept`);
      return false;
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
    this.ensureSkillDirGlobally(sourceDir, skillName, sourceVersion, globalSkillRoots);
  }

  /**
   * Project one skill folder into the harness-global skill roots under `sourceVersion`
   * authority. A target without OpenRig's version marker was installed another way (for
   * example by skills.sh) and is left unchanged, as is one marked equal or newer.
   */
  ensureSkillDirGlobally(
    sourceDir: string,
    skillName: string,
    sourceVersion: string,
    globalSkillRoots: string[],
  ): void {
    if (!this.fs.exists(sourceDir)) {
      throw new Error(`Required global seed '${skillName}' is missing at ${sourceDir}`);
    }
    parseNumericVersion(sourceVersion, `${skillName} source`);
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
      const updates: Array<[string, FileContent]> = files.map(rel => [rel, this.read(nodePath.join(sourceDir, rel))]);
      if (!this.preserveBeforeRefresh(targetDir, [...updates, [GLOBAL_VENDOR_VERSION, `${sourceVersion}\n`]])) continue;
      this.fs.mkdirp(targetDir);
      for (const [relPath, content] of updates) {
        const srcPath = nodePath.join(sourceDir, relPath);
        const destPath = nodePath.join(targetDir, relPath);
        if (
          this.fs.exists(destPath) &&
          hashContent(this.read(destPath)) === hashContent(content)
        ) {
          this.preserveMode(srcPath, destPath);
          continue;
        }
        this.fs.mkdirp(nodePath.dirname(destPath));
        this.write(destPath, content);
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

/** A plugin file's content: its bytes, or its text from an fs that only reads text. */
type FileContent = string | Uint8Array;

/** The same digest for a text and for its UTF-8 bytes, so a text compare and a byte compare agree. */
function hashContent(content: FileContent): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The daemon's own filesystem for vendoring: files are copied and compared as bytes. */
export function nodePluginVendorFs(): PluginVendorFs {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c, "utf-8"),
    readBytes: (p) => fs.readFileSync(p),
    writeBytes: (p, c) => fs.writeFileSync(p, c),
    copyFileExclusive: (src, dest) => fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => { fs.mkdirSync(p, { recursive: true }); },
    listFiles: (dir) => {
      const r: string[] = [];
      /** Collect relative file paths recursively. */
      const w = (d: string, pre: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name));
          else r.push(pre ? nodePath.join(pre, e.name) : e.name);
        }
      };
      w(dir, "");
      return r;
    },
    statMode: (p) => fs.statSync(p).mode,
    chmod: (p, m) => fs.chmodSync(p, m),
  };
}
