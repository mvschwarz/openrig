import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ATOM_TAXONOMIES, TAXONOMY_TEACHING } from "@openrig/daemon/context-pack-taxonomy";

// Slice-03 Atom 2 — mirror the daemon's per-segment ref contract at the
// local install boundary. This must run before creating the context store.
const SAFE_REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Slice-03 lineage repair (R2 HIGH-2): the install boundary mirrors the daemon
// bounded, delimiter-free version token (ref-safety.SAFE_VERSION) so an unsafe
// version is rejected BEFORE any local write — matching the per-segment ref
// mirror above.
const SAFE_INSTALL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

export function assertSafeInstallRef(ref: string): void {
  const safe =
    ref.length > 0 &&
    ref.split("/").every(
      (segment) => segment.length > 0 && segment !== "." && segment !== ".." && SAFE_REF_SEGMENT.test(segment),
    );
  if (!safe) {
    throw new Error(
      `unsafe install ref '${ref}' — a ref must be one or more '/'-separated segments, each matching ` +
        `[A-Za-z0-9][A-Za-z0-9._-]{0,63} (no '.'/'..', no absolute path, no empty segment, no ` +
        `whitespace or injection), so packs stay inside the context store root.`,
    );
  }
}

export function assertTreeHasNoSymlinks(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absPath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Context pack directories must not contain symlinks: ${absPath}`);
      }
      if (entry.isDirectory()) stack.push(absPath);
    }
  }
}

// Slice-03 lineage repair (R2 HIGH-1): a lexically-safe path-like install ref
// can still escape the store if one of its parent namespace segments is a
// symlink (or a non-directory). Walk every ANCESTOR segment under the store root
// and reject before the copy — the FS-canonical containment the lexical ref
// check alone cannot give, mirroring the daemon compose namespace walk
// (context-pack-library-service.ts). A not-yet-created segment (ENOENT) is safe:
// cpSync will materialize it as a real directory.
export function assertDestinationNamespaceContained(targetRoot: string, installName: string): void {
  const segments = installName.split("/");
  let cursor = targetRoot;
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(cursor);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `unsafe install ref '${installName}' — its namespace segment '${cursor}' is a symlink or non-directory, ` +
          `so the copy would escape the context store root. Remove it or install under a different --name.`,
      );
    }
  }
}

// Kept in lockstep with the daemon parser's ALLOWED_FILE_SUFFIXES (manifest-parser.ts).
// Helper scripts are served as text, never executed by the install validator.
const ALLOWED_CONTEXT_PACK_SUFFIXES = new Set([".md", ".markdown", ".yaml", ".yml", ".txt", ".sh", ".ts", ".mjs", ".py"]);

export function validateContextPackManifestForInstall(manifestPath: string): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new Error(`manifest at ${manifestPath} is not valid YAML: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`manifest at ${manifestPath} must be a YAML object at the root`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["name"] !== "string" || obj["name"].length === 0) {
    throw new Error(`manifest at ${manifestPath} is missing required field 'name' (string)`);
  }
  if (obj["version"] === undefined || obj["version"] === null) {
    throw new Error(`manifest at ${manifestPath} is missing required field 'version'`);
  }
  const versionStr = String(obj["version"]);
  if (!SAFE_INSTALL_VERSION.test(versionStr)) {
    throw new Error(
      `manifest at ${manifestPath} has an invalid version '${versionStr}' — a version must be a single bounded ` +
        `token [A-Za-z0-9][A-Za-z0-9._+-]{0,31} (no ':' or separator, no whitespace, ≤32 chars).`,
    );
  }
  // OPR.0.5.6.10 — teach the classification refusal at ADD time, not first
  // daemon scan (desk ruling T2). Enum + teaching text imported from the
  // daemon's one definition site; never a second value list here.
  const taxonomy = obj["taxonomy"];
  if (taxonomy === undefined || taxonomy === null) {
    throw new Error(`manifest at ${manifestPath} is missing required field 'taxonomy' — every context pack declares what kind of context it is. ${TAXONOMY_TEACHING}`);
  }
  if (typeof taxonomy !== "string" || !(ATOM_TAXONOMIES as readonly string[]).includes(taxonomy)) {
    throw new Error(`manifest at ${manifestPath} has invalid taxonomy ${JSON.stringify(taxonomy)}. ${TAXONOMY_TEACHING}`);
  }
  const files = obj["files"];
  if (!Array.isArray(files)) {
    throw new Error(`manifest at ${manifestPath} must declare 'files: [...]'`);
  }
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`manifest at ${manifestPath} has malformed entry at files[${i}]`);
    }
    const file = entry as Record<string, unknown>;
    const relPath = file["path"];
    if (typeof relPath !== "string" || relPath.length === 0) {
      throw new Error(`manifest at ${manifestPath} files[${i}] missing 'path' (string)`);
    }
    if (relPath.includes("..") || isAbsolute(relPath) || relPath.startsWith("\\")) {
      throw new Error(`manifest at ${manifestPath} files[${i}].path '${relPath}' must be a relative path inside the pack (no '..' segments, no leading '/')`);
    }
    if (!ALLOWED_CONTEXT_PACK_SUFFIXES.has(extname(relPath))) {
      throw new Error(`manifest at ${manifestPath} files[${i}].path '${relPath}' has an unsupported suffix; allowed: ${Array.from(ALLOWED_CONTEXT_PACK_SUFFIXES).join(", ")}`);
    }
    if (typeof file["role"] !== "string" || file["role"].length === 0) {
      throw new Error(`manifest at ${manifestPath} files[${i}] missing 'role' (string)`);
    }
  }
}
