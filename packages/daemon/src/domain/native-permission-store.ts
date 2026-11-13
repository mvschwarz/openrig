import { readClaudePermissionRules, type ClaudePermissionRules } from "./claude-permission-rules.js";
import { parseStoredCodexMemberPermissions, type CodexMemberPermissions } from "./codex-member-permissions.js";
import type Database from "better-sqlite3";
import type { NodeBinding } from "./runtime-adapter.js";
import { permissionBindingOverride, type NativePermissionSelection } from "./native-permission-selection.js";
import { builtinLaunchPosture } from "./permission-policy/policy-ref.js";

export interface StoredNativePermissionSelection extends NativePermissionSelection {
  actor: string;
  reason: string;
  updatedAt: string;
}

export type PermissionModeSource = "explicit" | "member_spec" | "rig_spec" | "kernel_default" | "system_default";

export interface ResolvedSeatPermission {
  effectiveMode: string;
  source: PermissionModeSource;
  launchPosture?: "floor" | "full_bypass" | "auto";
  permissionMode?: string;
  fallbackReason?: string;
}

export type LaunchOverrideSelectionFact =
  | { state: "available"; value: { runtime: string; mode: string } | null | undefined }
  | { state: "unavailable"; error: unknown };

export interface LaunchDefaultMetadata {
  rigName: string;
  memberPolicy: string | null;
  rigPolicy: string | null;
  codexProfile: string | null;
}

export interface LaunchOverrideFacts {
  nodeId: string;
  runtime: string;
  selection: LaunchOverrideSelectionFact;
  logicalId?: string | null;
  codexPermissionsJson?: string | null;
  codexEnvelopeReadError?: unknown;
  codexPermissions?: CodexMemberPermissions;
  claudePermissions?: ClaudePermissionRules;
  launchDefaultMetadata?: LaunchDefaultMetadata | null;
  target?: { selection: NativePermissionSelection | null; codexProfile: string | null };
}

export function validatePersistedPermissionSelection(row: { runtime: string; mode: string }): NativePermissionSelection {
  if ((row.runtime !== "codex" && row.runtime !== "claude-code") || !/^[A-Za-z][A-Za-z0-9_]*$/.test(row.mode)
    || (row.runtime === "codex" && row.mode !== "floor" && row.mode !== "full_bypass")) {
    throw new Error("Invalid persisted native permission selection; launch refused.");
  }
  return { runtime: row.runtime, mode: row.mode };
}

function resolveLaunchDefaultFromMetadata(
  runtime: string,
  meta: LaunchDefaultMetadata | null | undefined,
  codexProfileOverride?: string | null,
): "kernel" | "team" | undefined {
  if (runtime !== "claude-code" && runtime !== "codex") return undefined;
  if (!meta || meta.memberPolicy != null || meta.rigPolicy != null
    || (runtime === "codex" && (codexProfileOverride === undefined ? meta.codexProfile : codexProfileOverride)?.trim())) {
    return undefined;
  }
  return meta.rigName === "kernel" ? "kernel" : "team";
}

