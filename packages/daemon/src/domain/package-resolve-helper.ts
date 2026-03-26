import nodePath from "node:path";
import { createHash } from "node:crypto";
import { parseManifest, validateManifest, normalizeManifest, type PackageManifest } from "./package-manifest.js";
import type { ResolvedPackage, FsOps } from "./package-resolver.js";

export type ResolveResult =
  | { ok: true; resolved: ResolvedPackage }
  | { ok: false; kind: "resolution"; error: string }
  | { ok: false; kind: "validation"; errors: string[] };

/**
 * Two-step resolve: find manifest file, then parse+validate separately.
 * Keeps resolution errors (missing file) distinct from validation errors (bad schema).
 */
export function resolvePackage(sourceRef: string, cwd: string | undefined, fsOps: FsOps): ResolveResult {
  const absoluteRef = nodePath.isAbsolute(sourceRef)
    ? sourceRef
    : nodePath.resolve(cwd ?? process.cwd(), sourceRef);
  const manifestPath = nodePath.join(absoluteRef, "package.yaml");

  if (!fsOps.exists(manifestPath)) {
    return { ok: false, kind: "resolution", error: `No package.yaml found at ${manifestPath}` };
  }

  let rawYaml: string;
  try {
    rawYaml = fsOps.readFile(manifestPath);
  } catch (err) {
    return { ok: false, kind: "resolution", error: (err as Error).message };
  }

  let raw: unknown;
  try {
    raw = parseManifest(rawYaml);
  } catch (err) {
    return { ok: false, kind: "resolution", error: (err as Error).message };
  }

  const validation = validateManifest(raw);
  if (!validation.valid) {
    return { ok: false, kind: "validation", errors: validation.errors };
  }

  const manifest = normalizeManifest(raw) as PackageManifest;
  const manifestHash = createHash("sha256").update(rawYaml).digest("hex");

  return {
    ok: true,
    resolved: {
      sourceKind: "local_path",
      sourceRef: absoluteRef,
      manifest,
      manifestHash,
      rawManifestYaml: rawYaml,
    },
  };
}
