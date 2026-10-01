import { JudgmentError, readMissionReadiness, resolveProjectRoot, type MissionReadiness } from "./proof/judgments.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import type { WorkflowSpec, WorkflowStepSpec } from "./workflow-types.js";
import { WorkflowSpecError, parseWorkflowSpec } from "./workflow-spec-cache.js";
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

export interface LifecycleGraphSource {
  mode: "project-profile" | "mission-extend" | "mission-override" | "legacy-mission" | "legacy-slices";
  profileSource: string | null;
  missionSource: string | null;
  requiredSteps: string[];
}

export interface LifecycleCompilation {
  readiness: MissionReadiness;
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
  graphSource: LifecycleGraphSource;
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
  let workspaceRoot = dirname(dirname(missionDir));
  try {
    workspaceRoot = resolveProjectRoot(missionDir);
  } catch (error) {
    if (!(error instanceof JudgmentError) || error.code !== "project_missing") throw error;
    // Let readManifest preserve the lifecycle's structured missing-project error.
  }
  const projectPath = join(workspaceRoot, "project.yaml");
  const project = readManifest(projectPath, "project");
  const mission = readManifest(missionPath, "mission");
  const projectId = requiredString(asMapping(project.metadata, `${projectPath}: metadata`).id, `${projectPath}: metadata.id`);
  const missionName = requiredString(asMapping(mission.metadata, `${missionPath}: metadata`).name, `${missionPath}: metadata.name`);
  const lifecycle = asMapping(project.lifecycle, `${projectPath}: lifecycle`, true);
  if (lifecycle) knownKeys(lifecycle, ["profile", "profiles", "public_owner", "retention"], `${projectPath}: lifecycle`);
  const lifecycleProfile = optionalString(lifecycle?.profile, `${projectPath}: lifecycle.profile`);
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
  const boundary = asMapping(mission.lifecycle, `${missionPath}: lifecycle`, true);
  if (boundary) {
    knownKeys(boundary, ["profile", "mode", "workflow"], `${missionPath}: lifecycle`);
    if (requiredString(boundary.profile, `${missionPath}: lifecycle.profile`) !== lifecycleProfile) {
      throw manifestError("lifecycle_profile_mismatch", "Mission lifecycle.profile must match the profile selected by project.yaml");
    }
  }
  const projectRefs = stringList(asMapping(project.install, `${projectPath}: install`, true)?.context, `${projectPath}: install.context`, true);
  const commonRefs = [projectPath, missionPath, ...projectRefs.map((ref) => address(workspaceRoot, ref))];
  const parseBoundary = (workflow: Mapping, path: string, root: string): WorkflowSpec => parseWorkflowSpec(stringify({ workflow: {
    id: `lifecycle-${projectId}-${missionName}`, version: "1", ...workflow,
    steps: Array.isArray(workflow.steps) ? workflow.steps.map((step: Mapping) => {
      if (!step || !Array.isArray(step.allowed_exits) || !step.allowed_exits.includes("waiting")) return step;
      const initial = step.re_present_after_seconds ?? 300;
      return { ...step, re_present_after_seconds: initial,
        re_present_max_seconds: step.re_present_max_seconds ?? Math.max(3600, typeof initial === "number" ? initial : 300) };
    }) : workflow.steps,
    context_refs: [...new Set([...commonRefs, ...stringList(workflow.context_refs, `${path}.context_refs`, true).map((ref) => address(root, ref))])],
  } }), path);

  const graphSource: LifecycleGraphSource = {
    mode: "legacy-slices", profileSource: null, missionSource: null, requiredSteps: [],
  };
  let authoredBoundary: WorkflowSpec | null = null;
  if (lifecycle && Object.hasOwn(lifecycle, "profiles")) {
    const profiles = asMapping(lifecycle.profiles, `${projectPath}: lifecycle.profiles`);
    if (!lifecycleProfile || !Object.hasOwn(profiles, lifecycleProfile)) {
      throw manifestError("lifecycle_profile_not_found", "project.lifecycle.profile must select an existing lifecycle.profiles entry");
    }
    const source = `${projectPath}#lifecycle.profiles.${lifecycleProfile}`;
    const profile = asMapping(profiles[lifecycleProfile], source);
    knownKeys(profile, ["required_steps", "workflow"], source);
    const required = stringList(profile.required_steps, `${source}.required_steps`);
    if (required.length === 0) throw manifestError("lifecycle_required_steps_empty", `${source}: required_steps must name the boundary obligations`);
    const base = parseBoundary(asMapping(profile.workflow, `${source}.workflow`), `${source}.workflow`, workspaceRoot);
    validateObligations(base, required);
    authoredBoundary = base;
    Object.assign(graphSource, { mode: "project-profile", profileSource: source, requiredSteps: required });
    if (boundary && (Object.hasOwn(boundary, "workflow") || Object.hasOwn(boundary, "mode"))) {
      if (boundary.mode !== "extend" && boundary.mode !== "override") {
        throw manifestError("lifecycle_override_ambiguous", "Mission lifecycle.workflow over a project profile requires mode: extend or override");
      }
      const addition = asMapping(boundary.workflow, `${missionPath}: lifecycle.workflow`);
      const missionSource = `${missionPath}#lifecycle.workflow`;
      if (boundary.mode === "extend") {
        knownKeys(addition, ["steps", "roles", "context_refs"], missionSource);
        if (!Array.isArray(addition.steps)) throw manifestError("lifecycle_extension_invalid", "An extension must declare a steps list");
        const ids = new Set(base.steps.map((step) => step.id));
        if (addition.steps.some((step) => ids.has(asMapping(step, missionSource).id as string))) {
          throw manifestError("lifecycle_extension_collision", "An extension cannot replace an inherited step; use explicit mode: override");
        }
        authoredBoundary = parseBoundary({ ...base, ...addition,
          roles: { ...base.roles, ...asMapping(addition.roles, `${missionSource}.roles`, true) },
          steps: [...base.steps, ...addition.steps],
          context_refs: [...new Set([...(base.context_refs ?? []), ...stringList(addition.context_refs, `${missionSource}.context_refs`, true).map((ref) => address(missionDir, ref))])],
        }, missionSource, missionDir);
      } else {
        authoredBoundary = parseBoundary({ ...addition,
          context_refs: [...new Set([...(base.context_refs ?? []), ...stringList(addition.context_refs, `${missionSource}.context_refs`, true).map((ref) => address(missionDir, ref))])],
        }, missionSource, missionDir);
      }
      validateObligations(authoredBoundary, required, base);
      Object.assign(graphSource, { mode: `mission-${boundary.mode}`, missionSource });
    }
  } else if (boundary) {
    if (Object.hasOwn(boundary, "mode")) throw manifestError("lifecycle_override_without_profile", "Mission mode requires a project-owned profile graph");
    authoredBoundary = parseBoundary(asMapping(boundary.workflow, `${missionPath}: lifecycle.workflow`), `${missionPath}#lifecycle.workflow`, missionDir);
    Object.assign(graphSource, { mode: "legacy-mission", missionSource: `${missionPath}#lifecycle.workflow` });
  }
  if (!graphSource.profileSource) advisories.push("Legacy lifecycle: no project-owned profile graph is selected; only the authored mission or slice graph applies.");

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

