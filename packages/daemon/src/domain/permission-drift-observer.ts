import fs from "node:fs";
import nodePath from "node:path";
import { spawnSync } from "node:child_process";
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

function productionFs(): PermissionDriftFs {
  return {
    readFile: (path) => fs.readFileSync(path, "utf8"),
    cwdReadable: (path) => {
      fs.accessSync(path, fs.constants.R_OK);
      return true;
    },
    commandAvailable,
    claudePermissionModes: () => {
      const result = spawnSync("claude", ["--help"], {
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
      });
      if (result.status !== 0 || result.error) return null;
      return parseClaudePermissionModes(result.stdout);
    },
  };
}

/** Strict, read-only, generation-aware observer for an explicitly requested seat. */
export class PermissionDriftObserver implements PermissionDriftReader {
  private readonly observations: AppliedLaunchObservationStore;
  private readonly fs: PermissionDriftFs;
  private readonly now?: () => Date;

  constructor(
    private readonly input: { db: Database.Database; fs?: PermissionDriftFs; now?: () => Date },
  ) {
    this.observations = new AppliedLaunchObservationStore(input.db);
    this.fs = input.fs ?? productionFs();
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
