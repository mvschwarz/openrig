import fs from "node:fs";
import nodePath from "node:path";
import { execFile } from "node:child_process";
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
  const pathValue = process.env.PATH;
  if (!pathValue) return false;
  for (const entry of pathValue.split(nodePath.delimiter)) {
    if (!entry) continue;
    try {
      fs.accessSync(nodePath.join(entry, command), fs.constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

async function loadClaudePermissionModes(): Promise<string[] | null> {
  return await new Promise((resolve) => {
    execFile("claude", ["--help"], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 1024 * 1024,
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
    const permissionModes = input.permissionModes ?? new ClaudePermissionModeCache();
    permissionModes.warm();
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
