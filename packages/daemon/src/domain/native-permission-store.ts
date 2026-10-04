import type Database from "better-sqlite3";
import type { NodeBinding } from "./runtime-adapter.js";
import { permissionBindingOverride, type NativePermissionSelection } from "./native-permission-selection.js";
import { builtinLaunchPosture } from "./permission-policy/policy-ref.js";

export interface StoredNativePermissionSelection extends NativePermissionSelection {
  actor: string;
  reason: string;
  updatedAt: string;
}

export type PermissionModeSource = "explicit" | "member_spec" | "rig_spec" | "system_default";

export interface ResolvedSeatPermission {
  effectiveMode: string;
  source: PermissionModeSource;
  launchPosture?: "floor" | "full_bypass" | "auto";
  permissionMode?: string;
  fallbackReason?: string;
}

/** The stable node owns the desired setting. Native history and current processes are untouched. */
export class NativePermissionStore {
  constructor(private readonly db: Database.Database) {}

  read(nodeId: string): StoredNativePermissionSelection | null {
    const row = this.db.prepare("SELECT * FROM node_permission_selections WHERE node_id = ?").get(nodeId) as {
      runtime: string; mode: string; actor: string; reason: string; updated_at: string;
    } | undefined;
    if (!row) return null;
    if ((row.runtime !== "codex" && row.runtime !== "claude-code") || !/^[A-Za-z][A-Za-z0-9_]*$/.test(row.mode)
      || (row.runtime === "codex" && row.mode !== "floor" && row.mode !== "full_bypass")) {
      throw new Error("Invalid persisted native permission selection; launch refused.");
    }
    return { runtime: row.runtime, mode: row.mode, actor: row.actor, reason: row.reason, updatedAt: row.updated_at };
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
    const selection = this.read(binding.nodeId);
    if (selection && selection.runtime !== runtime) {
      throw new Error("Seat runtime changed since permission selection; explicitly select again or inherit.");
    }
    const override = permissionBindingOverride(selection);
    const effectivePosture = override.launchPosture ?? binding.launchPosture;
    const permissionMode = override.permissionMode ?? (effectivePosture === "auto" && runtime === "claude-code" ? "auto" : undefined);
    return {
      ...binding,
      ...override,
      ...(permissionMode ? { permissionMode } : {}),
    };
  }
}
