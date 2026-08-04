// OPR.0.4.8.3 — built-in policy reference materializer (guard-sealed plan v2
// eea3c778). Projects the packaged built-in policies to the stable inspection
// path $OPENRIG_HOME/reference/policies/builtin/ so operators can read (and
// copy-to-customize) them without spelunking the install tree.
//
// Contract (guard ruling):
//   - EXACTLY the known four built-ins — locked|standard|open|yolo — are ever
//     materialized; stranger files in the bundled dir are never copied.
//   - Copies are byte-identical, mode 0444 read-only INSPECTION copies. The
//     mode is a copy-to-customize affordance, not a security boundary; it is
//     reconciled on BOTH the refresh and content-skip paths, and it never
//     applies to user-custom copies (this module only writes the four stable
//     names under targetDir).
//   - Best-effort: a missing bundled dir or file is a named skip, never a
//     throw. No resolver, no writer surface — paths are injected by the
//     caller (startup wires the packaged geometry).
import * as fs from "node:fs";
import * as nodePath from "node:path";

export const BUILTIN_POLICY_NAMES = ["locked", "standard", "open", "yolo"] as const;

export interface MaterializeBuiltinPolicyReferenceDeps {
  /** the packaged source dir (…/policies/builtin next to the daemon dist) */
  bundledDir: string;
  /** the stable target dir ($OPENRIG_HOME/reference/policies/builtin) */
  targetDir: string;
}

export interface MaterializeBuiltinPolicyReferenceResult {
  written: string[];
  skipped: string[];
}

const READ_ONLY_MODE = 0o444;

export function materializeBuiltinPolicyReference(
  deps: MaterializeBuiltinPolicyReferenceDeps,
): MaterializeBuiltinPolicyReferenceResult {
  const written: string[] = [];
  const skipped: string[] = [];
  fs.mkdirSync(deps.targetDir, { recursive: true });
  for (const name of BUILTIN_POLICY_NAMES) {
    const file = `${name}.policy.md`;
    const source = nodePath.join(deps.bundledDir, file);
    const target = nodePath.join(deps.targetDir, file);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(source);
    } catch {
      skipped.push(file); // missing source: named, never thrown (best-effort)
      continue;
    }
    const upToDate = (() => {
      try {
        return fs.readFileSync(target).equals(bytes);
      } catch {
        return false;
      }
    })();
    if (upToDate) {
      // content-skip path still reconciles the inspection mode
      fs.chmodSync(target, READ_ONLY_MODE);
      continue;
    }
    // refresh over a possibly read-only copy: unlink-then-write (no chmod race)
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, bytes, { mode: READ_ONLY_MODE });
    fs.chmodSync(target, READ_ONLY_MODE); // umask-proof: the mode is the contract
    written.push(file);
  }
  return { written, skipped };
}