/** Pure launch-permission decision over already-read facts, shared by NativePermissionStore.launchOverride and batched node inventory. */
export function resolveLaunchOverrideFromFacts(
  facts: LaunchOverrideFacts,
): Pick<NodeBinding, "launchPosture" | "permissionMode" | "kernelAuthority" | "teamPermissionDefault" | "claudePermissions" | "codexPermissions"> {
  const ruleBinding = facts.claudePermissions === undefined ? {} : { claudePermissions: facts.claudePermissions };
  let selection: NativePermissionSelection | null;
  if (facts.target) {
    selection = facts.target.selection;
  } else {
    if (facts.selection.state === "unavailable") {
      throw facts.selection.error;
    }
    selection = facts.selection.value ? validatePersistedPermissionSelection(facts.selection.value) : null;
  }
  // A runtime switch's explicit target mode is a new choice that replaces the envelope: its successor launches with
  // the mode, and its commit clears the envelope. So that launch doesn't read the envelope at all.
  let codexPermissions: CodexMemberPermissions | undefined;
  if (facts.runtime === "codex" && !(facts.target && selection)) {
    if (facts.codexEnvelopeReadError !== undefined) {
      throw new Error(`Seat ${facts.nodeId}: cannot read codex_permissions (${(facts.codexEnvelopeReadError as Error).message}). Repair it with rig seat set-permissions <seat> --codex-permissions <file> --reason <reason>, or choose a mode with --mode, before launching.`);
    }
    codexPermissions = facts.codexPermissions !== undefined
      ? facts.codexPermissions
      : parseStoredCodexMemberPermissions(facts.nodeId, facts.codexPermissionsJson, facts.logicalId);
  }
  if (selection && selection.runtime !== facts.runtime) {
    throw new Error("Seat runtime changed since permission selection; explicitly select again or inherit.");
  }
  // The envelope is this seat's explicit choice, like a mode: no kernel or team default, and the posture decision is
  // replaced by its flags. The setter keeps one of the two; both stored means another writer, so refuse this seat
  // rather than guess which one the person meant.
  if (codexPermissions !== undefined) {
    if (selection) throw new Error(`Seat ${facts.nodeId} records both a Codex permission envelope and the ${selection.mode} mode; launch refused. Choose one with rig seat set-permissions <seat> --codex-permissions <file> or --mode <mode> --reason <reason>.`);
    return { codexPermissions, kernelAuthority: false, teamPermissionDefault: false };
  }
  const launchDefault = selection
    ? undefined
    : resolveLaunchDefaultFromMetadata(facts.runtime, facts.launchDefaultMetadata, facts.target?.codexProfile);
  if (launchDefault === "kernel") {
    return { ...ruleBinding, kernelAuthority: true, teamPermissionDefault: false, launchPosture: facts.runtime === "codex" ? "full_bypass" : "floor" };
  }
  return { ...ruleBinding, kernelAuthority: false, teamPermissionDefault: launchDefault === "team", ...permissionBindingOverride(selection) };
}

/** The stable node owns the desired setting. Native history and current processes are untouched. */
export class NativePermissionStore {
  constructor(private readonly db: Database.Database) {}

  /** Kernel is the persisted class-of-one rig, never a pane-name or cwd heuristic.
   * Authored policies and named Codex profiles keep their existing meaning. */
  private readLaunchDefaultMetadata(nodeId: string, runtime: string): LaunchDefaultMetadata | undefined {
    if (runtime !== "claude-code" && runtime !== "codex") return undefined;
    try {
      const row = this.db.prepare(`SELECT r.name, n.permission_policy AS member_policy,
        r.permission_policy AS rig_policy, n.codex_config_profile AS profile
        FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?`).get(nodeId) as {
          name: string; member_policy: string | null; rig_policy: string | null; profile: string | null;
        } | undefined;
      if (!row) return undefined;
      return {
        rigName: row.name,
        memberPolicy: row.member_policy,
        rigPolicy: row.rig_policy,
        codexProfile: row.profile,
      };
    } catch {
      // This optional default must not block otherwise supported launches when
      // its metadata lookup is unavailable. Keep the existing permission path.
      return undefined;
    }
  }

  private launchDefault(nodeId: string, runtime: string, codexProfile?: string | null): "kernel" | "team" | undefined {
    return resolveLaunchDefaultFromMetadata(runtime, this.readLaunchDefaultMetadata(nodeId, runtime), codexProfile);
  }

