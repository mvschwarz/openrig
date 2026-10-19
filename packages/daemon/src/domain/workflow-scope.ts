// A workflow instance's scope: the project / mission / slice it works for, plus
// free-form tags. Stored on the instance (workflow_instances.scope_json) and
// stamped on every packet the instance creates, so the Projects view's slice
// Queue tab (exact project:<id> + slice:<id> match) lists them.

import type Database from "better-sqlite3";
import { detectInstanceColumn } from "./workflow-instance-store.js";

export interface WorkflowScope {
  project?: string;
  mission?: string;
  slice?: string;
  /** Free-form tags, scope-key tags (project:/mission:/slice:) excluded. */
  tags?: string[];
  /** Lifecycle instances: step id -> slice directory name, the slice a step's packets belong to.
   *  The Queue tab keys on the directory name, which is not always the step id. */
  stepSlices?: Record<string, string>;
}

export class WorkflowScopeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "WorkflowScopeError";
  }
}

// Same id shapes the project and slice routes accept.
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCOPE_KEYS = ["project", "mission", "slice"] as const;
type ScopeKey = (typeof SCOPE_KEYS)[number];
const KEY_PATTERN: Record<ScopeKey, RegExp> = { project: PROJECT_ID, mission: NODE_ID, slice: NODE_ID };

/** Tags the workflow system writes on its own packets. The runtime reads
 *  `instance:` and `workflow:` back off packets to route them, so a caller
 *  tag must never collide with any of these. */
const RESERVED_TAGS = new Set(["workflow", "handoff", "gate", "entry", "resume", "re-route", "workflow-exception"]);
const RESERVED_PREFIXES = ["workflow:", "instance:", "step:", "exception:", "occurrence:", "recovery-for:"];

function refuse(code: string, message: string): never {
  throw new WorkflowScopeError(code, message);
}

export function normalizeWorkflowScope(input: {
  project?: unknown;
  mission?: unknown;
  slice?: unknown;
  tags?: unknown;
  stepSlices?: Record<string, string>;
}): WorkflowScope | null {
  const scope: Partial<Record<ScopeKey, string>> = {};
  for (const key of SCOPE_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") refuse("scope_id_invalid", `${key} must be a string`);
    if (!KEY_PATTERN[key].test(value)) refuse("scope_id_invalid", `--${key} "${value}" is not a valid ${key} id (letters, digits, . _ -; must start with a letter or digit)`);
    scope[key] = value;
  }
  const flagged = { ...scope };
  const tags: string[] = [];
  if (input.tags !== undefined && input.tags !== null && !Array.isArray(input.tags)) {
    refuse("scope_tag_invalid", "tags must be an array of strings");
  }
  for (const raw of (input.tags ?? []) as unknown[]) {
    if (typeof raw !== "string") refuse("scope_tag_invalid", "tags must be an array of strings");
    const tag = raw.trim();
    if (!tag) continue;
    if (/[\s,]/.test(tag)) refuse("scope_tag_invalid", `tag "${tag}" contains whitespace or a comma, which queue readers split on`);
    const key = SCOPE_KEYS.find((k) => tag.startsWith(`${k}:`));
    if (key) {
      const value = tag.slice(key.length + 1);
      if (!KEY_PATTERN[key].test(value)) refuse("scope_tag_invalid", `tag "${tag}" does not carry a valid ${key} id`);
      if (flagged[key] !== undefined && flagged[key] !== value) {
        refuse("scope_tag_contradiction", `tag "${tag}" contradicts --${key} ${flagged[key]}`);
      }
      if (scope[key] !== undefined && scope[key] !== value) {
        refuse("scope_tag_duplicate_key", `more than one ${key}: value given (${scope[key]}, ${value}); a packet carries one`);
      }
      scope[key] = value;
      continue;
    }
    if (RESERVED_TAGS.has(tag) || RESERVED_PREFIXES.some((p) => tag.startsWith(p))) {
      refuse("scope_tag_reserved", `tag "${tag}" is reserved: the workflow system writes it on its own packets and reads it back to route them`);
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  const stepSlices = input.stepSlices && Object.keys(input.stepSlices).length > 0 ? input.stepSlices : undefined;
  if (Object.keys(scope).length === 0 && tags.length === 0 && !stepSlices) return null;
  return { ...scope, ...(tags.length > 0 ? { tags } : {}), ...(stepSlices ? { stepSlices } : {}) };
}

/** The tags stamped on a packet: scope keys first (project, mission, slice), free-form tags after.
 *  `stepSlice` supplies the slice when the scope names none (a lifecycle step). */
export function workflowScopeTags(scope: WorkflowScope | null | undefined, stepSlice?: string | null): string[] {
  const slice = scope?.slice ?? stepSlice ?? undefined;
  const out: string[] = [];
  if (scope?.project) out.push(`project:${scope.project}`);
  if (scope?.mission) out.push(`mission:${scope.mission}`);
  if (slice) out.push(`slice:${slice}`);
  for (const tag of scope?.tags ?? []) if (!out.includes(tag)) out.push(tag);
  return out;
}

/** The tags for a packet of `stepId`. A lifecycle step that is a slice carries its slice directory name; a step that
 *  matches no active slice (an authored closing step, one a revision adds) carries project and mission only. */
export function packetScopeTags(instance: { scope?: WorkflowScope | null }, stepId: string | null | undefined): string[] {
  const slices = instance.scope?.stepSlices;
  // Own keys only: a step named `constructor` or `__proto__` must not read an inherited property.
  return workflowScopeTags(instance.scope, stepId && slices && Object.hasOwn(slices, stepId) ? slices[stepId] : null);
}

export const isProjectId = (value: string): boolean => PROJECT_ID.test(value);
export const isNodeId = (value: string): boolean => NODE_ID.test(value);

/** The scope of a compiled lifecycle instance. Project and mission are identities the compiler inferred from the
 *  manifests, not user input, so one that cannot be a tag is left out (and reported) rather than refused. */
export function lifecycleScope(
  identity: { project: string; mission: string },
  stepSlices: Record<string, string>,
): WorkflowScope | null {
  return normalizeWorkflowScope({
    ...(isProjectId(identity.project) ? { project: identity.project } : {}),
    ...(isNodeId(identity.mission) ? { mission: identity.mission } : {}),
    stepSlices,
  });
}

/** Advisories for inferred identities and slice directories that cannot be written as a packet tag. */
export function lifecycleScopeAdvisories(identity: { project: string; mission: string }): string[] {
  const out: string[] = [];
  if (!isProjectId(identity.project)) out.push(`project id "${identity.project}" cannot be a packet tag (letters, digits, . _ -; must start with a letter or digit; at most 64 characters); packets carry no project: tag`);
  if (!isNodeId(identity.mission)) out.push(`mission name "${identity.mission}" cannot be a packet tag (letters, digits, . _ -; must start with a letter or digit; at most 128 characters); packets carry no mission: tag`);
  return out;
}

/** Read an instance's scope straight from the row (for code that holds only the db).
 *  Fixture databases that skip the canonical migrations have no scope column and read as unscoped. Anything else that
 *  fails (the column probe, the query, malformed scope_json) propagates, as it does on the store's read path. */
export function readInstanceScope(db: Database.Database, instanceId: string): { scope: WorkflowScope | null } {
  if (!detectInstanceColumn(db, "scope_json", { strict: true })) return { scope: null };
  const row = db.prepare(`SELECT scope_json FROM workflow_instances WHERE instance_id = ?`).get(instanceId) as { scope_json: string | null } | undefined;
  return { scope: row?.scope_json ? (JSON.parse(row.scope_json) as WorkflowScope) : null };
}
