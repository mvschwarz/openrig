import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// -- Shared types --

/**
 * Provenance block — attribution metadata for a bundle artifact. All fields
 * optional for backward compat; bundles without provenance install unchanged.
 * Captured by the bundle-assembler at create time; surfaced in inspect output
 * and audit-trail records. Not cryptographically signed at this stage.
 */
export interface BundleProvenance {
  /** ISO timestamp; mirrors root createdAt at create time. */
  createdAt?: string;
  /** os.hostname() of the host that ran rig bundle create. */
  sourceHost?: string;
  /** Canonical session name of the creator (e.g. velocity-driver@openrig-velocity). */
  authorSession?: string;
  /** ULID of the source rig, if creating from a live rig. */
  sourceRigId?: string;
  /** Name of the source rig, if creating from a live rig. */
  sourceRigName?: string;
  /** Daemon version at create time (e.g. 0.3.2). */
  daemonVersion?: string;
  /** CLI version at create time (e.g. 0.3.2). */
  cliVersion?: string;
  /** Operator-authored notes from the --notes flag on rig bundle create. */
  notes?: string;
}

const PROVENANCE_STRING_FIELDS = [
  "created_at",
  "source_host",
  "author_session",
  "source_rig_id",
  "source_rig_name",
  "daemon_version",
  "cli_version",
  "notes",
] as const;

/** Validate optional provenance block. Appends to errors if present-but-malformed. */
function validateProvenanceBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("provenance must be an object");
    return;
  }
  const p = raw as Record<string, unknown>;
  for (const field of PROVENANCE_STRING_FIELDS) {
    if (field in p && typeof p[field] !== "string") {
      errors.push(`provenance.${field} must be a string`);
    }
  }
}

/** Serialize a typed BundleProvenance to the snake_case YAML record shape. */
function provenanceToYamlRecord(p: BundleProvenance): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.createdAt !== undefined) out["created_at"] = p.createdAt;
  if (p.sourceHost !== undefined) out["source_host"] = p.sourceHost;
  if (p.authorSession !== undefined) out["author_session"] = p.authorSession;
  if (p.sourceRigId !== undefined) out["source_rig_id"] = p.sourceRigId;
  if (p.sourceRigName !== undefined) out["source_rig_name"] = p.sourceRigName;
  if (p.daemonVersion !== undefined) out["daemon_version"] = p.daemonVersion;
  if (p.cliVersion !== undefined) out["cli_version"] = p.cliVersion;
  if (p.notes !== undefined) out["notes"] = p.notes;
  return out;
}

/**
 * Cross-primitive bundling — Item 6 / slice-05 Checkpoint 7.1.
 *
 * Manifest may optionally declare typed sibling primitives the bundle should
 * route to their respective libraries on install. v0 ships the `skills` kind
 * (Checkpoint 7.1). Plugins + workflow_specs + context_packs + agent_images
 * land additively in subsequent checkpoints as their libraries are reachable.
 *
 * PRD §Item 6: bundles list these alongside the existing rig + agents +
 * packages fields (no `contents:` re-grouping — that would be a schema
 * reorg violating the no-bump constraint). Each kind is an optional top-
 * level field; missing kinds keep backward compat.
 */

/**
 * Plugin reference — Item 6 / slice-05 Checkpoint 7.3b. Bundle manifest may
 * declare plugin references the bundle includes (in HYBRID mode the bundle
 * REFERENCES the existing 0.3.1 plugin rather than forking its content; per
 * orch-ratified decision doc).
 */
export interface BundlePluginReference {
  /** Plugin id (matches the plugin primitive's id surface). */
  id: string;
  /** Where to resolve the plugin from. v0 supports local-path source. */
  source: { kind: "local"; path: string };
}

