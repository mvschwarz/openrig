// 51-04 testbed image — deriving the manifest's `stubAssetsHash` (plan §1) from the tree.
//
// The build verb (scripts/build-testbed-image.sh class) feeds the manifest four tree-derived
// inputs (git sha, node version, openrig sha, stub-assets hash) plus the base digest from the
// host-side `docker pull`. The stub-assets hash is the one requiring real derivation: it is the
// CENSUS RECEIPT of exactly which stub assets got baked into the image — a byte-reproducible
// identity so the runner / 51-05 matrix can compare runs across image versions.
//
// Scope discipline (census-scope-match-code-path): the caller passes the EXACT file list the
// Dockerfile COPYs — never a recursive walk, which would silently fold in untracked/generated
// siblings and make the receipt non-deterministic. The digest is over CANONICAL content: each
// file is hashed on its own, then a sorted {path,sha256} map is hashed — so a delimiter or quote
// embedded in a path can never forge a different honest asset set's digest
// (hash-join-delimiter-forgery). Missing file / empty set / a path escaping the asset root all
// fail LOUDLY — never a silent partial receipt that would look build-clean.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Loud, typed failure — a missing/invalid asset input must fail, never a silent partial
 *  receipt that omits (or over-counts) a baked-in file. */
export class TestbedBuildInputsError extends Error {
  constructor(message) {
    super(message);
    this.name = "TestbedBuildInputsError";
  }
}

/** The stub-assets receipt schema id — bumped only on a breaking receipt-shape change. */
export const STUB_ASSETS_SCHEMA = "openrig-testbed-stub-assets/v1";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Resolve a caller-supplied relative asset path INSIDE rootDir, rejecting absolute paths and
 *  any `..` escape (containment). The input list is author-controlled, so the threat here is
 *  accidental over-reach / a receipt that reaches outside the asset tree — a prefix check on the
 *  resolved path covers it. */
function resolveContained(rootDir, rel) {
  if (typeof rel !== "string" || rel.trim().length === 0) {
    throw new TestbedBuildInputsError("stub asset path must be a non-empty string");
  }
  const rootResolved = resolve(rootDir);
  const abs = resolve(rootResolved, rel);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) {
    throw new TestbedBuildInputsError(`stub asset path '${rel}' escapes the asset root`);
  }
  return abs;
}

/** Normalize a relative path to a stable POSIX form for the receipt (so the identity is
 *  platform-independent: back-slashes never leak into the hashed payload). */
function posixPath(rel) {
  return rel.split(sep).join("/");
}

/**
 * Compute the stub-assets census hash over an explicit file list under rootDir.
 * @returns {{ hash: string, receipt: { schema: string, files: Array<{path: string, sha256: string}> } }}
 */
export function deriveStubAssetsHash(rootDir, relativePaths) {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new TestbedBuildInputsError("stub assets root dir must be a non-empty string");
  }
  let rootStat;
  try {
    rootStat = statSync(resolve(rootDir));
  } catch {
    throw new TestbedBuildInputsError(`stub assets root '${rootDir}' does not exist`);
  }
  if (!rootStat.isDirectory()) {
    throw new TestbedBuildInputsError(`stub assets root '${rootDir}' is not a directory`);
  }
  if (!Array.isArray(relativePaths) || relativePaths.length === 0) {
    throw new TestbedBuildInputsError("stub asset file list must be a non-empty array");
  }

  const files = [];
  const seen = new Set();
  for (const rel of relativePaths) {
    const abs = resolveContained(rootDir, rel);
    const path = posixPath(rel);
    if (seen.has(path)) {
      throw new TestbedBuildInputsError(`stub asset path '${path}' listed more than once`);
    }
    seen.add(path);
    let bytes;
    try {
      bytes = readFileSync(abs);
    } catch {
      throw new TestbedBuildInputsError(`stub asset '${rel}' does not exist under the asset root`);
    }
    if (!statSync(abs).isFile()) {
      throw new TestbedBuildInputsError(`stub asset '${rel}' is not a regular file`);
    }
    files.push({ path, sha256: sha256(bytes) });
  }

  // Sort by POSIX path so the receipt + digest are order-independent. The digested payload is the
  // schema + the sorted {path,sha256} entries — both fields JSON-escaped (path) or fixed-width hex
  // (sha256), so no naive delimiter join can forge a distinct set.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const receipt = { schema: STUB_ASSETS_SCHEMA, files };
  const hash = sha256(JSON.stringify(receipt));
  return { hash, receipt };
}

/**
 * Parse + ENFORCE a digest-pinned base image reference (plan §1 fence: "digest-pinned, not
 * tag-floating"). A tag-floating base drifts silently between builds and breaks byte-repro; only a
 * `name[:tag]@sha256:<64-hex>` reference is accepted. The returned digest becomes the manifest's
 * baseDigest. Anything else — a tag-only ref, a malformed/non-sha256 digest, empty — fails LOUDLY.
 * @returns {{ ref: string, name: string, digest: string }}
 */
export function parseDigestPinnedBase(ref) {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new TestbedBuildInputsError("base image reference must be a non-empty string");
  }
  const trimmed = ref.trim();
  const at = trimmed.indexOf("@");
  if (at === -1) {
    throw new TestbedBuildInputsError(
      `base image '${trimmed}' is tag-floating — it must be digest-pinned (name@sha256:<64-hex>)`,
    );
  }
  const name = trimmed.slice(0, at);
  const digest = trimmed.slice(at + 1);
  if (name.trim().length === 0) {
    throw new TestbedBuildInputsError(`base image '${trimmed}' is missing a name before the digest`);
  }
  // Only sha256, exactly 64 lowercase hex — matches how docker records a pinned digest.
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new TestbedBuildInputsError(
      `base image digest '${digest}' is not a valid sha256:<64 lowercase hex> pin`,
    );
  }
  return { ref: trimmed, name, digest };
}

/**
 * Read the committed base-image slot (docker/testbed/base-image) — the digest resolved HOST-side by
 * the L0 runbook and recorded for byte-reproducibility. Comment (`#`) and blank lines are ignored;
 * exactly ONE reference must remain. An unresolved slot (comment-only), an ambiguous slot (multiple
 * refs), or a missing file all fail LOUDLY — the tree can never build against an unpinned base.
 * @returns {{ ref: string, name: string, digest: string }}
 */
export function readBaseImage(filePath) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new TestbedBuildInputsError("base-image file path must be a non-empty string");
  }
  if (!existsSync(filePath)) {
    throw new TestbedBuildInputsError(`base-image file '${filePath}' does not exist`);
  }
  const refs = readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (refs.length === 0) {
    throw new TestbedBuildInputsError(
      `base-image slot '${filePath}' is unresolved — resolve the digest host-side (L0 runbook)`,
    );
  }
  if (refs.length > 1) {
    throw new TestbedBuildInputsError(
      `base-image slot '${filePath}' names ${refs.length} refs — exactly one digest-pinned base is required`,
    );
  }
  return parseDigestPinnedBase(refs[0]);
}
