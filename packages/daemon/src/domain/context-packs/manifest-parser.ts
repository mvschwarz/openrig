// Rig Context / Composable Context Injection v0 (PL-014) — manifest
// parser.
//
// Parses ~/.openrig/context-packs/<name>/manifest.yaml into a typed
// shape with structured-error rejects on malformed input. Pure
// (no fs touches in the parser itself; caller hands in raw YAML).

import { parse as parseYaml } from "yaml";
import { ContextPackError, type ContextPackManifest, type ContextPackManifestFile } from "./context-pack-types.js";

const ALLOWED_FILE_SUFFIXES = [".md", ".markdown", ".yaml", ".yml", ".txt"];

export function parseManifest(rawYaml: string, sourcePath: string): ContextPackManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    throw new ContextPackError(
      "manifest_parse_error",
      `manifest at ${sourcePath} is not valid YAML: ${(err as Error).message}`,
      { sourcePath },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ContextPackError(
      "manifest_invalid",
      `manifest at ${sourcePath} must be a YAML object at the root`,
      { sourcePath },
    );
  }
  const obj = parsed as Record<string, unknown>;

  const name = obj["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new ContextPackError(
      "manifest_invalid",
      `manifest at ${sourcePath} is missing required field 'name' (string)`,
      { sourcePath },
    );
  }

  // Version may be a number or string in YAML; normalize to string for
  // round-tripping with library ids and `<name>:<version>` formatting.
  const versionRaw = obj["version"];
  if (versionRaw === undefined || versionRaw === null) {
    throw new ContextPackError(
      "manifest_invalid",
      `manifest at ${sourcePath} is missing required field 'version'`,
      { sourcePath },
    );
  }
  const version = String(versionRaw);

  const purpose = typeof obj["purpose"] === "string" ? (obj["purpose"] as string) : undefined;

  const filesRaw = obj["files"];
  if (!Array.isArray(filesRaw)) {
    throw new ContextPackError(
      "manifest_invalid",
      `manifest at ${sourcePath} must declare 'files: [...]' (got: ${typeof filesRaw})`,
      { sourcePath },
    );
  }
  const files: ContextPackManifestFile[] = [];
  for (let i = 0; i < filesRaw.length; i++) {
    const f = filesRaw[i];
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      throw new ContextPackError(
        "manifest_invalid",
        `manifest at ${sourcePath} has malformed entry at files[${i}] (must be an object with 'path' + 'role')`,
        { sourcePath, index: i },
      );
    }
    const fr = f as Record<string, unknown>;
    const path = fr["path"];
    if (typeof path !== "string" || path.length === 0) {
      throw new ContextPackError(
        "manifest_invalid",
        `manifest at ${sourcePath} files[${i}] missing 'path' (string)`,
        { sourcePath, index: i },
      );
    }
    if (path.includes("..") || path.startsWith("/")) {
      throw new ContextPackError(
        "manifest_invalid",
        `manifest at ${sourcePath} files[${i}].path '${path}' must be a relative path inside the pack (no '..' segments, no leading '/')`,
        { sourcePath, index: i, path },
      );
    }
    const role = fr["role"];
    if (typeof role !== "string" || role.length === 0) {
      throw new ContextPackError(
        "manifest_invalid",
        `manifest at ${sourcePath} files[${i}] missing 'role' (string)`,
        { sourcePath, index: i, path },
      );
    }
    if (!ALLOWED_FILE_SUFFIXES.some((s) => path.endsWith(s))) {
      throw new ContextPackError(
        "manifest_invalid",
        `manifest at ${sourcePath} files[${i}].path '${path}' has an unsupported suffix; allowed: ${ALLOWED_FILE_SUFFIXES.join(", ")}`,
        { sourcePath, index: i, path },
      );
    }
    const summary = typeof fr["summary"] === "string" ? (fr["summary"] as string) : undefined;
    files.push(summary === undefined ? { path, role } : { path, role, summary });
  }

  const estimatedTokensRaw = obj["estimated_tokens"] ?? obj["estimatedTokens"];
  const estimatedTokens = typeof estimatedTokensRaw === "number" && Number.isFinite(estimatedTokensRaw)
    ? Math.max(0, Math.floor(estimatedTokensRaw))
    : undefined;

  return {
    name,
    version,
    ...(purpose !== undefined ? { purpose } : {}),
    files,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
  };
}