/** Validate optional plugins[] block. Appends to errors if present-but-malformed. */
function validatePluginsBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    errors.push("plugins must be an array");
    return;
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`plugins[${i}] must be an object`);
      continue;
    }
    const p = entry as Record<string, unknown>;
    if (typeof p["id"] !== "string" || !p["id"]) {
      errors.push(`plugins[${i}].id is required`);
    }
    const source = p["source"];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      errors.push(`plugins[${i}].source must be an object`);
      continue;
    }
    const s = source as Record<string, unknown>;
    if (s["kind"] !== "local") {
      errors.push(`plugins[${i}].source.kind must be 'local' (other kinds reserved for future)`);
    }
    if (typeof s["path"] !== "string" || !s["path"]) {
      errors.push(`plugins[${i}].source.path is required`);
    } else if (!isRelativeSafePath(s["path"] as string)) {
      errors.push(`plugins[${i}].source.path is not safe: '${s["path"]}'`);
    }
  }
}

/** Normalize raw plugins[] block (defensive copy). */
function normalizePluginsBlock(raw: unknown): BundlePluginReference[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: BundlePluginReference[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const p = entry as Record<string, unknown>;
    const s = p["source"];
    if (typeof p["id"] !== "string" || !p["id"]) continue;
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    const src = s as Record<string, unknown>;
    if (src["kind"] !== "local" || typeof src["path"] !== "string" || !src["path"]) continue;
    result.push({ id: p["id"], source: { kind: "local", path: src["path"] } });
  }
  return result.length > 0 ? result : undefined;
}

/** Validate optional skills[] block. Appends to errors if present-but-malformed. */
function validateSkillsBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    errors.push("skills must be an array");
    return;
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      errors.push(`skills[${i}] must be a string`);
      continue;
    }
    if (!isRelativeSafePath(entry)) {
      errors.push(`skills[${i}] path is not safe: '${entry}'`);
    }
  }
}

/** Normalize raw skills[] block (defensive copy + string filter). */
function normalizeSkillsBlock(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

/** Validate optional workflow_specs[] block. Appends to errors if present-but-malformed.
 * Item 6 / slice-05 Checkpoint 7.3e. Same shape as skills[]: array of relative-safe paths
 * to workflow spec YAML files inside the bundle. */
function validateWorkflowSpecsBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    errors.push("workflow_specs must be an array");
    return;
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      errors.push(`workflow_specs[${i}] must be a string`);
      continue;
    }
    if (!isRelativeSafePath(entry)) {
      errors.push(`workflow_specs[${i}] path is not safe: '${entry}'`);
    }
  }
}

/** Normalize raw workflow_specs[] block (defensive copy + string filter). */
function normalizeWorkflowSpecsBlock(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

/** Validate optional context_packs[] block. Item 6 / slice-05 Checkpoint 7.3f.
 * Each entry is a relative-safe path to a context-pack's manifest.yaml inside
 * the bundle (per PRD §Item 6). The router copies the parent directory of
 * each manifest path to the operator context-packs library on install. */
function validateContextPacksBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    errors.push("context_packs must be an array");
    return;
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      errors.push(`context_packs[${i}] must be a string`);
      continue;
    }
    if (!isRelativeSafePath(entry)) {
      errors.push(`context_packs[${i}] path is not safe: '${entry}'`);
    }
  }
}

/** Normalize raw context_packs[] block (defensive copy + string filter). */
function normalizeContextPacksBlock(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

/** Validate optional agent_images[] block. Item 6 / slice-05 Checkpoint 7.3g.
 * Each entry is a relative-safe path to an agent-image DIRECTORY inside the
 * bundle (per PRD §Item 6 line 197: agent_images: [path/to/agent-image-name/,
 * ...]). The router copies the declared directory itself to the operator
 * agent-images library on install. The consumer
 * (agent-image-library-service.ts:77-95) requires manifest.yaml to exist
 * inside each routed image dir; the router enforces that at copy time. */
function validateAgentImagesBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) {
    errors.push("agent_images must be an array");
    return;
  }
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (typeof entry !== "string") {
      errors.push(`agent_images[${i}] must be a string`);
      continue;
    }
    if (!isRelativeSafePath(entry)) {
      errors.push(`agent_images[${i}] path is not safe: '${entry}'`);
    }
  }
}

