import { existsSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ExecFn } from "../adapters/tmux.js";
import type { LegacyRigSpec as RigSpec, PreflightResult } from "./types.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { deriveSessionName, validateSessionName } from "./session-name.js";

const RUNTIME_COMMANDS: Record<string, string> = {
  "claude-code": "claude --version",
  "codex": "codex --version",
};

interface RigSpecPreflightDeps {
  rigRepo: RigRepository;
  tmuxAdapter: TmuxAdapter;
  exec: ExecFn;
  cmuxExec: ExecFn;
}

export class RigSpecPreflight {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private tmuxAdapter: TmuxAdapter;
  private exec: ExecFn;
  private cmuxExec: ExecFn;

  constructor(deps: RigSpecPreflightDeps) {
    this.db = deps.rigRepo.db;
    this.rigRepo = deps.rigRepo;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.exec = deps.exec;
    this.cmuxExec = deps.cmuxExec;
  }

  async check(spec: RigSpec): Promise<PreflightResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Derived session-name validity
    for (const node of spec.nodes) {
      const sessionName = deriveSessionName(spec.name, node.id);
      if (!validateSessionName(sessionName)) {
        errors.push(`Derived session name '${sessionName}' is invalid for node '${node.id}'`);
      }
    }

    // Rig name collision
    const existingRigs = this.rigRepo.listRigs();
    if (existingRigs.some((r) => r.name === spec.name)) {
      errors.push(`Rig name '${spec.name}' already exists`);
    }

    // tmux session name collision
    for (const node of spec.nodes) {
      const sessionName = deriveSessionName(spec.name, node.id);
      if (validateSessionName(sessionName)) {
        const exists = await this.tmuxAdapter.hasSession(sessionName);
        if (exists) {
          errors.push(`tmux session '${sessionName}' already exists for node '${node.id}'`);
        }
      }
    }

    // cwd existence
    for (const node of spec.nodes) {
      if (node.cwd) {
        if (!existsSync(node.cwd)) {
          errors.push(`cwd '${node.cwd}' does not exist for node '${node.id}'`);
        } else {
          try {
            if (!statSync(node.cwd).isDirectory()) {
              errors.push(`cwd '${node.cwd}' is not a directory for node '${node.id}'`);
            }
          } catch {
            errors.push(`cwd '${node.cwd}' is not accessible for node '${node.id}'`);
          }
        }
      }
    }

    // Runtime availability
    const checkedRuntimes = new Set<string>();
    for (const node of spec.nodes) {
      if (checkedRuntimes.has(node.runtime)) continue;
      checkedRuntimes.add(node.runtime);

      const cmd = RUNTIME_COMMANDS[node.runtime];
      if (cmd) {
        try {
          await this.exec(cmd);
        } catch {
          errors.push(`Runtime '${node.runtime}' not available (${cmd} failed)`);
        }
      }
    }

    // cmux layout hints: warning if cmux unavailable and spec uses hints
    const hasLayoutHints = spec.nodes.some((n) => n.surfaceHint || n.workspace);
    if (hasLayoutHints) {
      try {
        await this.cmuxExec("cmux capabilities --json");
      } catch {
        warnings.push("cmux is not available; layout hints (surfaceHint/workspace) cannot be applied");
      }
    }

    return {
      ready: errors.length === 0,
      warnings,
      errors,
    };
  }
}
