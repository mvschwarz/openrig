import fs from "node:fs";
import nodePath from "node:path";
import { execFile } from "node:child_process";
import { readPlatformEnv } from "./platform-env.js";
import { resolveClaudeExecutable, runClaudeCommand } from "./provider/claude-auth-status-reader.js";
import type Database from "better-sqlite3";
import { AppliedLaunchObservationStore } from "./applied-launch-observation-store.js";
import {
  diagnoseRuntimePosture,
  parseClaudePermissionModes,
  type PermissionDriftDiagnostic,
  type PermissionDriftFs,
} from "./permission-drift.js";

export interface PermissionDriftReader {
  diagnose(nodeId: string): PermissionDriftDiagnostic | null;
}

function commandAvailable(command: string): boolean {
  const pathValue = readPlatformEnv(process.env, "PATH");
  if (pathValue === undefined) return false;
  const names = process.platform === "win32"
    ? (readPlatformEnv(process.env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(ext => command + ext.toLowerCase())
    : [command];
  for (const entry of pathValue.split(nodePath.delimiter)) {
    if (!entry && process.platform !== "win32") continue;
    for (const name of names) {
      try {
        const candidate = nodePath.join(entry.replace(/^"(.*)"$/, "$1"), name);
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return true;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return false;
}

export async function loadClaudePermissionModes(env: NodeJS.ProcessEnv = process.env): Promise<string[] | null> {
  if (process.platform === "win32") {
    const file = resolveClaudeExecutable(env);
    if (!file) return null;
    const result = await runClaudeCommand(file, env, undefined, 1_000, 1_000, ["--help"]);
    return result.code === 0 && !result.error && !result.timedOut ? parseClaudePermissionModes(result.stdout) : null;
  }
  return await new Promise((resolve) => {
    execFile("claude", ["--help"], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 1024 * 1024,
      env,
    }, (error, stdout) => resolve(error ? null : parseClaudePermissionModes(stdout)));
  });
}

/** Warmed outside request handling; cold reads are immediate UNKNOWN. */
export class ClaudePermissionModeCache {
  private value: string[] | null = null;
  private loading = false;
  private loadedAt = 0;

  constructor(
    private readonly load: () => Promise<string[] | null> = loadClaudePermissionModes,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  warm(): void {
    if (this.loading || (this.loadedAt > 0 && this.now() - this.loadedAt < this.ttlMs)) return;
    this.loading = true;
    void this.load()
      .then((value) => { this.value = value; })
      .catch(() => { this.value = null; })
      .finally(() => {
        this.loadedAt = this.now();
        this.loading = false;
      });
  }

  read(): string[] | null {
    this.warm();
    return this.value;
  }
}

type AccessSync = (path: string, mode?: number) => void;

function productionFs(permissionModes: ClaudePermissionModeCache, accessSync: AccessSync): PermissionDriftFs {
  return {
    readFile: (path) => fs.readFileSync(path, "utf8"),
    cwdReadable: (path) => {
      try {
        accessSync(path, fs.constants.R_OK);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EACCES" || code === "EPERM") return false;
        throw error;
      }
    },
    commandAvailable,
    claudePermissionModes: () => permissionModes.read(),
  };
}

/** Strict, read-only, generation-aware observer for an explicitly requested seat. */
export class PermissionDriftObserver implements PermissionDriftReader {
  private readonly observations: AppliedLaunchObservationStore;
  private readonly fs: PermissionDriftFs;
  private readonly now?: () => Date;

  constructor(
    private readonly input: {
      db: Database.Database;
      fs?: PermissionDriftFs;
      now?: () => Date;
      permissionModes?: ClaudePermissionModeCache;
      accessSync?: AccessSync;
    },
  ) {
    this.observations = new AppliedLaunchObservationStore(input.db);
    // Hermeticity (hotfix FIX 2): construction no
    // longer eagerly warms the mode cache — `read()` self-warms (see the cache),
    // so the eager call added nothing but an execFile("claude","--help") from
    // every constructed-but-unconsulted observer (the daemon test suite built
    // ~72 such apps per run). The production daemon keeps its boot-time warm:
    // startup.ts constructs the observer with an explicitly warmed cache.
    const permissionModes = input.permissionModes ?? new ClaudePermissionModeCache();
    this.fs = input.fs ?? productionFs(permissionModes, input.accessSync ?? ((path, mode) => fs.accessSync(path, mode)));
    this.now = input.now;
  }

  diagnose(nodeId: string): PermissionDriftDiagnostic | null {
    const node = this.input.db.prepare("SELECT runtime, cwd FROM nodes WHERE id = ?").get(nodeId) as {
      runtime: string | null;
      cwd: string | null;
    } | undefined;
    if (!node) return null;
    return diagnoseRuntimePosture({
      runtime: node.runtime ?? "unknown",
      cwd: node.cwd,
      applied: this.observations.readCurrent(nodeId),
      fs: this.fs,
      now: this.now,
    });
  }
}