  /** One decision shared by fresh/continue, legacy restore and same-seat handover. Slice 16's runtime switch passes
   *  `target`: the target runtime's explicit selection (or none, to inherit policy) and its Codex profile, since the
   *  stored ones belong to the runtime being left. A Codex envelope, like Claude rules, stays with the seat and applies
   *  whenever it runs Codex, until an explicit mode replaces it. */
  launchOverride(nodeId: string, runtime: string, target?: { selection: NativePermissionSelection | null; codexProfile: string | null }): Pick<NodeBinding, "launchPosture" | "permissionMode" | "kernelAuthority" | "teamPermissionDefault" | "claudePermissions" | "codexPermissions"> {
    const claudePermissions = runtime === "claude-code" ? readClaudePermissionRules(this.db, nodeId) : undefined;
    let selection: LaunchOverrideSelectionFact;
    if (target) {
      selection = { state: "available", value: target.selection };
    } else {
      try {
        const row = this.db.prepare("SELECT runtime, mode FROM node_permission_selections WHERE node_id = ?").get(nodeId) as {
          runtime: string; mode: string;
        } | undefined;
        selection = { state: "available", value: row ?? null };
      } catch (error) {
        selection = { state: "unavailable", error };
      }
    }
    let logicalId: string | null | undefined;
    let codexPermissionsJson: string | null | undefined;
    let codexEnvelopeReadError: unknown;
    if (runtime === "codex" && !(target && target.selection)) {
      try {
        const nodeRow = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as {
          logical_id?: string | null; codex_permissions_json?: string | null;
        } | undefined;
        logicalId = nodeRow?.logical_id;
        codexPermissionsJson = nodeRow?.codex_permissions_json;
      } catch (error) {
        codexEnvelopeReadError = error;
      }
    }
    return resolveLaunchOverrideFromFacts({
      nodeId,
      runtime,
      selection,
      logicalId,
      codexPermissionsJson,
      codexEnvelopeReadError,
      claudePermissions,
      launchDefaultMetadata: this.readLaunchDefaultMetadata(nodeId, runtime),
      target,
    });
  }

  read(nodeId: string): StoredNativePermissionSelection | null {
    const row = this.db.prepare("SELECT * FROM node_permission_selections WHERE node_id = ?").get(nodeId) as {
      runtime: string; mode: string; actor: string; reason: string; updated_at: string;
    } | undefined;
    if (!row) return null;
    const validated = validatePersistedPermissionSelection(row);
    return { ...validated, actor: row.actor, reason: row.reason, updatedAt: row.updated_at };
  }

  write(nodeId: string, selection: NativePermissionSelection | null, actor: string, reason: string): void {
    if (!selection) {
      this.db.prepare("DELETE FROM node_permission_selections WHERE node_id = ?").run(nodeId);
      return;
    }
    this.db.prepare(`INSERT INTO node_permission_selections (node_id, runtime, mode, actor, reason, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(node_id) DO UPDATE SET runtime=excluded.runtime, mode=excluded.mode,
        actor=excluded.actor, reason=excluded.reason, updated_at=excluded.updated_at`)
      .run(nodeId, selection.runtime, selection.mode, actor, reason);
  }