/** Normalize raw agent_images[] block (defensive copy + string filter). */
function normalizeAgentImagesBlock(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

/**
 * Compatibility block — operator-declared install-time requirements for a
 * bundle artifact. All fields optional; missing block keeps backward compat
 * (bundles install unchanged). Install-time version check (Item 2 Checkpoint
 * 3.3) consults this block before bootstrap delegation; --skip-version-check
 * is the operator-explicit override.
 */
export interface BundleCompatibility {
  /** Minimum daemon version required to install this bundle (semver string). */
  minDaemonVersion?: string;
  /** Minimum CLI version required to install this bundle (semver string). */
  minCliVersion?: string;
  /** Schema version reaffirmed; mirrors root schemaVersion when set. */
  schemaVersion?: number;
}

/** Validate optional compatibility block. Appends to errors if present-but-malformed. */
function validateCompatibilityBlock(raw: unknown, errors: string[]): void {
  if (raw === undefined) return;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("compatibility must be an object");
    return;
  }
  const c = raw as Record<string, unknown>;
  if ("min_daemon_version" in c && typeof c["min_daemon_version"] !== "string") {
    errors.push("compatibility.min_daemon_version must be a string");
  }
  if ("min_cli_version" in c && typeof c["min_cli_version"] !== "string") {
    errors.push("compatibility.min_cli_version must be a string");
  }
  if ("schema_version" in c && typeof c["schema_version"] !== "number") {
    errors.push("compatibility.schema_version must be a number");
  }
}

/** Serialize a typed BundleCompatibility to the snake_case YAML record shape. */
function compatibilityToYamlRecord(c: BundleCompatibility): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.minDaemonVersion !== undefined) out["min_daemon_version"] = c.minDaemonVersion;
  if (c.minCliVersion !== undefined) out["min_cli_version"] = c.minCliVersion;
  if (c.schemaVersion !== undefined) out["schema_version"] = c.schemaVersion;
  return out;
}

/**
 * Normalize raw snake_case compatibility to typed camelCase BundleCompatibility.
 * Returns undefined when absent or empty. Exported alongside the provenance
 * normalizer so the v2 inspect-route projection can produce a single
 * camelCase shape for both manifest schemas.
 */
export function normalizeCompatibilityBlock(raw: unknown): BundleCompatibility | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const result: BundleCompatibility = {};
  if (typeof c["min_daemon_version"] === "string") result.minDaemonVersion = c["min_daemon_version"];
  if (typeof c["min_cli_version"] === "string") result.minCliVersion = c["min_cli_version"];
  if (typeof c["schema_version"] === "number") result.schemaVersion = c["schema_version"];
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Normalize raw snake_case provenance (as parsed from YAML or received from
 * a request body) to typed camelCase BundleProvenance. Returns undefined when
 * absent or empty. Exported so both the v1 normalizer pipeline and the v2
 * inspect-route projection produce identical camelCase shapes — the
 * /api/bundles/inspect contract is one shape regardless of schema version.
 */
export function normalizeProvenanceBlock(raw: unknown): BundleProvenance | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  const result: BundleProvenance = {};
  if (typeof p["created_at"] === "string") result.createdAt = p["created_at"];
  if (typeof p["source_host"] === "string") result.sourceHost = p["source_host"];
  if (typeof p["author_session"] === "string") result.authorSession = p["author_session"];
  if (typeof p["source_rig_id"] === "string") result.sourceRigId = p["source_rig_id"];
  if (typeof p["source_rig_name"] === "string") result.sourceRigName = p["source_rig_name"];
  if (typeof p["daemon_version"] === "string") result.daemonVersion = p["daemon_version"];
  if (typeof p["cli_version"] === "string") result.cliVersion = p["cli_version"];
  if (typeof p["notes"] === "string") result.notes = p["notes"];
  return Object.keys(result).length > 0 ? result : undefined;
}

