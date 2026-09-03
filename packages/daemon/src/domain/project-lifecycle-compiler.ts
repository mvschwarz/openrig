import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkflowSpec, WorkflowStepSpec } from "./workflow-types.js";
import { WorkflowSpecError } from "./workflow-spec-cache.js";
import { WorkflowValidator } from "./workflow-validator.js";
import {
  LifecycleManifestValidationError,
  validateMissionComposition,
  type LifecycleMissionMember,
} from "./lifecycle-manifest.js";

export interface LifecycleSourceDigest {
  kind: "project" | "mission" | "slice";
  path: string;
  sha256: string;
}

export interface LifecycleCompilation {
  version: 1;
  eligible: boolean;
  identity: {
    project: string;
    mission: string;
    lifecycleProfile: string | null;
  };
  operationKeyInput: string | null;
  compiledInputDigest: string;
  sources: LifecycleSourceDigest[];
  dependencies: Array<{ stepId: string; dependsOn: string[] }>;
  workflowSpec: WorkflowSpec | null;
  advisories: string[];
  unknowns: string[];
}

type Mapping = Record<string, unknown>;

/**
 * Read and compile project/mission/slice manifests without writing a file,
 * cache row, workflow instance, or qitem.  The generated spec is an output,
 * never a second authored source.
 */
export function compileProjectLifecycle(input: {
  missionPath: string;
  operationKey?: string;
}): LifecycleCompilation {
  const missionPath = resolveManifest(input.missionPath, "mission.yaml");
  const missionDir = dirname(missionPath);
  const workspaceRoot = dirname(dirname(missionDir));
  const projectPath = join(workspaceRoot, "project.yaml");
  const project = readManifest(projectPath, "project");
  const mission = readManifest(missionPath, "mission");
  const projectId = requiredString(asMapping(project.metadata, `${projectPath}: metadata`).id, `${projectPath}: metadata.id`);
  const missionName = requiredString(asMapping(mission.metadata, `${missionPath}: metadata`).name, `${missionPath}: metadata.name`);
  const lifecycleProfile = optionalString(asMapping(project.lifecycle, `${projectPath}: lifecycle`, true)?.profile, `${projectPath}: lifecycle.profile`);
  let members: LifecycleMissionMember[];
  try {
    members = validateMissionComposition(mission, missionPath);
  } catch (error) {
    if (error instanceof LifecycleManifestValidationError) throw manifestError(error.code, error.message, error.details);
    throw error;
  }

  const sources: LifecycleSourceDigest[] = [digestSource("project", projectPath), digestSource("mission", missionPath)];
  const steps: WorkflowStepSpec[] = [];
  const roles: WorkflowSpec["roles"] = {};
  const unknowns: string[] = [];
  const advisories: string[] = [];

  members.forEach((member) => {
    const { ref, normalizedRef, path: slicePath } = member;
    const slice = readManifest(slicePath, "slice");
    sources.push(digestSource("slice", slicePath));
    const sliceComposition = asMapping(slice.composition, `${slicePath}: composition`);
    const missionRef = requiredString(sliceComposition.mission, `${slicePath}: composition.mission`);
    if (isAbsolute(missionRef)) {
      throw manifestError("lifecycle_path_escape", `${slicePath}: composition.mission must be relative`, { slicePath, missionRef });
    }
    const resolvedMissionRef = resolve(dirname(slicePath), missionRef);
    if (!existsSync(resolvedMissionRef) || realpathSync(resolvedMissionRef) !== realpathSync(missionPath)) {
      throw manifestError("lifecycle_slice_mission_mismatch", `${slicePath}: composition.mission does not resolve to ${missionPath}`, { slicePath, missionRef, missionPath });
    }

    if (!member.active) return;
    const execution = asMapping(slice.execution, `${slicePath}: execution`, true);
    if (!execution) {
      unknowns.push(`${normalizedRef}: execution contract missing`);
      return;
    }
    const stepId = optionalString(asMapping(slice.metadata, `${slicePath}: metadata`, true)?.id, `${slicePath}: metadata.id`) ?? basename(dirname(slicePath));
    const actorRole = requiredString(execution.actor_role, `${slicePath}: execution.actor_role`);
    const preferredTargets = stringList(execution.preferred_targets, `${slicePath}: execution.preferred_targets`, true);
    roles[actorRole] ??= preferredTargets.length > 0 ? { preferred_targets: preferredTargets } : {};
    const dependsOn = stringList(execution.depends_on, `${slicePath}: execution.depends_on`, true);
    const allowedExits = stringList(execution.allowed_exits, `${slicePath}: execution.allowed_exits`, true);
    const step: WorkflowStepSpec = {
      id: stepId,
      actor_role: actorRole,
      ...(optionalString(execution.objective, `${slicePath}: execution.objective`) ? { objective: String(execution.objective) } : {}),
      ...(allowedExits.length > 0 ? { allowed_exits: allowedExits as WorkflowStepSpec["allowed_exits"] } : {}),
      depends_on: dependsOn,
      ...(optionalString(execution.harness, `${slicePath}: execution.harness`) ? { harness: execution.harness as WorkflowStepSpec["harness"] } : {}),
      ...(optionalString(execution.host, `${slicePath}: execution.host`) ? { host: String(execution.host) } : {}),
      ...(execution.gate ? { gate: asMapping(execution.gate, `${slicePath}: execution.gate`) as unknown as WorkflowStepSpec["gate"] } : {}),
      ...(execution.acceptance ? { acceptance: asMapping(execution.acceptance, `${slicePath}: execution.acceptance`) as unknown as WorkflowStepSpec["acceptance"] } : {}),
    };
    steps.push(step);
  });

  if (!input.operationKey) unknowns.push("opaque lifecycle operation key not supplied");
  if (!lifecycleProfile) unknowns.push("project lifecycle profile missing");
  if (steps.length === 0) unknowns.push("no active slice declares an execution contract");
  if (steps.length > 0 && steps.every((step) => (step.depends_on ?? []).length > 0)) {
    unknowns.push("execution graph has no root step");
  }
  const draftWorkflowSpec: WorkflowSpec | null = steps.length > 0
    ? {
        id: `lifecycle-${projectId}-${missionName}`,
        version: "1",
        objective: `Compiled lifecycle for ${projectId}/${missionName}`,
        entry: { role: steps.find((step) => (step.depends_on ?? []).length === 0)?.actor_role },
        roles,
        steps,
      }
    : null;
  const compiledInputDigest = sha256(stableJson({
    version: 1,
    identity: { project: projectId, mission: missionName, lifecycleProfile },
    sources: sources.map(({ kind, path, sha256 }) => ({ kind, path, sha256 })),
    workflowSpec: draftWorkflowSpec,
  }));
  const workflowSpec = draftWorkflowSpec
    ? { ...draftWorkflowSpec, version: `1-${compiledInputDigest.slice(0, 16)}` }
    : null;
  if (workflowSpec) {
    const validation = new WorkflowValidator().validate(workflowSpec);
    for (const issue of validation.issues) {
      const rendered = `compiled workflow [${issue.code}]: ${issue.message}`;
      if (issue.severity === "error") unknowns.push(rendered);
      else advisories.push(rendered);
    }
  }
  if (unknowns.length > 0) advisories.push("Compilation is inspectable but ineligible for instantiation until every named unknown is resolved.");
  return {
    version: 1,
    eligible: workflowSpec !== null && unknowns.length === 0,
    identity: { project: projectId, mission: missionName, lifecycleProfile },
    operationKeyInput: input.operationKey ?? null,
    compiledInputDigest,
    sources,
    dependencies: steps.map((step) => ({ stepId: step.id, dependsOn: step.depends_on ?? [] })),
    workflowSpec,
    advisories,
    unknowns,
  };
}

