import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { resolveWorkNodeDirs } from "../current-work.js";
import { parseFrontmatter } from "../slices/slice-indexer.js";
import type { HealthRecord } from "../health-projection.js";
import type { RigModeStore } from "./rig-mode-store.js";
import { missionModeQualifier, type OperatorContextReadContext, type OperatorContextScope } from "./rig-mode-types.js";
import { validateModeName, validateRecord } from "./rig-mode-validator.js";
import { selectCatalogProject } from "../workspace/project-catalog.js";
import type { SettingsStore } from "../user-settings/settings-store.js";

/** Production wiring for the catalogPath callback: an explicitly configured
 *  workspace.catalog_path (env or config file). When it's only the derived
 *  default, return undefined so the service keeps its own default,
 *  <real workspace>/workspace.yaml: a relative project root such as ../gamma then
 *  resolves beside the real workspace folder even when workspace.root is a symlink. */
export function configuredCatalogPath(settings: Pick<SettingsStore, "resolveOne">): () => string | undefined {
  return () => {
    const setting = settings.resolveOne("workspace.catalog_path");
    return setting.source !== "default" && typeof setting.value === "string" && setting.value ? setting.value : undefined;
  };
}

export interface OperatingContext extends OperatorContextReadContext {
  phase: { value: string | null; source: string | null };
  sources: string[];
  paths?: { project: string; mission?: string; workstream?: string };
}
export interface OperatingPosture {
  posture: "human-led" | "delegated" | "unknown";
  source: "product-default" | "binding" | "unknown";
  context: OperatingContext | null;
  binding: { id: string; scope: OperatorContextScope; setAt: string; evidence: string } | null;
  reason: string;
  grantsAuthority: false;
  members?: Array<{ qitemId: string; posture: string; source: string; bindingId: string | null }>;
}

const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function requiredSegment(value: string, label: string): string {
  if (!segment.test(value)) throw new Error(label + " must be one bounded identity segment");
  return value;
}
function yamlFile(path: string, optional = false): Record<string, any> | null {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (bytes.length > 65536) throw new Error("scope source exceeds 64 KiB: " + path);
  const data = parseYaml(bytes.toString());
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid scope source: " + path);
  return data;
}
function inside(root: string, path: string): string {
  const actual = realpathSync(path), rel = relative(realpathSync(root), actual);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("scope escapes its project: " + path);
  return actual;
}
function unknown(reason: string, context: OperatingContext | null = null): OperatingPosture {
  return { posture: "unknown", source: "unknown", context, binding: null, reason, grantsAuthority: false };
}

/** One reader over existing mode bindings, queue/workflow identities, and authored work nodes.
 * Preferences never create authorization, rewrite phase, or modify health policy. */
export class OperatingPostureService {
  constructor(private readonly db: Database.Database, private readonly modes: RigModeStore,
    private readonly workspaceRoot: () => string,
    /** Configured workspace.catalog_path; <workspace>/workspace.yaml when unset. */
    private readonly catalogPath?: () => string | undefined) {}