// -- Pod-aware bundle types (AgentSpec reboot) --

export interface PodBundleAgentImportEntry {
  name: string;
  version: string;
  path: string;
  originalRef: string;
  hash: string;
}

export interface PodBundleAgentEntry {
  name: string;
  version: string;
  path: string;
  originalRef: string;
  hash: string;
  importEntries: PodBundleAgentImportEntry[];
}

export interface PodBundleManifest {
  schemaVersion: 2;
  name: string;
  version: string;
  createdAt: string;
  rigSpec: string;
  agents: PodBundleAgentEntry[];
  cultureFile?: string;
  integrity?: BundleIntegrity;
  provenance?: BundleProvenance;
  compatibility?: BundleCompatibility;
  /** Item 6 cross-primitive bundling: skill paths to route to the operator skills library on install. */
  skills?: string[];
  /** Item 6 cross-primitive bundling: plugin references to install via the plugin primitive (HYBRID-mode bundles reference existing plugins rather than forking content). */
  plugins?: BundlePluginReference[];
  /** Item 6 cross-primitive bundling: workflow spec YAML paths to route to the operator workflow-specs library on install (Checkpoint 7.3e). */
  workflowSpecs?: string[];
  /** Item 6 cross-primitive bundling: paths to context-pack manifest.yaml files; router copies the parent dir to the operator context-packs library on install (Checkpoint 7.3f). */
  contextPacks?: string[];
  /** Item 6 cross-primitive bundling: paths to agent-image DIRECTORIES (per PRD §Item 6 line 197); router copies the declared directory to the operator agent-images library on install. Consumer requires manifest.yaml inside each image dir. (Checkpoint 7.3g) */
  agentImages?: string[];
}

export function validatePodBundleManifest(raw: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { valid: false, errors: ["manifest must be an object"] };
  const m = raw as Record<string, unknown>;

  if (m["schema_version"] !== 2) errors.push("schema_version must be 2");
  if (typeof m["name"] !== "string" || !m["name"]) errors.push("name is required");
  if (typeof m["version"] !== "string" || !m["version"]) errors.push("version is required");
  if (typeof m["created_at"] !== "string" || !m["created_at"]) errors.push("created_at is required");
  if (typeof m["rig_spec"] !== "string" || !m["rig_spec"]) errors.push("rig_spec path is required");
  else if (!isRelativeSafePath(m["rig_spec"] as string)) errors.push(`rig_spec path is not safe: '${m["rig_spec"]}'`);

  if (!Array.isArray(m["agents"])) {
    errors.push("agents must be an array");
  } else {
    for (let i = 0; i < m["agents"].length; i++) {
      const a = m["agents"][i] as Record<string, unknown>;
      if (typeof a["name"] !== "string" || !a["name"]) errors.push(`agents[${i}].name is required`);
      if (typeof a["path"] !== "string" || !a["path"]) errors.push(`agents[${i}].path is required`);
      else if (!isRelativeSafePath(a["path"] as string)) errors.push(`agents[${i}].path is not safe`);
      if (typeof a["hash"] !== "string" || !a["hash"]) errors.push(`agents[${i}].hash is required`);
    }
  }

  validateProvenanceBlock(m["provenance"], errors);
  validateCompatibilityBlock(m["compatibility"], errors);
  validateSkillsBlock(m["skills"], errors);
  validatePluginsBlock(m["plugins"], errors);
  validateWorkflowSpecsBlock(m["workflow_specs"], errors);
  validateContextPacksBlock(m["context_packs"], errors);
  validateAgentImagesBlock(m["agent_images"], errors);

  return { valid: errors.length === 0, errors };
}

