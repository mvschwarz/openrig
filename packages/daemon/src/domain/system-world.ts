import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const SYSTEM_WORLD_SCHEMA = "openrig.system-world/v0alpha1";
export const DEFAULT_SYSTEM_WORLD_SELECTION = "default";
export const DISABLED_SYSTEM_WORLD_SELECTION = "disabled";
export const DEFAULT_SYSTEM_WORLD_RELATIVE_PATH = "system/system-world.yaml";

export const DEFAULT_SYSTEM_WORLD_MANIFEST = `schema: ${SYSTEM_WORLD_SCHEMA}
id: openrig-default
version: "0.5.9"
context:
  - ref: onboarding-width
  - ref: world-public
    profiles:
      claude: guided
      codex: codex-coverage
skills: []
`;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

export interface SystemWorldContextSelection {
  ref: string;
  profiles?: { claude?: string; codex?: string };
}

export interface SystemWorldManifest {
  schema: typeof SYSTEM_WORLD_SCHEMA;
  id: string;
  version: string;
  context: SystemWorldContextSelection[];
  skills: string[];
}

export type SystemWorldSource = "default" | "file" | "env";

export type SystemWorldResolution =
  | {
    ok: true;
    state: "default" | "replacement" | "disabled";
    source: SystemWorldSource;
    selection: string;
    manifestPath: string | null;
    manifest: SystemWorldManifest | null;
  }
  | {
    ok: false;
    state: "default" | "replacement";
    source: SystemWorldSource;
    selection: string;
    manifestPath: string;
    error: { code: "system_world_missing" | "system_world_invalid"; message: string };
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label}: unknown key '${unknown}'`);
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new Error(`${label} must be a bounded identity`);
  }
  return value;
}

export function parseSystemWorldManifest(text: string, sourcePath = "System World manifest"): SystemWorldManifest {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new Error(`${sourcePath} is not valid YAML: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) throw new Error(`${sourcePath} must contain a YAML object`);
  assertOnlyKeys(raw, ["schema", "id", "version", "context", "skills"], sourcePath);
  if (raw["schema"] !== SYSTEM_WORLD_SCHEMA) {
    throw new Error(`${sourcePath} must declare schema: ${SYSTEM_WORLD_SCHEMA}`);
  }
  const id = boundedId(raw["id"], `${sourcePath} id`);
  const version = boundedId(raw["version"], `${sourcePath} version`);
  if (!Array.isArray(raw["context"]) || raw["context"].length === 0) {
    throw new Error(`${sourcePath} context must be a non-empty ordered list`);
  }
  const context = raw["context"].map((entry, index): SystemWorldContextSelection => {
    if (!isRecord(entry)) throw new Error(`${sourcePath} context[${index}] must be an object`);
    assertOnlyKeys(entry, ["ref", "profiles"], `${sourcePath} context[${index}]`);
    const ref = entry["ref"];
    if (typeof ref !== "string" || !REF.test(ref) || ref.split("/").includes("..")) {
      throw new Error(`${sourcePath} context[${index}].ref must be a safe context-pack ref`);
    }
    const profiles = entry["profiles"];
    if (profiles === undefined) return { ref };
    if (!isRecord(profiles)) throw new Error(`${sourcePath} context[${index}].profiles must be an object`);
    assertOnlyKeys(profiles, ["claude", "codex"], `${sourcePath} context[${index}].profiles`);
    const parsed: { claude?: string; codex?: string } = {};
    if (profiles["claude"] !== undefined) parsed.claude = boundedId(profiles["claude"], `${sourcePath} context[${index}].profiles.claude`);
    if (profiles["codex"] !== undefined) parsed.codex = boundedId(profiles["codex"], `${sourcePath} context[${index}].profiles.codex`);
    return { ref, profiles: parsed };
  });
  const skills = raw["skills"];
  if (!Array.isArray(skills) || !skills.every((skill) => typeof skill === "string" && ID.test(skill))) {
    throw new Error(`${sourcePath} skills must be a list of bounded skill identities`);
  }
  if (new Set(skills).size !== skills.length) throw new Error(`${sourcePath} skills must not contain duplicates`);
  return { schema: SYSTEM_WORLD_SCHEMA, id, version, context, skills };
}

export function resolveSystemWorld(input: {
  contextRoot: string;
  selection: string;
  source: SystemWorldSource;
}): SystemWorldResolution {
  const selection = input.selection.trim();
  if (selection === DISABLED_SYSTEM_WORLD_SELECTION) {
    return { ok: true, state: "disabled", source: input.source, selection, manifestPath: null, manifest: null };
  }
  const state = selection === DEFAULT_SYSTEM_WORLD_SELECTION ? "default" : "replacement";
  const manifestPath = state === "default"
    ? join(input.contextRoot, DEFAULT_SYSTEM_WORLD_RELATIVE_PATH)
    : isAbsolute(selection) ? resolve(selection) : resolve(input.contextRoot, selection);
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      state,
      source: input.source,
      selection,
      manifestPath,
      error: { code: "system_world_missing", message: `System World ${state} manifest does not exist: ${manifestPath}` },
    };
  }
  try {
    return {
      ok: true,
      state,
      source: input.source,
      selection,
      manifestPath,
      manifest: parseSystemWorldManifest(readFileSync(manifestPath, "utf8"), manifestPath),
    };
  } catch (error) {
    return {
      ok: false,
      state,
      source: input.source,
      selection,
      manifestPath,
      error: { code: "system_world_invalid", message: (error as Error).message },
    };
  }
}