  resolve(nodeId: string, runtime: string): ResolvedSeatPermission {
    // Level 1: Explicit per-seat selection (records actor + reason, overrides member and rig)
    const explicit = this.read(nodeId);
    if (explicit) {
      if (explicit.runtime !== runtime) {
        throw new Error("Seat runtime changed since permission selection; explicitly select again or inherit.");
      }
      return {
        effectiveMode: explicit.mode,
        source: "explicit",
        ...(explicit.mode === "floor" || explicit.mode === "full_bypass"
          ? { launchPosture: explicit.mode }
          : {}),
        ...(explicit.mode !== "floor" && explicit.mode !== "full_bypass"
          ? { permissionMode: explicit.mode }
          : {}),
      };
    }

    // Query node for member-level policy, resolved posture, and rig_id
    let memberPolicy: string | null = null;
    let nodePosture: string | null = null;
    let rigId: string | null = null;
    let rigPolicy: string | null = null;
    let rigPosture: string | null = null;

    try {
      const nodeRow = this.db.prepare(
        "SELECT permission_policy, policy_launch_posture, rig_id FROM nodes WHERE id = ?"
      ).get(nodeId) as {
        permission_policy?: string | null;
        policy_launch_posture?: string | null;
        rig_id?: string | null;
      } | undefined;

      if (nodeRow) {
        memberPolicy = nodeRow.permission_policy ?? null;
        nodePosture = nodeRow.policy_launch_posture ?? null;
        rigId = nodeRow.rig_id ?? null;
      }

      if (rigId) {
        const rigRow = this.db.prepare(
          "SELECT permission_policy, rig_policy_launch_posture FROM rigs WHERE id = ?"
        ).get(rigId) as {
          permission_policy?: string | null;
          rig_policy_launch_posture?: string | null;
        } | undefined;

        if (rigRow) {
          rigPolicy = rigRow.permission_policy ?? null;
          rigPosture = rigRow.rig_policy_launch_posture ?? null;
        }
      }
    } catch {
      // Table or column might be missing in minimal/legacy test environments
    }

    // Level 2: Member-level declaration in rig.yaml
    // Precedence: member's own declaration must never be silently outranked by a rig-wide default.
    if (memberPolicy !== null) {
      const effectivePosture = nodePosture ?? builtinLaunchPosture(memberPolicy);

      if (effectivePosture === "auto") {
        if (runtime !== "claude-code") {
          const runtimeName = runtime === "codex" ? "Codex" : runtime === "pi" ? "Pi" : runtime;
          return {
            effectiveMode: "floor",
            source: "member_spec",
            launchPosture: "floor",
            fallbackReason: `${runtimeName} has no auto mode and launches at the floor`,
          };
        }
        return {
          effectiveMode: "auto",
          source: "member_spec",
          launchPosture: "auto",
          permissionMode: "auto",
        };
      }

      if (effectivePosture === "full_bypass") {
        return {
          effectiveMode: "full_bypass",
          source: "member_spec",
          launchPosture: "full_bypass",
        };
      }

      // effectivePosture === "floor" (e.g. builtin:locked, none, or custom floor policy)
      return {
        effectiveMode: runtime === "codex" ? "floor" : "acceptEdits",
        source: "member_spec",
        launchPosture: "floor",
      };
    }

    // Kernel's operational default also replaces persisted no-policy floor provenance.
    if (this.launchDefault(nodeId, runtime) === "kernel") {
      return { effectiveMode: runtime === "codex" ? "full_bypass" : "acceptEdits", source: "kernel_default",
        launchPosture: runtime === "codex" ? "full_bypass" : "floor" };
    }

    // Level 3: Rig-level declaration in rig.yaml
    // Applied when the member did not declare its own policy.
    const effectiveRigPosture = rigPosture ?? (
      rigPolicy !== null ? builtinLaunchPosture(rigPolicy)
      : (nodePosture && nodePosture !== "floor" ? nodePosture : null)
    );

    if (rigPolicy !== null || effectiveRigPosture !== null) {
      const posture = effectiveRigPosture ?? "floor";

      if (posture === "auto") {
        if (runtime !== "claude-code") {
          const runtimeName = runtime === "codex" ? "Codex" : runtime === "pi" ? "Pi" : runtime;
          return {
            effectiveMode: "floor",
            source: "rig_spec",
            launchPosture: "floor",
            fallbackReason: `${runtimeName} has no auto mode and launches at the floor`,
          };
        }
        return {
          effectiveMode: "auto",
          source: "rig_spec",
          launchPosture: "auto",
          permissionMode: "auto",
        };
      }

      if (posture === "full_bypass") {
        return {
          effectiveMode: "full_bypass",
          source: "rig_spec",
          launchPosture: "full_bypass",
        };
      }

      // posture === "floor" (e.g. builtin:locked, none)
      return {
        effectiveMode: runtime === "codex" ? "floor" : "acceptEdits",
        source: "rig_spec",
        launchPosture: "floor",
      };
    }

    // Level 4: System default floor
    return {
      effectiveMode: runtime === "codex" ? "floor" : "acceptEdits",
      source: "system_default",
      launchPosture: "floor",
    };
  }

  apply(binding: NodeBinding, runtime: string): NodeBinding {
    const override = this.launchOverride(binding.nodeId, runtime);
    const effectivePosture = override.launchPosture ?? binding.launchPosture;
    const permissionMode = override.permissionMode ?? (effectivePosture === "auto" && runtime === "claude-code" ? "auto" : undefined);
    return {
      ...binding,
      ...override,
      ...(override.kernelAuthority ? { permissionMode: undefined } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    };
  }
}