export function serializePodBundleManifest(manifest: PodBundleManifest): string {
  const doc: Record<string, unknown> = {
    schema_version: 2,
    name: manifest.name,
    version: manifest.version,
    created_at: manifest.createdAt,
    rig_spec: manifest.rigSpec,
    agents: manifest.agents.map((a) => ({
      name: a.name,
      version: a.version,
      path: a.path,
      original_ref: a.originalRef,
      hash: a.hash,
      import_entries: a.importEntries.map((ie) => ({
        name: ie.name,
        version: ie.version,
        path: ie.path,
        original_ref: ie.originalRef,
        hash: ie.hash,
      })),
    })),
  };
  if (manifest.cultureFile) doc["culture_file"] = manifest.cultureFile;
  if (manifest.integrity) doc["integrity"] = { algorithm: manifest.integrity.algorithm, files: manifest.integrity.files };
  if (manifest.provenance) doc["provenance"] = provenanceToYamlRecord(manifest.provenance);
  if (manifest.compatibility) doc["compatibility"] = compatibilityToYamlRecord(manifest.compatibility);
  if (manifest.skills && manifest.skills.length > 0) doc["skills"] = manifest.skills;
  if (manifest.plugins && manifest.plugins.length > 0) doc["plugins"] = manifest.plugins.map((p) => ({ id: p.id, source: { kind: p.source.kind, path: p.source.path } }));
  if (manifest.workflowSpecs && manifest.workflowSpecs.length > 0) doc["workflow_specs"] = manifest.workflowSpecs;
  if (manifest.contextPacks && manifest.contextPacks.length > 0) doc["context_packs"] = manifest.contextPacks;
  if (manifest.agentImages && manifest.agentImages.length > 0) doc["agent_images"] = manifest.agentImages;
  return stringifyYaml(doc);
}

export function parsePodBundleManifest(yaml: string): unknown {
  return parseYaml(yaml);
}

// -- Legacy bundle types (pre-reboot) --
// TODO: Remove when AS-T12 migrates all consumers

/** A package entry in the legacy bundle manifest */
export interface LegacyBundlePackageEntry {
  name: string;
  version: string;
  path: string;
  originalSource: string;
  /** All original source refs when deduped from multiple inputs */
  originalSources?: string[];
}

/** Integrity section with per-file checksums */
export interface BundleIntegrity {
  algorithm: "sha256";
  files: Record<string, string>;
}

/** The bundle.yaml manifest */
export interface LegacyBundleManifest {
  schemaVersion: number;
  name: string;
  version: string;
  createdAt: string;
  rigSpec: string;
  packages: LegacyBundlePackageEntry[];
  integrity?: BundleIntegrity;
  provenance?: BundleProvenance;
  compatibility?: BundleCompatibility;
  /** Item 6 cross-primitive bundling: skill paths to route to the operator skills library on install. */
  skills?: string[];
  /** Item 6 cross-primitive bundling: plugin references to install via the plugin primitive (HYBRID-mode bundles reference existing plugins rather than forking content). */
  plugins?: BundlePluginReference[];
  /** Item 6 cross-primitive bundling: workflow spec YAML paths to route to the operator workflow-specs library on install (Checkpoint 7.3e). */
  workflowSpecs?: string[];
  /** Item 6 cross-primitive bundling: paths to context-pack manifest.yaml files; router copies the parent dir to the operator context-packs library on install (Checkpoint 7.3f). */
  contextPacks?: string[];
  /** Item 6 cross-primitive bundling: paths to agent-image DIRECTORIES (per PRD §Item 6 line 197); router copies the declared directory to the operator agent-images library on install. Consumer requires manifest.yaml inside each image dir. (Checkpoint 7.3g) */
  agentImages?: string[];
}

/** Validation options */
interface ValidateOptions {
  requireIntegrity?: boolean;
}

/**
 * Check if a path is a safe archive-relative path.
 * Rejects: absolute paths, ../ traversal, backslashes, dot segments (./, bare .),
 * empty segments (//), empty string.
 */