  context(input: OperatorContextReadContext): OperatingContext {
    const ctx: OperatingContext = { ...input, phase: { value: null, source: null }, sources: [] };
    const rigIdentity = (value: string) => {
      const rigs = this.db.prepare("SELECT id FROM rigs WHERE id = ? OR name = ?").all(value, value) as Array<{ id: string }>;
      if (rigs.length !== 1) throw new Error("rig identity missing or ambiguous: " + value);
      return rigs[0]!.id;
    };
    for (const value of Object.values(input)) if (value !== undefined && !value.trim()) throw new Error("empty scope identity");
    if (ctx.rigId) ctx.rigId = rigIdentity(ctx.rigId);
    const merge = (key: keyof OperatorContextReadContext, value: unknown, source: string) => {
      if (value === undefined || value === null) return;
      if (typeof value !== "string" || !value.trim()) throw new Error("invalid " + key + " from " + source);
      if (key === "rigId") value = rigIdentity(value);
      if (ctx[key] && ctx[key] !== value) throw new Error("conflicting " + key + " from " + source);
      ctx[key] = value as string; ctx.sources.push(source);
    };
    if (ctx.workstreamId?.includes("/")) {
      const parts = ctx.workstreamId.split("/");
      if (parts.length !== 3) throw new Error("use project/mission/slice-id workstream identity");
      merge("projectId", parts[0], "workstream qualifier"); merge("missionId", parts[1], "workstream qualifier");
      ctx.workstreamId = parts[2];
    }
    if (ctx.qitemId) {
      const row = this.db.prepare("SELECT tags, destination_session FROM queue_items WHERE qitem_id = ?").get(ctx.qitemId) as { tags: string | null; destination_session: string } | undefined;
      if (!row) throw new Error("qitem not found: " + ctx.qitemId);
      const tags: unknown = JSON.parse(row.tags ?? "[]");
      if (!Array.isArray(tags) || tags.some(t => typeof t !== "string")) throw new Error("invalid qitem tags");
      for (const [prefix, key] of [["project:", "projectId"], ["mission:", "missionId"], ["slice:", "workstreamId"], ["workstream:", "workstreamId"]] as const) {
        for (const tag of tags.filter((t: string) => t.startsWith(prefix))) merge(key, tag.slice(prefix.length), "queue:" + ctx.qitemId + "/" + prefix);
      }
      const workflows = this.db.prepare("SELECT f.step_id, i.instance_id, i.bound_rig, i.lifecycle_binding_json FROM workflow_frontier_bindings f JOIN workflow_instances i ON i.instance_id = f.instance_id WHERE f.packet_id = ?")
        .all(ctx.qitemId) as Array<{ step_id: string; instance_id: string; bound_rig: string | null; lifecycle_binding_json: string | null }>;
      if (workflows.length > 1) throw new Error("ambiguous workflow membership");
      const workflow = workflows[0];
      if (workflow) {
        const binding = JSON.parse(workflow.lifecycle_binding_json ?? "null");
        merge("projectId", binding?.identity?.project, "workflow:" + workflow.instance_id);
        merge("missionId", binding?.identity?.mission, "workflow:" + workflow.instance_id);
        merge("rigId", workflow.bound_rig, "workflow:" + workflow.instance_id);
        ctx.phase = { value: workflow.step_id, source: "workflow:" + workflow.instance_id + "/frontier/" + ctx.qitemId };
      }
      if (row.destination_session.includes("@")) merge("rigId", row.destination_session.slice(row.destination_session.lastIndexOf("@") + 1), "queue:" + ctx.qitemId + "/destination");
      if (!ctx.projectId && !ctx.missionId) throw new Error("qitem project/mission linkage is missing");
    }
    if (ctx.rigId) {
      ctx.sources.push("rig:" + ctx.rigId);
    }
    if (ctx.projectId || ctx.missionId || ctx.workstreamId) {
      const workspace = realpathSync(this.workspaceRoot());
      // The same catalog and reader as work-install and the project reads.
      const catalogPath = this.catalogPath?.() || join(workspace, "workspace.yaml");
      let projectRoot = workspace;
      const selected = selectCatalogProject(catalogPath, ctx.projectId);
      if (selected) {
        if (!ctx.projectId) ctx.projectId = selected.id;
        projectRoot = selected.root;
        ctx.sources.push(catalogPath);
      }
      const projectPath = join(projectRoot, "project.yaml");
      const project = yamlFile(projectPath)!;
      const projectId = project.metadata?.id ?? project.metadata?.name ?? project.project;
      merge("projectId", projectId, projectPath);
      if (!ctx.projectId) throw new Error("project identity missing");
      requiredSegment(ctx.projectId, "project");
      ctx.paths = { project: projectRoot };
      if (ctx.workstreamId && !ctx.missionId) throw new Error("workstream needs project/mission identity");
      if (ctx.missionId) {
        requiredSegment(ctx.missionId, "mission");
        const missions = inside(projectRoot, resolve(projectRoot, project.missions?.root ?? "missions"));
        const matches = resolveWorkNodeDirs(missions, ctx.missionId);
        if (matches.length !== 1) throw new Error("mission identity missing or ambiguous: " + ctx.missionId);
        ctx.missionId = matches[0]!.dir;
        const missionRoot = inside(projectRoot, join(missions, ctx.missionId));
        ctx.paths.mission = missionRoot;
        const missionPath = join(missionRoot, "mission.yaml");
        const mission = yamlFile(missionPath)!;
        if (mission.metadata?.name && mission.metadata.name !== ctx.missionId) throw new Error("mission manifest identity conflicts with directory");
        const phase = mission.release?.phase ?? mission.metadata?.status;
        if (typeof phase !== "string" || !phase) throw new Error("mission phase/status missing");
        if (!ctx.phase.value) ctx.phase = { value: phase, source: missionPath };
        ctx.sources.push(missionPath);
        if (ctx.workstreamId) {
          requiredSegment(ctx.workstreamId, "workstream");
          const slices = inside(projectRoot, join(missionRoot, "slices"));
          const matches = resolveWorkNodeDirs(slices, ctx.workstreamId);
          if (matches.length !== 1) throw new Error("workstream must resolve to one authored slice");
          const specPath = join(inside(projectRoot, join(slices, matches[0]!.dir)), "SPEC.md");
          ctx.paths.workstream = dirname(specPath);
          const spec = readFileSync(specPath, "utf8");
          if (Buffer.byteLength(spec) > 65536) throw new Error("slice source exceeds 64 KiB");
          const fm = parseFrontmatter(spec);
          if (typeof fm.id !== "string" || !fm.id) throw new Error("slice identity missing");
          requiredSegment(fm.id, "slice");
          if (fm.mission && fm.mission !== ctx.missionId) throw new Error("slice mission identity conflicts");
          // The workstream is the existing authored work node, qualified by its project and mission.
          ctx.workstreamId = ctx.projectId + "/" + ctx.missionId + "/" + fm.id;
          if (!ctx.phase.source?.startsWith("workflow:")) ctx.phase = { value: typeof fm.stage === "string" ? fm.stage : typeof fm.status === "string" ? fm.status : null, source: specPath };
          ctx.sources.push(specPath);
        }
      }
    }
    if (!ctx.rigId && !ctx.projectId) throw new Error("select an exact rig or project/work scope");
    return ctx;
  }

