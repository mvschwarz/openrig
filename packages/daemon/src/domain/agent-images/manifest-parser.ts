// Fork Primitive + Starter Agent Images v0 (PL-016) — manifest parser.
//
// Parses ~/.openrig/agent-images/<name>/manifest.yaml into a typed
// AgentImageManifest. Pure (no fs touches in the parser; caller hands
// in raw YAML). Validation guards: required field checks, runtime
// allow-list, path-traversal rejection on supplementary files.

import { parse as parseYaml } from "yaml";
import {
  AgentImageError,
  type AgentImageManifest,
  type AgentImageManifestFile,
  type AgentImageRuntime,
} from "./agent-image-types.js";

const ALLOWED_RUNTIMES: ReadonlySet<AgentImageRuntime> = new Set(["claude-code", "codex"]);
const ALLOWED_FILE_SUFFIXES = [".md", ".markdown", ".yaml", ".yml", ".txt", ".json"];

export function parseAgentImageManifest(rawYaml: string, sourcePath: string): AgentImageManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    throw new AgentImageError(
      "manifest_parse_error",
      `manifest at ${sourcePath} is not valid YAML: ${(err as Error).message}`,
      { sourcePath },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentImageError(
      "manifest_invalid",
      `manifest at ${sourcePath} must be a YAML object at the root`,
      { sourcePath },
    );
  }
  const obj = parsed as Record<string, unknown>;

  const name = obj["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new AgentImageError(
      "manifest_invalid",
      `manifest at ${sourcePath} is missing required field 'name'`,
      { sourcePath },
    );
  }

  const versionRaw = obj["version"];
  if (versionRaw === undefined || versionRaw === null) {
    throw new AgentImageError(
      "manifest_invalid",
      `manifest at ${sourcePath} is missing required field 'version'`,
      { sourcePath },
    );
  }
  const version = String(versionRaw);

  const runtime = obj["runtime"];
  if (typeof runtime !== "string" || !ALLOWED_RUNTIMES.has(runtime as AgentImageRuntime)) {
    throw new AgentImageError(
      "manifest_invalid",
      `manifest at ${sourcePath} has invalid runtime '${runtime}'; allowed: ${[...ALLOWED_RUNTIMES].join(", ")}`,
      { sourcePath, runtime },
    );
  }

  // Source seat / session id / resume token are required on a real
  // image. The PRD's v0 manifest schema reads these as load-bearing —
  // an image without a resume token can't be consumed.
  const sourceSeatRaw = obj["source_seat"] ?? obj["sourceSeat"];
  if (typeof sourceSeatRaw !== "string" || sourceSeatRaw.length === 0) {
    throw new AgentImageError(
      "manifest_invalid",
      `manifest at ${sourcePath} is missing required field 'source_seat'`,
      { sourcePath },
    );
  }
  const sourceSessionIdRaw = obj["source_session_id"] ?? obj["sourceSessionId"];
  if (typeof sourceSessionIdRaw !== "string" || sourceSessionIdRaw.length === 0) {
    throw new AgentImageError(
      "manifest_invalid",
      `manifest at ${sourcePath} is missing required field 'source_session_id'`,
      { sourcePath },
    );
  }
  const sourceResumeTokenRaw = obj["source_resume_token"] ?? obj["sourceResumeToken"];
  if (typeof sourceResumeTokenRaw !== "string" || sourceResumeTokenRaw.length === 0) {
    throw new AgentImageError(
      "manifest_invalid",
      `manifest at ${sourcePath} is missing required field 'source_resume_token'`,
      { sourcePath },
    );
  }

  const createdAtRaw = obj["created_at"] ?? obj["createdAt"];
  const createdAt = typeof createdAtRaw === "string" && createdAtRaw.length > 0
    ? createdAtRaw
    : new Date(0).toISOString();

  const notes = typeof obj["notes"] === "string" ? (obj["notes"] as string) : undefined;

  const filesRaw = obj["files"];
  const files: AgentImageManifestFile[] = [];
  if (Array.isArray(filesRaw)) {
    for (let i = 0; i < filesRaw.length; i++) {
      const f = filesRaw[i];
      if (!f || typeof f !== "object" || Array.isArray(f)) {
        throw new AgentImageError(
          "manifest_invalid",
          `manifest at ${sourcePath} has malformed entry at files[${i}] (must be object with path + role)`,
          { sourcePath, index: i },
        );
      }
      const fr = f as Record<string, unknown>;
      const path = fr["path"];
      if (typeof path !== "string" || path.length === 0) {
        throw new AgentImageError(
          "manifest_invalid",
          `manifest at ${sourcePath} files[${i}] missing 'path'`,
          { sourcePath, index: i },
        );
      }
      if (path.includes("..") || path.startsWith("/")) {
        throw new AgentImageError(
          "manifest_invalid",
          `manifest at ${sourcePath} files[${i}].path '${path}' must be a relative path inside the image (no '..', no leading '/')`,
          { sourcePath, index: i, path },
        );
      }
      if (!ALLOWED_FILE_SUFFIXES.some((s) => path.endsWith(s))) {
        throw new AgentImageError(
          "manifest_invalid",
          `manifest at ${sourcePath} files[${i}].path '${path}' has unsupported suffix; allowed: ${ALLOWED_FILE_SUFFIXES.join(", ")}`,
          { sourcePath, index: i, path },
        );
      }
      const role = fr["role"];
      if (typeof role !== "string" || role.length === 0) {
        throw new AgentImageError(
          "manifest_invalid",
          `manifest at ${sourcePath} files[${i}] missing 'role'`,
          { sourcePath, index: i, path },
        );
      }
      const summary = typeof fr["summary"] === "string" ? (fr["summary"] as string) : undefined;
      files.push(summary === undefined ? { path, role } : { path, role, summary });
    }
  }

  const estimatedTokensRaw = obj["estimated_tokens"] ?? obj["estimatedTokens"];
  const estimatedTokens = typeof estimatedTokensRaw === "number" && Number.isFinite(estimatedTokensRaw)
    ? Math.max(0, Math.floor(estimatedTokensRaw))
    : undefined;

  const lineageRaw = obj["lineage"];
  const lineage = Array.isArray(lineageRaw)
    ? lineageRaw.filter((l): l is string => typeof l === "string" && l.length > 0)
    : undefined;

  return {
    name,
    version,
    runtime: runtime as AgentImageRuntime,
    sourceSeat: sourceSeatRaw,
    sourceSessionId: sourceSessionIdRaw,
    sourceResumeToken: sourceResumeTokenRaw,
    createdAt,
    ...(notes !== undefined ? { notes } : {}),
    files,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    ...(lineage !== undefined ? { lineage } : {}),
  };
}