function resolveManifest(input: string, file: string): string {
  const candidate = resolve(input);
  return existsSync(candidate) && lstatSync(candidate).isDirectory() ? join(candidate, file) : candidate;
}

function readManifest(path: string, kind: string): Mapping {
  if (!existsSync(path)) throw manifestError("lifecycle_manifest_missing", `${kind} manifest not found at ${path}`, { path, kind });
  if (lstatSync(path).isSymbolicLink()) throw manifestError("lifecycle_manifest_symlink", `${kind} manifest may not be a symlink: ${path}`, { path, kind });
  let parsed: unknown;
  try { parsed = parseYaml(readFileSync(path, "utf8")); }
  catch (error) { throw manifestError("lifecycle_manifest_invalid", `${kind} manifest at ${path} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`, { path, kind }); }
  const mapping = asMapping(parsed, path);
  if (mapping.kind !== kind) throw manifestError("lifecycle_manifest_kind_mismatch", `${path}: expected kind ${kind}, got ${JSON.stringify(mapping.kind)}`, { path, expected: kind, actual: mapping.kind });
  return mapping;
}

function asMapping(value: unknown, label: string, optional?: false): Mapping;
function asMapping(value: unknown, label: string, optional: true): Mapping | null;
function asMapping(value: unknown, label: string, optional = false): Mapping | null {
  if ((value === undefined || value === null) && optional) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw manifestError("lifecycle_manifest_shape_invalid", `${label} must be a mapping`, { label, value });
  return value as Mapping;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw manifestError("lifecycle_field_missing", `${label} must be a non-empty string`, { label, value });
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, label);
}

function stringList(value: unknown, label: string, optional = false): string[] {
  if ((value === undefined || value === null) && optional) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw manifestError("lifecycle_field_invalid", `${label} must be a list of non-empty strings`, { label, value });
  if (new Set(value).size !== value.length) throw manifestError("lifecycle_field_duplicate", `${label} contains a duplicate`, { label, value });
  return value as string[];
}

function digestSource(kind: LifecycleSourceDigest["kind"], path: string): LifecycleSourceDigest {
  return { kind, path, sha256: sha256(readFileSync(path)) };
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Mapping).sort(([a], [b]) => a.localeCompare(b, "en-US")).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function manifestError(code: string, message: string, details?: Record<string, unknown>): WorkflowSpecError {
  return new WorkflowSpecError(code, message, details);
}