  resolve(input: OperatorContextReadContext): OperatingPosture {
    let context: OperatingContext | null = null;
    try {
      context = this.context(input);
      const resolved = this.modes.resolveEffective(context, ["human-led", "delegated"]);
      if (!resolved) return { posture: "human-led", source: "product-default", context, binding: null,
        reason: "No explicit operating posture at this resolved scope; the product default is human-led.", grantsAuthority: false };
      const b = resolved.binding;
      if (!validateModeName(b.mode).ok || !validateRecord(b.record).ok) throw new Error("stored mode binding is invalid");
      return { posture: b.mode as "human-led" | "delegated", source: "binding", context,
        binding: { id: b.id, scope: resolved.resolvedScope, setAt: b.setAt, evidence: b.record.evidence_citation },
        reason: "Explicit operating posture at the most specific applicable scope.", grantsAuthority: false };
    } catch (error) { return unknown(String(error), context); }
  }

  /** Canonicalize only deliberate operating-posture writes; legacy ergonomic modes keep their contract. */
  target(scope: OperatorContextScope, qualifier: string | null): string | null {
    if (scope === "global_host") return null;
    const parts = (qualifier ?? "").split("/");
    const input: OperatorContextReadContext = scope === "rig" ? { rigId: qualifier! }
      : scope === "project" ? { projectId: qualifier! }
      : scope === "qitem" ? { qitemId: qualifier! }
      : { projectId: parts[0], missionId: parts[1], ...(scope === "workstream" ? { workstreamId: parts[2] } : {}) };
    if (scope === "mission" && parts.length !== 2 || scope === "workstream" && parts.length !== 3) throw new Error("use project/mission[/slice-id] qualifier");
    const ctx = this.context(input);
    if (scope === "rig") return ctx.rigId!;
    if (scope === "project") return ctx.projectId!;
    if (scope === "mission") return missionModeQualifier(ctx.projectId!, ctx.missionId!);
    if (scope === "workstream") return ctx.workstreamId!;
    return ctx.qitemId!;
  }

  forHealth(record: HealthRecord): OperatingPosture {
    const scope = record.scope;
    const input: OperatorContextReadContext = scope.type === "mission" || scope.type === "slice"
      ? { projectId: scope.projectId, missionId: scope.missionId, ...(scope.type === "slice" ? { workstreamId: scope.sliceId } : {}) }
      : scope.type === "rig" || scope.type === "seat" ? { rigId: scope.rigId } : {};
    const ids = [...new Set(record.evidence.flatMap(e => e.type === "queue-transition" ? [e.qitemId] : []))];
    if (record.ceremony?.lineageId && !ids.includes(record.ceremony.lineageId)) ids.push(record.ceremony.lineageId);
    if (!ids.length) return this.resolve(input);
    const results = ids.map(qitemId => ({ qitemId, result: this.resolve({ ...input, qitemId }) }));
    const members = results.map(({ qitemId, result }) => ({ qitemId, posture: result.posture, source: result.source, bindingId: result.binding?.id ?? null }));
    const unresolved = results.find(r => r.result.posture === "unknown");
    if (unresolved) return { ...unknown(unresolved.qitemId + ": " + unresolved.result.reason, unresolved.result.context), members };
    if (new Set(results.map(r => r.result.posture)).size !== 1) return { ...unknown("Finding spans different operating postures; inspect its exact members."), members };
    if (new Set(results.map(r => JSON.stringify([r.result.context?.projectId, r.result.context?.missionId, r.result.context?.workstreamId]))).size !== 1)
      return { ...unknown("Finding spans different work contexts; no single project authority is selected."), members };
    return { ...results[0]!.result, members, reason: "All finding members resolve to " + results[0]!.result.posture + "; binding/source above describe the first member. Inspect members for each source." };
  }
}
