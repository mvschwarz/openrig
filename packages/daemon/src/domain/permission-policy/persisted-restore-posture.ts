import fs from "node:fs";
import { resolvePermissionPolicyAttachment, type PolicyResolveDeps } from "./policy-ref.js";
import type { LaunchPosture } from "./policy-spec.js";

export interface PersistedPolicyProvenanceSnapshot {
  nodeOrigin: string | null;
  nodeLaunchPosture: string | null;
  nodeResolvedTarget: string | null;
  nodeDeclaringDir: string | null;
  nodeRef: string | null;
  rigOrigin: string | null;
  rigLaunchPosture: string | null;
  rigResolvedTarget: string | null;
  rigDeclaringDir: string | null;
  rigRef: string | null;
}

function asKnownLaunchPosture(value: string | null | undefined): LaunchPosture | undefined {
  return value === "floor" || value === "full_bypass" || value === "auto" ? value : undefined;
}

/**
 * Synchronous custom-policy reader shared by RestoreOrchestrator and node-inventory.
 * Rejects non-regular files (such as FIFOs, sockets, device nodes, or directories) via statSync
 * before opening the path so special files cannot block synchronous reads; callers catch any
 * stat/read failure and retain the persisted posture.
 */
export function readRegularCustomPolicyFile(target: string): string {
  if (!fs.statSync(target).isFile()) {
    throw new Error(`Custom policy target is not a regular file: ${target}`);
  }
  return fs.readFileSync(target, "utf-8");
}

/**
 * OPR.0.4.8.3 Seam B — shared persisted-provenance posture resolution used by both
 * RestoreOrchestrator.resolveRestorePosture and node-inventory resume command projection:
 *   1. Persisted node provenance (`nodeOrigin` + `nodeLaunchPosture` non-null) wins over rig
 *      provenance. Readable valid custom policies (`origin === "custom"`) reopen and re-derive
 *      their posture only when the resolved ref itself has `origin === "custom"`; non-regular,
 *      unreadable, invalid, or mismatched builtin/none refs retain the persisted posture.
 *   2. With no node provenance, persisted rig provenance (`rigOrigin` + `rigLaunchPosture`
 *      non-null) applies with the same custom re-derivation rule.
 *   3. No saved provenance (including legacy `permission_policy` rows with NULL provenance, or
 *      any unexpected error) resolves explicitly to `"floor"`, never raw `builtinLaunchPosture`
 *      or ambient environment delegation.
 */
export function resolvePersistedRestorePosture(
  snapshot: PersistedPolicyProvenanceSnapshot,
  deps: PolicyResolveDeps,
): LaunchPosture {
  try {
    if (snapshot.nodeOrigin != null && snapshot.nodeLaunchPosture != null) {
      if (snapshot.nodeOrigin === "custom" && snapshot.nodeDeclaringDir && snapshot.nodeResolvedTarget) {
        const ref = snapshot.nodeRef ?? snapshot.rigRef;
        if (ref) {
          let content: string | null = null;
          try {
            content = deps.readFile(snapshot.nodeResolvedTarget);
          } catch {
            content = null;
          }
          if (content !== null) {
            const body = content;
            const rederived = resolvePermissionPolicyAttachment(ref, snapshot.nodeDeclaringDir, {
              readFile: () => body,
            });
            if (rederived.contentResolved && rederived.origin === "custom") return rederived.launchPosture;
          }
        }
      }
      return asKnownLaunchPosture(snapshot.nodeLaunchPosture) ?? "floor";
    }

    if (snapshot.rigOrigin != null && snapshot.rigLaunchPosture != null) {
      if (snapshot.rigOrigin === "custom" && snapshot.rigDeclaringDir && snapshot.rigResolvedTarget && snapshot.rigRef) {
        let content: string | null = null;
        try {
          content = deps.readFile(snapshot.rigResolvedTarget);
        } catch {
          content = null;
        }
        if (content !== null) {
          const body = content;
          const rederived = resolvePermissionPolicyAttachment(snapshot.rigRef, snapshot.rigDeclaringDir, {
            readFile: () => body,
          });
          if (rederived.contentResolved && rederived.origin === "custom") return rederived.launchPosture;
        }
      }
      return asKnownLaunchPosture(snapshot.rigLaunchPosture) ?? "floor";
    }
  } catch {
    // Posture resolution must never throw; fall through to the locked minimum floor.
  }
  return "floor";
}
