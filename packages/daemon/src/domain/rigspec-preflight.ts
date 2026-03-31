import { existsSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ExecFn } from "../adapters/tmux.js";
import type { LegacyRigSpec as RigSpec, PreflightResult, RigSpec as PodRigSpec, RigSpecPod, RigSpecPodMember } from "./types.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { deriveSessionName, validateSessionName, validateSessionComponents } from "./session-name.js";

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

// TODO: AS-T12 — rename to LegacyRigSpecPreflight when routes are migrated
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

// -- Rebooted rig preflight (AgentSpec reboot) --

import { RigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema } from "./rigspec-schema.js";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { resolveNodeConfig, type ResolutionContext } from "./profile-resolver.js";

const SUPPORTED_RUNTIMES = new Set(["claude-code", "codex", "terminal"]);

export interface RigPreflightInput {
  rigSpecYaml: string;
  rigRoot: string;
  fsOps: AgentResolverFsOps;
}

/**
 * Rebooted rig preflight: validates rig spec, resolves all agent refs + profiles,
 * checks runtimes and cwd. Pure domain, no side effects beyond filesystem reads.
 * Returns the existing PreflightResult shape (ready + warnings[] + errors[]).
 * @param input - rig spec YAML, rig root, and filesystem ops
 * @returns PreflightResult
 */
export function rigPreflight(input: RigPreflightInput): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Parse + validate RigSpec
  let rigSpec: PodRigSpec;
  try {
    const raw = RigSpecCodec.parse(input.rigSpecYaml);
    const validation = RigSpecSchema.validate(raw);
    if (!validation.valid) {
      return { ready: false, errors: validation.errors, warnings };
    }
    rigSpec = RigSpecSchema.normalize(raw as Record<string, unknown>);
  } catch (err) {
    return { ready: false, errors: [`Parse error: ${(err as Error).message}`], warnings };
  }

  // 2. Validate session name components for all pod members
  for (const pod of rigSpec.pods) {
    for (const member of pod.members) {
      const nameErrors = validateSessionComponents(pod.id, member.id, rigSpec.name);
      for (const err of nameErrors) {
        errors.push(`${pod.id}.${member.id}: ${err}`);
      }
    }
  }

  // 3. For each pod member: resolve agent_ref + profile, check runtime, check cwd
  for (const pod of rigSpec.pods) {
    for (const member of pod.members) {
      // Terminal members: skip agent resolution and profile resolution
      if (member.agentRef === "builtin:terminal") {
        // Only validate runtime and cwd for terminal members
        if (!SUPPORTED_RUNTIMES.has(member.runtime)) {
          errors.push(`${pod.id}.${member.id}: unsupported runtime "${member.runtime}"`);
        }
        if (!member.cwd) {
          errors.push(`${pod.id}.${member.id}: cwd is required`);
        }
        continue;
      }

      // Resolve agent_ref
      const resolveResult = resolveAgentRef(member.agentRef, input.rigRoot, input.fsOps);
      if (!resolveResult.ok) {
        const msg = resolveResult.code === "validation_failed"
          ? (resolveResult as { errors: string[] }).errors.join("; ")
          : (resolveResult as { error: string }).error;
        errors.push(`${pod.id}.${member.id}: agent_ref resolution failed: ${msg}`);
        continue;
      }

      // Import collisions as warnings (non-fatal)
      for (const col of resolveResult.collisions) {
        if (col.sources.length >= 2) {
          const hasBase = col.sources.some((s) => s.qualifiedId === col.resourceId);
          if (hasBase) {
            warnings.push(`${pod.id}.${member.id}: base/import collision in ${col.category} on "${col.resourceId}"`);
          }
          // import/import collisions will be caught by profile resolver below
        }
      }

      // Resolve profile via resolveNodeConfig
      const ctx: ResolutionContext = {
        baseSpec: resolveResult.resolved,
        importedSpecs: resolveResult.imports,
        collisions: resolveResult.collisions,
        profileName: member.profile,
        member,
        pod,
        rig: rigSpec,
      };
      const configResult = resolveNodeConfig(ctx);
      if (!configResult.ok) {
        for (const err of configResult.errors) {
          errors.push(`${pod.id}.${member.id}: ${err}`);
        }
        continue;
      }

      // Check runtime
      if (!SUPPORTED_RUNTIMES.has(member.runtime)) {
        errors.push(`${pod.id}.${member.id}: unsupported runtime "${member.runtime}"`);
      }

      // Check cwd (required, already validated by RigSpec schema, but double-check)
      if (!member.cwd) {
        errors.push(`${pod.id}.${member.id}: cwd is required`);
      }
    }
  }

  return { ready: errors.length === 0, errors, warnings };
}
