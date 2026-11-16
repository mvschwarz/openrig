import fs from "node:fs";
import { resolvePermissionPolicyAttachment, type PolicyResolveDeps } from "./policy-ref.js";
import type { LaunchPosture } from "./policy-spec.js";

export interface PersistedNodeProvenance {
  origin: string;
  launchPosture: string;
  resolvedTarget: string | null;
  declaringDir: string | null;
  nodeRef: string | null;
}

export interface PersistedRigProvenance {
  origin: string;
  launchPosture: string;
  resolvedTarget: string | null;
  declaringDir: string | null;
  rigRef: string | null;
}

export interface PersistedRestorePostureReader {
  getNodeProvenance: () => PersistedNodeProvenance | null;
  getFallbackRigRef: () => string | null;
  getRigProvenance: () => PersistedRigProvenance | null;
  readFile?: (target: string) => string;
}

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
 * Synchronous custom-policy reader used by display projections.
 * Rejects non-regular files (such as FIFOs, sockets, device nodes, or directories) via statSync
 * before opening the path so special files cannot block synchronous display reads; callers catch
 * any stat/read failure and retain the persisted posture.
 */
export function readRegularCustomPolicyFile(target: string): string {
  if (!fs.statSync(target).isFile()) {
    throw new Error(`Custom policy target is not a regular file: ${target}`);
  }
  return fs.readFileSync(target, "utf-8");
}

/**
 * OPR.0.4.8.3 Seam B — shared persisted-provenance posture resolution with main's exact lazy
 * lookup order and raw posture pass-through:
 *   1. Persisted node provenance wins over rig provenance. When `origin === "custom"` with both
 *      `declaringDir` and `resolvedTarget`, lazily falls back to `getFallbackRigRef()` only when
 *      `nodeRef` is null, and reopens + re-derives readable valid custom policies; unreadable or
 *      malformed files retain the raw persisted `launchPosture`.
 *   2. Only when node provenance is absent, `getRigProvenance()` is read with the same rule.
 *   3. No saved provenance (or an unexpected outer lookup error) returns `"floor"`.
 */
export function resolvePersistedRestorePosture(reader: PersistedRestorePostureReader): string {
  const readFile = reader.readFile ?? ((target: string) => fs.readFileSync(target, "utf-8"));
  try {
    const prov = reader.getNodeProvenance();
    if (prov) {
      if (prov.origin === "custom" && prov.declaringDir && prov.resolvedTarget) {
        const ref = prov.nodeRef ?? reader.getFallbackRigRef();
        if (ref) {
          let content: string | null = null;
          try {
            content = readFile(prov.resolvedTarget);
          } catch {
            content = null;
          }
          if (content !== null) {
            const body = content;
            const rederived = resolvePermissionPolicyAttachment(ref, prov.declaringDir, {
              readFile: () => body,
            });
            if (rederived.contentResolved) {
              return rederived.launchPosture;
            }
          }
        }
      }
      return prov.launchPosture;
    }

    const rigProv = reader.getRigProvenance();
    if (rigProv) {
      if (rigProv.origin === "custom" && rigProv.declaringDir && rigProv.resolvedTarget && rigProv.rigRef) {
        let content: string | null = null;
        try {
          content = readFile(rigProv.resolvedTarget);
        } catch {
          content = null;
        }
        if (content !== null) {
          const body = content;
          const rederived = resolvePermissionPolicyAttachment(rigProv.rigRef, rigProv.declaringDir, {
            readFile: () => body,
          });
          if (rederived.contentResolved) {
            return rederived.launchPosture;
          }
        }
      }
      return rigProv.launchPosture;
    }
  } catch {
    // Posture resolution must never throw; fall through to the locked minimum floor.
  }
  return "floor";
}

/**
 * Display-only posture resolution for batched node inventory and detail guidance:
 * follows `resolvePersistedRestorePosture` so displayed flags match unchanged `main` restore
 * (including inconsistent custom-origin rows whose ref resolves to a builtin or `none`),
 * normalizes unrecognized or empty persisted posture strings to `"floor"` so ambient OPENRIG_YOLO
 * never leaks into displayed commands, and reads custom targets through `readRegularCustomPolicyFile`
 * by default.
 */
export function resolveDisplayedRestorePosture(
  snapshot: PersistedPolicyProvenanceSnapshot,
  deps: PolicyResolveDeps = { readFile: readRegularCustomPolicyFile },
): LaunchPosture {
  const raw = resolvePersistedRestorePosture({
    getNodeProvenance: () =>
      snapshot.nodeOrigin != null && snapshot.nodeLaunchPosture != null
        ? {
            origin: snapshot.nodeOrigin,
            launchPosture: snapshot.nodeLaunchPosture,
            resolvedTarget: snapshot.nodeResolvedTarget,
            declaringDir: snapshot.nodeDeclaringDir,
            nodeRef: snapshot.nodeRef,
          }
        : null,
    getFallbackRigRef: () => snapshot.rigRef,
    getRigProvenance: () =>
      snapshot.rigOrigin != null && snapshot.rigLaunchPosture != null
        ? {
            origin: snapshot.rigOrigin,
            launchPosture: snapshot.rigLaunchPosture,
            resolvedTarget: snapshot.rigResolvedTarget,
            declaringDir: snapshot.rigDeclaringDir,
            rigRef: snapshot.rigRef,
          }
        : null,
    readFile: deps.readFile,
  });
  return asKnownLaunchPosture(raw) ?? "floor";
}