    // A mission boundary is explicitly authored; slice SDLC never manufactures its steps.
    if (authoredBoundary || !member.active) return;
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
  if (authoredBoundary) steps.push(...authoredBoundary.steps);
  if (steps.length === 0) unknowns.push("no active slice declares an execution contract; author mission.lifecycle for an independent mission boundary");
  if (steps.length > 0 && steps.every((step) => (step.depends_on ?? []).length > 0)) {
    unknowns.push("execution graph has no root step");
  }
  const draftWorkflowSpec: WorkflowSpec | null = authoredBoundary ?? (steps.length > 0
    ? {
        id: `lifecycle-${projectId}-${missionName}`,
        version: "1",
        objective: `Compiled lifecycle for ${projectId}/${missionName}`,
        entry: { role: steps.find((step) => (step.depends_on ?? []).length === 0)?.actor_role },
        roles,
        steps,
      }
    : null);
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
    readiness: readMissionReadiness(missionDir),
    version: 1,
    eligible: workflowSpec !== null && unknowns.length === 0,
    identity: { project: projectId, mission: missionName, lifecycleProfile },
    operationKeyInput: input.operationKey ?? null,
    compiledInputDigest,
    sources,
    graphSource,
    dependencies: steps.map((step) => ({ stepId: step.id, dependsOn: step.depends_on ?? [] })),
    workflowSpec,
    advisories,
    unknowns,
  };
}

function address(root: string, ref: string): string {
  return /^(?:[a-z]+:|\$|\/)/i.test(ref) ? ref : resolve(root, ref);
}

function knownKeys(mapping: Mapping, allowed: string[], source: string): void {
  for (const key of Object.keys(mapping)) {
    if (!allowed.includes(key)) throw manifestError("lifecycle_boundary_unknown_key", `${source}: unknown key ${key}`);
  }
}

/** Required IDs and their ordering are authored policy, not daemon receipt interpretation. */
function validateObligations(spec: WorkflowSpec, required: string[], base?: WorkflowSpec): void {
  const byId = new Map(spec.steps.map((step) => [step.id, step]));
  const missing = required.filter((id) => !byId.has(id));
  if (missing.length) throw manifestError("lifecycle_required_step_missing", `Missing required boundary steps: ${missing.join(", ")}`, { missing });
  // A dependency graph cannot take a conditional jump around its required obligations.
  for (const step of spec.steps) {
    if (step.depends_on === undefined || step.next_hop?.on) {
      throw manifestError("lifecycle_boundary_graph_invalid", `Boundary step ${step.id} must use depends_on, without conditional next_hop.on edges`);
    }
  }
  const ancestors = (steps: WorkflowStepSpec[], id: string, seen = new Set<string>()): Set<string> => {
    for (const parent of steps.find((step) => step.id === id)?.depends_on ?? []) {
      if (!seen.has(parent)) { seen.add(parent); ancestors(steps, parent, seen); }
    }
    return seen;
  };
  if (base) for (const id of required) {
    const before = ancestors(base.steps, id);
    const after = ancestors(spec.steps, id);
    const lost = required.filter((parent) => before.has(parent) && !after.has(parent));
    if (lost.length) throw manifestError("lifecycle_required_order_changed", `Required step ${id} lost prerequisites: ${lost.join(", ")}`, { stepId: id, missing: lost });
  }
}

function resolveManifest(input: string, file: string): string {
  const candidate = resolve(input);
  const path = existsSync(candidate) && lstatSync(candidate).isDirectory() ? join(candidate, file) : candidate;
  // Canonicalize parent aliases (e.g. macOS /var -> /private/var) without
  // erasing the existing refusal for a manifest that is itself a symlink.
  return existsSync(path) && !lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
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