export function isRelativeSafePath(p: string): boolean {
  if (!p || p.length === 0) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/** Validate a raw parsed bundle manifest */
export function validateLegacyBundleManifest(
  raw: unknown,
  opts?: ValidateOptions,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const requireIntegrity = opts?.requireIntegrity ?? true;

  if (!raw || typeof raw !== "object") {
    return { valid: false, errors: ["manifest must be an object"] };
  }

  const m = raw as Record<string, unknown>;

  if (m["schema_version"] !== 1) errors.push("schema_version must be 1");
  if (typeof m["name"] !== "string" || !m["name"]) errors.push("name is required");
  if (typeof m["version"] !== "string" || !m["version"]) errors.push("version is required");
  if (typeof m["created_at"] !== "string" || !m["created_at"]) errors.push("created_at is required");

  // rig_spec path
  if (typeof m["rig_spec"] !== "string" || !m["rig_spec"]) {
    errors.push("rig_spec path is required");
  } else if (!isRelativeSafePath(m["rig_spec"] as string)) {
    errors.push(`rig_spec path is not a safe relative path: '${m["rig_spec"]}'`);
  }

  // packages
  if (!Array.isArray(m["packages"]) || m["packages"].length === 0) {
    errors.push("packages must be a non-empty array");
  } else {
    for (let i = 0; i < m["packages"].length; i++) {
      const pkg = m["packages"][i] as Record<string, unknown>;
      if (typeof pkg["name"] !== "string" || !pkg["name"]) errors.push(`packages[${i}].name is required`);
      if (typeof pkg["version"] !== "string" || !pkg["version"]) errors.push(`packages[${i}].version is required`);
      if (typeof pkg["path"] !== "string" || !pkg["path"]) {
        errors.push(`packages[${i}].path is required`);
      } else if (!isRelativeSafePath(pkg["path"] as string)) {
        errors.push(`packages[${i}].path is not a safe relative path: '${pkg["path"]}'`);
      }
      if (typeof pkg["original_source"] !== "string" || !pkg["original_source"]) errors.push(`packages[${i}].original_source is required`);
    }
  }

  // integrity (optional unless requireIntegrity)
  // Integrity validation — always validate structure when present, require when flag set
  const hasIntegrity = m["integrity"] && typeof m["integrity"] === "object";
  if (requireIntegrity && !hasIntegrity) {
    errors.push("integrity section is required");
  }
  if (hasIntegrity) {
    const integrity = m["integrity"] as Record<string, unknown>;
    if (integrity["algorithm"] !== "sha256") errors.push("integrity.algorithm must be 'sha256'");
    if (!integrity["files"] || typeof integrity["files"] !== "object" || Object.keys(integrity["files"] as object).length === 0) {
      errors.push("integrity.files must be a non-empty object");
    } else {
      const files = integrity["files"] as Record<string, unknown>;
      for (const [key, value] of Object.entries(files)) {
        if (!isRelativeSafePath(key)) {
          errors.push(`integrity.files key is not a safe relative path: '${key}'`);
        }
        if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
          errors.push(`integrity.files['${key}'] must be a 64-char hex SHA-256 hash`);
        }
      }
    }
  }

  validateProvenanceBlock(m["provenance"], errors);
  validateCompatibilityBlock(m["compatibility"], errors);
  validateSkillsBlock(m["skills"], errors);
  validatePluginsBlock(m["plugins"], errors);
  validateWorkflowSpecsBlock(m["workflow_specs"], errors);
  validateContextPacksBlock(m["context_packs"], errors);
  validateAgentImagesBlock(m["agent_images"], errors);

  return { valid: errors.length === 0, errors };
}

/** Parse bundle.yaml YAML string to unknown */
export function parseLegacyBundleManifest(yaml: string): unknown {
  return parseYaml(yaml);
}

