import { existsSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ExecFn } from "../adapters/tmux.js";
import type { LegacyRigSpec as RigSpec, PreflightResult, RigSpec as PodRigSpec, RigSpecPod, RigSpecPodMember } from "./types.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { deriveSessionName, validateSessionName, validateSessionComponents, VIRTUAL_DOMAIN_TOKENS } from "./session-name.js";

const RUNTIME_COMMANDS: Record<string, string> = {
  "claude-code": "claude --version",
  "codex": "codex --version",
  "pi": "pi --version",
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

    // M1 A1 — reserved rig names (the RIG-slot half of the reserved-token rail; the
    // host-slot half is RESERVED_HOST_IDS). Source = the A2 virtual-domain closed set
    // (VIRTUAL_DOMAIN_TOKENS, ONE source of truth): a rig named `external` would make
    // `<local>@external` ambiguous with the virtual-domain classifier (member=<local>
    // rig=external vs a virtual-domain ref). Refused at the daemon mint gate.
    if ((VIRTUAL_DOMAIN_TOKENS as readonly string[]).includes(spec.name)) {
      errors.push(`Rig name '${spec.name}' is reserved (virtual-domain token): it would collide with the '<local>@${spec.name}' classifier — pick a different name`);
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
import { getOpenRigInstallCwdError, resolveLaunchCwd } from "./cwd-resolution.js";
import nodePath from "node:path";
import { validateClaudeActivityHookDelivery, CLAUDE_ACTIVITY_HOOKS_RESOURCE_TYPE } from "./claude-activity-hooks.js";
import {
  resolvePermissionPolicyAttachment,
  resolvePermissionPolicyRefValue,
  type ResolvedPolicyAttachment,
} from "./permission-policy/policy-ref.js";

// Slice 51-01 (OPR.0.5.1.1): `stub` is a first-class runtime (the deterministic node-script fake harness
// through the real orchestrator) — admitted at the modern-pod preflight gate alongside the real runtimes.
const SUPPORTED_RUNTIMES = new Set(["claude-code", "codex", "pi", "terminal", "stub"]);

// Default daemon-shipped asset paths for the managed Claude activity hooks — the SAME files the
// ClaudeCodeAdapter is wired with in startup.ts (validation is the shared module either way).
// Overridable via PreflightSpecContext.claudeActivityAssets for fixture-injecting tests.
const DEFAULT_ACTIVITY_RELAY_PATH = nodePath.resolve(import.meta.dirname, "../../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
const DEFAULT_CLAUDE_HOOKS_MANIFEST_PATH = nodePath.resolve(import.meta.dirname, "../../assets/plugins/openrig-core/hooks/claude.json");

export interface RigPreflightInput {
  rigSpecYaml: string;
  rigRoot: string;
  cwdOverride?: string;
  fsOps: AgentResolverFsOps;
  /** Config-resolved managed skill catalog root. Must match runtime resolution. */
  skillsRoot?: string;
  rigNameOverride?: string;
  externalQualifiedIds?: Iterable<string>;
  claudeActivityAssets?: { relayPath?: string; manifestPath?: string };
  inheritedPermissionPolicy?: PreflightSpecContext["inheritedPermissionPolicy"];
}

/**
 * OPR.0.3.3.24: the non-YAML context the preflight CORE needs alongside an
 * already-parsed+validated spec. (YAML is only the input adapter at the front.)
 */
export interface PreflightSpecContext {
  rigRoot: string;
  cwdOverride?: string;
  fsOps: AgentResolverFsOps;
  /** Config-resolved managed skill catalog root. Must match runtime resolution. */
  skillsRoot?: string;
  rigNameOverride?: string;
  /** Effective persisted target-rig attachment for structured expansion.
   * Explicit member/fragment refs still win; this is the inherited fallback. */
  inheritedPermissionPolicy?: Pick<
    ResolvedPolicyAttachment,
    "ref" | "origin" | "resolvedTarget" | "declaringDir" | "launchPosture"
  >;
  /** OPR.0.3.4.7 — exec for async probes (Codex profile-LOAD). When omitted,
   *  the Codex profile probe is skipped (backwards-compatible for callers that
   *  cannot provide exec, e.g. legacy sync-only test paths). */
  exec?: (cmd: string) => Promise<string>;
  /** Managed Claude activity-hook delivery asset paths (relay + canonical manifest). Defaults to
   *  the daemon-shipped assets (same as the ClaudeCodeAdapter); tests inject fixtures. Validated
   *  via the SHARED delivery check so preflight + adapter cannot drift. */
  claudeActivityAssets?: { relayPath?: string; manifestPath?: string };
}

/**
 * Seam C: describe each seat's effective permission-policy attachment without
 * changing readiness or state. The existing Seam-B resolver remains the one
 * source of truth for member-over-rig precedence, origin, and launch posture.
 */
export function permissionPolicyDiscoveryWarnings(
  rigSpec: PodRigSpec,
  preflightCtx: Pick<PreflightSpecContext, "rigRoot" | "fsOps" | "inheritedPermissionPolicy">,
): string[] {
  const warnings: string[] = [];
  for (const pod of rigSpec.pods) {
    for (const member of pod.members) {
      const logicalId = `${pod.id}.${member.id}`;
      const ref = resolvePermissionPolicyRefValue(member.permissionPolicy, rigSpec.permissionPolicy);
      const attachment = ref
        ? resolvePermissionPolicyAttachment(ref, preflightCtx.rigRoot, {
          readFile: (path) => preflightCtx.fsOps.readFile(path),
        })
        : preflightCtx.inheritedPermissionPolicy;
      if (!attachment) {
        warnings.push(`${logicalId}: permission_policy absent; launch_posture=floor`);
        continue;
      }
      if (attachment.origin === "deliberate_none") {
        // RULED amendment (5f37e40f): the three-way distinction renders — a
        // RECORDED choice is not absence; the posture claim stays byte-equal
        // to the absent floor (P2), only the record wording differs.
        warnings.push(`${logicalId}: permission_policy: none (deliberate choice — recorded); launch_posture=floor`);
        continue;
      }
      warnings.push(`${logicalId}: permission_policy ref="${attachment.ref}" origin=${attachment.origin} launch_posture=${attachment.launchPosture}`);
    }
  }
  return warnings;
}

/**
 * Rebooted rig preflight: validates rig spec, resolves all agent refs + profiles,
 * checks runtimes and cwd. Pure domain, no side effects beyond filesystem reads.
 * Returns the existing PreflightResult shape (ready + warnings[] + errors[]).
 * @param input - rig spec YAML, rig root, and filesystem ops
 * @returns PreflightResult
 */
export async function rigPreflight(input: RigPreflightInput & { exec?: (cmd: string) => Promise<string> }): Promise<PreflightResult> {
  // FRONT-END (OPR.0.3.3.24): YAML is only the input adapter. Parse + validate +
  // normalize, then delegate every actual check to the structured core so
  // callers holding an already-parsed+validated spec (expand / add_member)
  // preflight it WITHOUT a YAML round-trip. Mirrors the materialize-core split.
  let rigSpec: PodRigSpec;
  try {
    const raw = RigSpecCodec.parse(input.rigSpecYaml);
    const validation = RigSpecSchema.validate(raw, { externalQualifiedIds: input.externalQualifiedIds });
    if (!validation.valid) {
      return { ready: false, errors: validation.errors, warnings: [] };
    }
    rigSpec = RigSpecSchema.normalize(raw as Record<string, unknown>);
  } catch (err) {
    return { ready: false, errors: [`Parse error: ${(err as Error).message}`], warnings: [] };
  }

  return preflightValidatedSpec(rigSpec, {
    rigRoot: input.rigRoot,
    cwdOverride: input.cwdOverride,
    fsOps: input.fsOps,
    skillsRoot: input.skillsRoot,
    rigNameOverride: input.rigNameOverride,
    inheritedPermissionPolicy: input.inheritedPermissionPolicy,
    exec: input.exec,
    claudeActivityAssets: input.claudeActivityAssets,
  });
}

/**
 * preflight CORE (OPR.0.3.3.24): every preflight check operates on the
 * normalized spec + non-YAML context (session-name components, agent_ref/profile
 * resolution, runtime, cwd). Extracted from rigPreflight with byte-identical
 * checks/order/error-strings so expand/add_member preflight a structured spec
 * with no YAML round-trip; rigPreflight(yaml) is the parse/normalize front over it.
 */
export async function preflightValidatedSpec(rigSpec: PodRigSpec, preflightCtx: PreflightSpecContext): Promise<PreflightResult> {
  const errors: string[] = [];
  // §6 reconciliation (PM ruling 2026-08-05): seed EMPTY so main's already-folded activity-hook /
  // collision warnings (pushed below during the checks) come FIRST; the incoming permission-policy
  // discovery warnings are APPENDED at the return. Rationale + semantic fence at the return site.
  const warnings: string[] = [];

  // 2. Validate session name components for all pod members
  const effectiveRigName = preflightCtx.rigNameOverride ?? rigSpec.name;
  for (const pod of rigSpec.pods) {
    for (const member of pod.members) {
      const nameErrors = validateSessionComponents(pod.id, member.id, effectiveRigName);
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
        const terminalCwd = resolveLaunchCwd(member.cwd, preflightCtx.rigRoot, preflightCtx.cwdOverride);
        const terminalCwdError = getOpenRigInstallCwdError(terminalCwd, preflightCtx.cwdOverride);
        if (terminalCwdError) {
          errors.push(`${pod.id}.${member.id}: ${terminalCwdError}`);
        }
        continue;
      }

      // Resolve agent_ref
      const resolveResult = resolveAgentRef(member.agentRef, preflightCtx.rigRoot, preflightCtx.fsOps);
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
        specRoot: preflightCtx.rigRoot,
        cwdOverride: preflightCtx.cwdOverride,
        skillsRoot: preflightCtx.skillsRoot,
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

      // Managed Claude activity-hook delivery preflight (NONFATAL): when a claude-code member
      // selects the claude_activity_hooks resource, verify the daemon can actually deliver
      // (relay asset present + canonical manifest yields >= 1 relay event) using the SHARED
      // validation the adapter uses. A delivery gap is a warning, never a gate — rig up
      // proceeds without activity tracking for that seat rather than failing.
      if (member.runtime === "claude-code") {
        const selectsActivityHooks = configResult.config.selectedResources.runtimeResources.some(
          (qr) => (qr.resource as { type?: string }).type === CLAUDE_ACTIVITY_HOOKS_RESOURCE_TYPE,
        );
        if (selectsActivityHooks) {
          const relayPath = preflightCtx.claudeActivityAssets?.relayPath ?? DEFAULT_ACTIVITY_RELAY_PATH;
          const manifestPath = preflightCtx.claudeActivityAssets?.manifestPath ?? DEFAULT_CLAUDE_HOOKS_MANIFEST_PATH;
          const delivery = validateClaudeActivityHookDelivery(preflightCtx.fsOps, relayPath, manifestPath);
          if (!delivery.deliverable) {
            const reason = !delivery.relaySourceOk
              ? "activity-relay asset missing"
              : "canonical claude.json hook manifest missing, unreadable, or has no relay events";
            warnings.push(`${pod.id}.${member.id}: managed Claude activity hooks cannot be delivered (${reason}); rig up continues without activity tracking for this seat`);
          }
        }
      }

      // Check runtime
      if (!SUPPORTED_RUNTIMES.has(member.runtime)) {
        errors.push(`${pod.id}.${member.id}: unsupported runtime "${member.runtime}"`);
      }

      // Check cwd (required, already validated by RigSpec schema, but double-check)
      if (!member.cwd) {
        errors.push(`${pod.id}.${member.id}: cwd is required`);
      }
      const cwdError = getOpenRigInstallCwdError(configResult.config.cwd, preflightCtx.cwdOverride);
      if (cwdError) {
        errors.push(`${pod.id}.${member.id}: ${cwdError}`);
      }
    }
  }

  // OPR.0.3.4.7 — Codex profile-LOAD probe, integrated into preflight.
  // Runs only when exec is provided and the sync checks passed.
  if (errors.length === 0 && preflightCtx.exec) {
    const profileErrors = await verifyCodexProfiles(rigSpec, preflightCtx.exec);
    errors.push(...profileErrors);
    // OPR.0.4.6.PI1 FR-1 — Pi binary probe: a spec with a pi member fails
    // preflight (what/why/fix) when the binary is absent, never a
    // launch-time surprise.
    const piErrors = await verifyPiRuntimeAvailable(rigSpec, preflightCtx.exec);
    errors.push(...piErrors);
  }

  // §6 RECONCILIATION — WARNING EMISSION ORDER (PM ruling 2026-08-05): ACTIVITY-HOOK-FIRST,
  // POLICY-APPENDED. Fold-order = emission-order — main is the restack's fixed base and its
  // already-folded managed-activity-hook warnings are the floor (emitted above during the checks);
  // the incoming restacked permission-policy discovery warnings APPEND after here, matching the
  // mechanical grain of the rebase + the gates-first discipline, and keeping the 0.5.0 train's
  // existing warning content byte-stable under the restack (the actual stability invariant — npm
  // compatibility is NOT implicated either way: what is live on npm is the POLICY chain cut from
  // 0.4.7, the activity-hook content is unshipped local 0.5.0 work, so neither ordering existed
  // anywhere before this merge; this pin freezes the merged order).
  // SEMANTIC FENCE: this order is PRESENTATION ONLY. Any consumer that treats the first warning as
  // higher-priority is a FINDING, not an ordering input — the pin freezes presentation, never semantics.
  warnings.push(...permissionPolicyDiscoveryWarnings(rigSpec, preflightCtx));
  return { ready: errors.length === 0, errors, warnings };
}

/**
 * OPR.0.4.6.PI1 FR-1 — async post-preflight probe: when the spec declares any
 * `runtime: "pi"` member, verify the `pi` binary answers `pi --version`.
 * Returns a single what/why/fix error naming the install surface on failure.
 */
export async function verifyPiRuntimeAvailable(
  rigSpec: PodRigSpec,
  exec: ExecFn,
): Promise<string[]> {
  const hasPiMember = (rigSpec.pods ?? []).some((pod: RigSpecPod) =>
    (pod.members ?? []).some((member: RigSpecPodMember) => member.runtime === "pi"),
  );
  if (!hasPiMember) return [];
  try {
    await exec(RUNTIME_COMMANDS["pi"]!);
    return [];
  } catch {
    return [
      `Runtime "pi" not available ('pi --version' failed). The spec declares a pi member, so the launch would fail. Fix: install the Pi coding agent (npm install -g @earendil-works/pi-coding-agent, or the pi.dev install script) and ensure 'pi' is on PATH.`,
    ];
  }
}

/**
 * OPR.0.3.4.7 — async post-preflight probe: verify Codex profile-v2 LOADS
 * for all Codex nodes with a non-empty codex_config_profile. Called AFTER
 * the synchronous preflight passes (codex --version already verified).
 * Returns errors to append to the preflight result; empty = all profiles load.
 */
export async function verifyCodexProfiles(
  rigSpec: PodRigSpec,
  exec: (cmd: string) => Promise<string>,
): Promise<string[]> {
  const { verifyCodexProfileLoads } = await import("./codex-profile-preflight.js");
  const errors: string[] = [];
  const checkedProfiles = new Set<string>();
  for (const pod of rigSpec.pods) {
    for (const member of pod.members) {
      if (member.runtime !== "codex") continue;
      const profile = member.codexConfigProfile?.trim();
      if (!profile) continue;
      if (checkedProfiles.has(profile)) continue;
      checkedProfiles.add(profile);
      const result = await verifyCodexProfileLoads(profile, exec);
      if (!result.ok) {
        errors.push(`${pod.id}.${member.id}: ${result.error}${result.migrationHint ? ` Fix: ${result.migrationHint}` : ""}`);
      }
    }
  }
  return errors;
}
