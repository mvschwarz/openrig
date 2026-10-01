import { Hono } from "hono";
import { proofSourceObservation } from "../domain/proof/source-watch.js";
import * as path from "node:path";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";
import type { EventBus } from "../domain/event-bus.js";
import { JudgmentError, evidenceAt, readSliceReadiness, readMissionReadiness, readProjectReadiness, recordJudgment, resolveProofScope, type JudgeInput } from "../domain/proof/judgments.js";
import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";
import { projectById } from "../domain/workspace/project-read.js";
import { ProjectReadError } from "../domain/workspace/project-catalog.js";

// #132 — `<project-id>:<scope>` names a scope inside one workspace-catalog project. Project ids share the
// catalog's id grammar, which cannot contain "/", so an ordinary mission/slice path never matches. A Windows
// absolute path (`C:\\…`, `C:/…`) is never project-qualified, even though `C` would fit the grammar. Nor is a
// scope that already exists as written: a mission folder may contain a colon (`alpha:trial/slices/01-t001`), and
// such paths keep resolving as they always have. The prefix qualifies only when it names a catalogued project.
const QUALIFIED_SCOPE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63}):(.*)$/;

export function proofRoutes(): Hono {
  const app = new Hono();
  app.onError((e, c) => {
    if (e instanceof JudgmentError) return c.json({ error: e.code, message: e.message }, e.status as 400);
    return c.json({ error: "proof_unavailable", message: e.message }, 503);
  });
  const indexer = (c: { get: (key: never) => unknown }): SliceIndexer => {
    const value = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    if (!value?.isReady()) throw new JudgmentError("workspace_unavailable", "Configure the daemon workspace before reading or recording judgments", 503);
    return value;
  };
  /**
   * The missions root a proof read/judgment resolves against. Unqualified scopes keep the daemon's
   * selected workspace (`workspace.slices_root`). A project named by `--project`/`project` or by a
   * `<project-id>:` scope prefix resolves through the workspace catalog entry's root and missions root,
   * so contained() is then applied per project root.
   */
  /** Whether `scope` names an existing directory, as written, under `root` (never outside it). */
  const existsAt = (root: string | null, scope: string) => {
    if (!root) return false;
    try { resolveProofScope(root, scope); return true; } catch { return false; }
  };
  /** A catalog project by id, or null when the catalog has no such project (other catalog failures still throw). */
  const catalogued = (c: Parameters<typeof indexer>[0], id: string) => {
    try { return projectById(c, id); }
    catch (e) { if (e instanceof ProjectReadError && (e.code === "project_not_found" || e.code === "invalid_project")) return null; throw e; }
  };
  const workspaceRoot = (c: Parameters<typeof indexer>[0]) => {
    const value = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    return value?.isReady() ? value.slicesRoot : null;
  };
  const target = (c: Parameters<typeof indexer>[0], rawScope: string | undefined, project: unknown, expectedRoot?: unknown) => {
    if (project !== undefined && typeof project !== "string") throw new JudgmentError("judgment_invalid", "Project must be a catalog project id");
    if (expectedRoot !== undefined && typeof expectedRoot !== "string") throw new JudgmentError("judgment_invalid", "projectRoot must be the root a prepared read returned");
    let qualified = rawScope === undefined || path.win32.isAbsolute(rawScope) ? null : QUALIFIED_SCOPE.exec(rawScope);
    if (qualified) {
      // The literal path wins where it exists: under the named project (--project) or else the selected workspace.
      const flagged = project !== undefined ? catalogued(c, project) : null;
      const literalRoot = flagged ? flagged.missionsRoot : project === undefined ? workspaceRoot(c) : null;
      if (existsAt(literalRoot, rawScope!) || !catalogued(c, qualified[1]!)) qualified = null;
    }
    const id = qualified?.[1] ?? project;
    if (qualified && project !== undefined && project !== qualified[1]) throw new JudgmentError("project_conflict", `Scope names project ${qualified[1]} but --project names ${project}; select one project`);
    const scope = qualified ? qualified[2]! : rawScope;
    if (id === undefined) { const owner = indexer(c); return { root: owner.slicesRoot, evidenceRoot: path.dirname(owner.slicesRoot), scope, owner, project: null }; }
    // Evidence is prepared against the project root (where project.yaml lives), the same root recordJudgment derives,
    // so prepared references still match at judgment time under a nested authored missions.root.
    let p: ReturnType<typeof projectById>;
    try { p = projectById(c, id); }
    catch (e) {
      if (!(e instanceof ProjectReadError)) throw e;
      throw new JudgmentError(e.code, e.message, e.code === "project_not_found" ? 404 : e.code === "invalid_project" ? 400 : 409);
    }
    // A judgment carries the root its prepared read resolved: if the catalog now maps the id elsewhere, refuse
    // rather than record against a different project.
    if (typeof expectedRoot === "string" && expectedRoot !== p.root) throw new JudgmentError("project_changed", `Project ${id} now resolves to ${p.root}, not the ${expectedRoot} the prepared read used; read the proof again`, 409);
    return { root: p.missionsRoot, evidenceRoot: p.root, scope, owner: null, project: { id: p.id, root: p.root } };
  };
  // Catalog-project reads have no source watcher (it observes the daemon's selected workspace only), so their
  // freshness is reported as unverified rather than borrowing the selected workspace's state.
  const observation = (c: Parameters<typeof indexer>[0], project: { id: string; root: string } | null) =>
    project ? { state: "unavailable" as const, revision: "unverified" } : proofSourceObservation(c);
  app.get("/", c => {
    const { root, evidenceRoot, scope, project } = target(c, c.req.query("scope"), c.req.query("project"), c.req.query("projectRoot"));
    const common = { sourceObservation: observation(c, project), ...(project ? { project } : {}) };
    // A catalog project's own root bounds policy, scope identity and evidence (never an ancestor's project.yaml).
    const bound = project?.root;
    if (!scope) return c.json({ ...readProjectReadiness(root, undefined, bound), ...common });
    const dir = resolveProofScope(root, scope);
    if (path.basename(path.dirname(dir)) !== "slices") return c.json({ ...readMissionReadiness(dir, undefined, bound), ...common });
    const refs = c.req.queries("evidence") ?? [];
    return c.json({ ...readSliceReadiness(dir, undefined, undefined, bound), ...common, ...(refs.length ? { preparedEvidence: refs.map(ref => evidenceAt(evidenceRoot, dir, ref)) } : {}) });
  });
  app.post("/judge", async c => {
    const body = await c.req.json<JudgeInput & { actorSession?: string; project?: string; projectRoot?: string }>().catch(() => null);
    if (!body || typeof body.scope !== "string" || typeof body.item !== "string" || typeof body.expectedRevision !== "string" || !(body.expectedPrevious === null || typeof body.expectedPrevious === "string") || (body.evidence !== undefined && (!Array.isArray(body.evidence) || body.evidence.some(e => typeof e !== "string")))) throw new JudgmentError("judgment_invalid", "Provide scope, item, expected revision/predecessor and evidence references; rig proof judge resolves these in the ordinary path");
    if ((body.actorSession !== undefined && typeof body.actorSession !== "string") || typeof body.reason !== "string" || (body.operationId !== undefined && (typeof body.operationId !== "string" || !body.operationId.trim())) || (body.subject !== undefined && (!body.subject || typeof body.subject !== "object" || typeof body.subject.kind !== "string" || typeof body.subject.ref !== "string")) || (body.replace !== undefined && typeof body.replace !== "boolean")) throw new JudgmentError("judgment_invalid", "Reason, operation identity and subject must have their declared types");
    if (body.expectedEvidence !== undefined && (!Array.isArray(body.expectedEvidence) || body.expectedEvidence.some(e => !e || typeof e.ref !== "string" || typeof e.sha256 !== "string"))) throw new JudgmentError("judgment_invalid", "Expected evidence must be prepared reference/digest pairs");
    if (body.subject?.comparison !== undefined && typeof body.subject.comparison !== "string") throw new JudgmentError("judgment_invalid", "Comparison must be an evidence reference");
    const identity = requireSenderIdentity(c, { verb: "proof judgment", bodyClaim: body.actorSession });
    if (!identity.ok) return identity.response;
    const { project: _project, projectRoot: _projectRoot, ...input } = body;
    const { root, scope, owner, project } = target(c, body.scope, body.project, body.projectRoot);
    const result = recordJudgment(root, { ...input, scope: scope! }, identity.session, resolveRecordedProvenance(c, identity), project?.root);
    owner?.invalidate();
    // The receipt is already durable. A lost notification must not turn a committed write into a claimed rollback.
    let notification = "unchanged";
    if (!result.replayed) {
      try {
        const bus = c.get("eventBus" as never) as EventBus | undefined;
        if (!bus) notification = "unavailable; direct reads are current, quiet refresh repairs views";
        else { bus.emit({ type: "proof.judged", scope: body.scope, revision: result.readiness.revision }); notification = "emitted"; }
      } catch { notification = "unavailable; quiet refresh repairs views"; }
    }
    return c.json({ ...result, notification }, result.replayed ? 200 : 201);
  });
  return app;
}
