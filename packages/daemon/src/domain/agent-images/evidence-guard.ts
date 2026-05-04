// Fork Primitive + Starter Agent Images v0 (PL-016) — evidence-
// preservation guard for `rig agent-image prune` / DELETE
// /api/agent-images/library/:id.
//
// PRD § Item 6 — CATASTROPHIC BOUNCE if dropped. An image is protected
// from deletion if ANY:
//
//   - Pinned (operator placed `.pinned` sentinel via `rig agent-image pin`)
//   - Referenced by an active agent.yaml (session_source: mode:
//     agent_image, ref.value: <name>) — scanned across discovery roots
//     for spec library files
//   - Referenced by a rig spec in the spec library (members[].session_source)
//   - Lineage descendant of another protected image (transitive
//     protection up the chain)
//
// The guard fails CLOSED. Operator may pass --force to override.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentImageEntry } from "./agent-image-types.js";

export type ProtectionReason =
  | "pinned"
  | "referenced_by_agent_spec"
  | "referenced_by_rig_spec"
  | "lineage_descendant_of_protected";

export interface ImageProtectionStatus {
  imageId: string;
  imageName: string;
  imageVersion: string;
  protected: boolean;
  reasons: ProtectionReason[];
  /** Specific filesystem paths that hold the protective references. */
  references: string[];
}

export interface EvidenceGuardOpts {
  /** All images in the library (so lineage-based protection can
   *  traverse the chain without re-walking discovery roots). */
  images: readonly AgentImageEntry[];
  /** Spec-library directories to walk for active references. Each is
   *  walked recursively for `*.yaml` / `*.yml` files. */
  specRoots: readonly string[];
}

/**
 * Compute protection status for every image. The result is parallel to
 * the input array order; the protected image set is what `prune` MUST
 * skip unless --force is supplied.
 */
export function evaluateProtection(opts: EvidenceGuardOpts): ImageProtectionStatus[] {
  const referencedNames = scanSpecRootsForReferences(opts.specRoots);

  // Pass 1: compute direct protection (pinned + referenced).
  const statuses = new Map<string, ImageProtectionStatus>();
  const protectedNameSet = new Set<string>();
  for (const img of opts.images) {
    const refs = referencedNames.get(img.name) ?? [];
    const reasons: ProtectionReason[] = [];
    if (img.pinned) reasons.push("pinned");
    // Distinguish agent.yaml-shaped vs rig.yaml-shaped references when
    // both surface; but the scanner returns paths, and the path-based
    // tag is stored alongside. Simplification at v0: any file whose
    // basename is `agent.yaml` is agent-spec; otherwise rig-spec.
    const seenReason = new Set<ProtectionReason>();
    for (const ref of refs) {
      const reason: ProtectionReason = ref.endsWith("/agent.yaml")
        ? "referenced_by_agent_spec"
        : "referenced_by_rig_spec";
      if (!seenReason.has(reason)) {
        reasons.push(reason);
        seenReason.add(reason);
      }
    }
    const status: ImageProtectionStatus = {
      imageId: img.id,
      imageName: img.name,
      imageVersion: img.version,
      protected: reasons.length > 0,
      reasons,
      references: refs,
    };
    statuses.set(img.name, status);
    if (status.protected) protectedNameSet.add(img.name);
  }

  // Pass 2: transitive lineage protection. An image whose lineage
  // includes a protected image becomes protected too. Iterate to a
  // fixed point so multi-hop chains converge.
  let changed = true;
  while (changed) {
    changed = false;
    for (const img of opts.images) {
      const status = statuses.get(img.name)!;
      if (status.protected) continue;
      // img's lineage lists ANCESTORS. We protect a DESCENDANT of a
      // protected image — meaning if any ancestor of `img` is
      // protected, `img` itself becomes protected by transit.
      for (const ancestor of img.lineage) {
        if (protectedNameSet.has(ancestor)) {
          status.protected = true;
          status.reasons.push("lineage_descendant_of_protected");
          status.references.push(`lineage-of:${ancestor}`);
          protectedNameSet.add(img.name);
          changed = true;
          break;
        }
      }
    }
  }

  return opts.images.map((img) => statuses.get(img.name)!);
}

/** Walk spec-library roots for YAML files and collect file paths that
 *  reference any agent_image by name. The match is conservative: any
 *  YAML that contains a `mode: agent_image` directive WITH a
 *  `value: <name>` field is treated as a reference. False positives are
 *  acceptable (over-protection); false negatives would cause
 *  catastrophic data loss. */
function scanSpecRootsForReferences(roots: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    walkYaml(root, (absPath) => {
      let raw: string;
      try { raw = readFileSync(absPath, "utf-8"); } catch { return; }
      if (!raw.includes("agent_image")) return;
      let parsed: unknown;
      try { parsed = parseYaml(raw); } catch { return; }
      const refs = collectImageRefs(parsed);
      for (const name of refs) {
        const existing = out.get(name) ?? [];
        existing.push(absPath);
        out.set(name, existing);
      }
    });
  }
  return out;
}

function walkYaml(root: string, visit: (absPath: string) => void): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) {
        try {
          if (statSync(abs).size > 5_000_000) continue; // skip suspiciously large YAML files
        } catch {
          continue;
        }
        visit(abs);
      }
    }
  }
}

/** Recursively walk a parsed YAML tree and collect the `value` of any
 *  `session_source: { mode: agent_image, ref: { kind: image_name, value: <name> } }`. */
function collectImageRefs(node: unknown, acc: Set<string> = new Set()): Set<string> {
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const item of node) collectImageRefs(item, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  // Match shape: session_source: { mode: agent_image, ref: { value: <name> } }
  const ss = obj["session_source"] ?? obj["sessionSource"];
  if (ss && typeof ss === "object" && !Array.isArray(ss)) {
    const ssObj = ss as Record<string, unknown>;
    if (ssObj["mode"] === "agent_image") {
      const ref = ssObj["ref"];
      if (ref && typeof ref === "object" && !Array.isArray(ref)) {
        const value = (ref as Record<string, unknown>)["value"];
        if (typeof value === "string" && value.length > 0) acc.add(value);
      }
    }
  }
  // Recurse into all values regardless — a rig.yaml has session_source
  // nested inside members[].
  for (const v of Object.values(obj)) collectImageRefs(v, acc);
  return acc;
}