/** Normalize raw parsed manifest to typed LegacyBundleManifest */
export function normalizeLegacyBundleManifest(raw: unknown): LegacyBundleManifest {
  const m = raw as Record<string, unknown>;
  const pkgs = (m["packages"] as Array<Record<string, unknown>>).map((p) => {
    const entry: LegacyBundlePackageEntry = {
      name: p["name"] as string,
      version: p["version"] as string,
      path: p["path"] as string,
      originalSource: (p["original_source"] as string) ?? "",
    };
    if (Array.isArray(p["original_sources"])) {
      entry.originalSources = p["original_sources"] as string[];
    }
    return entry;
  });

  const result: LegacyBundleManifest = {
    schemaVersion: (m["schema_version"] as number) ?? 1,
    name: m["name"] as string,
    version: m["version"] as string,
    createdAt: (m["created_at"] as string) ?? new Date().toISOString(),
    rigSpec: m["rig_spec"] as string,
    packages: pkgs,
  };

  if (m["integrity"] && typeof m["integrity"] === "object") {
    const integ = m["integrity"] as Record<string, unknown>;
    result.integrity = {
      algorithm: "sha256",
      files: (integ["files"] as Record<string, string>) ?? {},
    };
  }

  const provenance = normalizeProvenanceBlock(m["provenance"]);
  if (provenance) result.provenance = provenance;

  const compatibility = normalizeCompatibilityBlock(m["compatibility"]);
  if (compatibility) result.compatibility = compatibility;

  const skills = normalizeSkillsBlock(m["skills"]);
  if (skills) result.skills = skills;

  const plugins = normalizePluginsBlock(m["plugins"]);
  if (plugins) result.plugins = plugins;

  const workflowSpecs = normalizeWorkflowSpecsBlock(m["workflow_specs"]);
  if (workflowSpecs) result.workflowSpecs = workflowSpecs;

  const contextPacks = normalizeContextPacksBlock(m["context_packs"]);
  if (contextPacks) result.contextPacks = contextPacks;

  const agentImages = normalizeAgentImagesBlock(m["agent_images"]);
  if (agentImages) result.agentImages = agentImages;

  return result;
}

/** Serialize a LegacyBundleManifest to YAML */
export function serializeLegacyBundleManifest(manifest: LegacyBundleManifest): string {
  const doc: Record<string, unknown> = {
    schema_version: manifest.schemaVersion,
    name: manifest.name,
    version: manifest.version,
    created_at: manifest.createdAt,
    rig_spec: manifest.rigSpec,
    packages: manifest.packages.map((p) => ({
      name: p.name,
      version: p.version,
      path: p.path,
      original_source: p.originalSource,
      ...(p.originalSources && p.originalSources.length > 1 ? { original_sources: p.originalSources } : {}),
    })),
  };

  if (manifest.integrity) {
    doc["integrity"] = {
      algorithm: manifest.integrity.algorithm,
      files: manifest.integrity.files,
    };
  }

  if (manifest.provenance) doc["provenance"] = provenanceToYamlRecord(manifest.provenance);

  if (manifest.compatibility) doc["compatibility"] = compatibilityToYamlRecord(manifest.compatibility);

  if (manifest.skills && manifest.skills.length > 0) doc["skills"] = manifest.skills;
  if (manifest.plugins && manifest.plugins.length > 0) doc["plugins"] = manifest.plugins.map((p) => ({ id: p.id, source: { kind: p.source.kind, path: p.source.path } }));
  if (manifest.workflowSpecs && manifest.workflowSpecs.length > 0) doc["workflow_specs"] = manifest.workflowSpecs;
  if (manifest.contextPacks && manifest.contextPacks.length > 0) doc["context_packs"] = manifest.contextPacks;
  if (manifest.agentImages && manifest.agentImages.length > 0) doc["agent_images"] = manifest.agentImages;

  return stringifyYaml(doc);
}
