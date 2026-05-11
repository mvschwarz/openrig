// PluginVendorService — vendoring + auto-fetch for plugin trees.
//
// Per plugin-primitive Phase 3a slice 3.2 (IMPL-PRD §2.5 + DESIGN.md §5.5).
//
// Responsibilities:
//   1. ensureVendored(name): copy from packages/daemon/assets/plugins/<name>/
//      to ~/.openrig/plugins/<name>/ on first launch (similar to how
//      ~/.openrig/reference/ docs are copied today). Idempotent: hash-skip
//      when content already matches.
//   2. attemptAutoFetch(name): try to fetch latest from
//      github.com/mvschwarz/openrig-plugins. Tolerates 404, network errors,
//      and timeouts silently per orch direction 2026-05-10 (vendored is
//      always the fallback). Logs outcome for operator observability.
//   3. ensureLatest(name): orchestrates ensureVendored first, then
//      attemptAutoFetch. The vendored copy is ALWAYS available even if
//      the fetch fails for any reason.
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

  /**
   * Copy the vendored asset tree at <vendoredAssetsDir>/<pluginName>/ to the
   * user plugin dir <userPluginsDir>/<pluginName>/ on first launch.
   * Idempotent: hash-skip when source + dest content matches per file.
   * No-op when the vendored asset doesn't exist (e.g. plugin not bundled).
   */
  async ensureVendored(pluginName: string): Promise<void> {
    const sourceDir = nodePath.join(this.vendoredAssetsDir, pluginName);
    const targetDir = nodePath.join(this.userPluginsDir, pluginName);

    if (!this.fs.exists(sourceDir)) {
      this.logger(`[plugin-vendor] no vendored asset for "${pluginName}" at ${sourceDir}; skipping`);
      return;
    }

    this.fs.mkdirp(targetDir);

    const files = this.fs.listFiles(sourceDir);
    for (const relPath of files) {
      const srcPath = nodePath.join(sourceDir, relPath);
      const destPath = nodePath.join(targetDir, relPath);
      const content = this.fs.readFile(srcPath);
      // Hash-skip: only write if content differs (idempotent re-runs)
      if (this.fs.exists(destPath) && hashContent(this.fs.readFile(destPath)) === hashContent(content)) {
        continue;
      }
      this.fs.mkdirp(nodePath.dirname(destPath));
      this.fs.writeFile(destPath, content);
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
      // success path just logs.
      this.logger(`[plugin-vendor] fetch ${pluginName} succeeded (${response.status}); v0 vendored copy still authoritative`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger(`[plugin-vendor] fetch ${pluginName} failed: ${msg}; falling back to vendored`);
    }
  }

  /**
   * Orchestrate vendored-first then fetch-attempt.
   * The vendored copy lands FIRST so it's always the fallback even if
   * the fetch path fails for any reason.
   */
  async ensureLatest(pluginName: string): Promise<void> {
    await this.ensureVendored(pluginName);
    await this.attemptAutoFetch(pluginName);
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
