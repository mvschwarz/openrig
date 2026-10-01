import { Hono } from "hono";
import { proofSourceObservation } from "../domain/proof/source-watch.js";
import * as path from "node:path";
import type { SliceIndexer } from "../domain/slices/slice-indexer.js";
import type { EventBus } from "../domain/event-bus.js";
import { JudgmentError, evidenceAt, readSliceReadiness, readMissionReadiness, readProjectReadiness, recordJudgment, resolveProofScope, type JudgeInput } from "../domain/proof/judgments.js";
import { projectReadResponse, selectedProject, type ProjectRead } from "../domain/workspace/project-read.js";
import { ProjectReadError } from "../domain/workspace/project-catalog.js";
import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";

export function proofRoutes(): Hono {
  const app = new Hono();
  app.onError((e, c) => {
    if (e instanceof JudgmentError) return c.json({ error: e.code, message: e.message }, e.status as 400);
    if (e instanceof ProjectReadError) return projectReadResponse(e);
    return c.json({ error: "proof_unavailable", message: e.message }, 503);
  });
  const indexer = (c: { get: (key: never) => unknown }): SliceIndexer => {
    const value = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
    if (!value?.isReady()) throw new JudgmentError("workspace_unavailable", "Configure the daemon workspace before reading or recording judgments", 503);
    return value;
  };
  const source = (c: Parameters<typeof selectedProject>[0]): { root: string; project: ProjectRead | null } => {
    const project = selectedProject(c);
    return { root: project?.missionsRoot ?? indexer(c).slicesRoot, project };
  };
  const sourceObservation = (c: Parameters<typeof selectedProject>[0], project: ProjectRead | null) =>
    project ? { state: "unavailable" as const, revision: "unverified" } : proofSourceObservation(c);
  const projectIdentity = (project: ProjectRead | null) => project ? { id: project.id, root: project.root } : undefined;
  app.get("/", c => {
    const { root, project } = source(c), scope = c.req.query("scope");
    const common = { sourceObservation: sourceObservation(c, project), ...(project ? { project: projectIdentity(project) } : {}) };
    if (!scope) return c.json({ ...readProjectReadiness(root), ...common });
    const dir = resolveProofScope(root, scope);
    if (path.basename(path.dirname(dir)) !== "slices") return c.json({ ...readMissionReadiness(dir), ...common });
    const refs = c.req.queries("evidence") ?? [];
    return c.json({ ...readSliceReadiness(dir), ...common, ...(refs.length ? { preparedEvidence: refs.map(ref => evidenceAt(project?.root ?? path.dirname(root), dir, ref)) } : {}) });
  });
  app.post("/judge", async c => {
    const body = await c.req.json<JudgeInput & { actorSession?: string }>().catch(() => null);
    if (!body || typeof body.scope !== "string" || typeof body.item !== "string" || typeof body.expectedRevision !== "string" || !(body.expectedPrevious === null || typeof body.expectedPrevious === "string") || (body.evidence !== undefined && (!Array.isArray(body.evidence) || body.evidence.some(e => typeof e !== "string")))) throw new JudgmentError("judgment_invalid", "Provide scope, item, expected revision/predecessor and evidence references; rig proof judge resolves these in the ordinary path");
    if ((body.actorSession !== undefined && typeof body.actorSession !== "string") || typeof body.reason !== "string" || (body.operationId !== undefined && (typeof body.operationId !== "string" || !body.operationId.trim())) || (body.subject !== undefined && (!body.subject || typeof body.subject !== "object" || typeof body.subject.kind !== "string" || typeof body.subject.ref !== "string")) || (body.replace !== undefined && typeof body.replace !== "boolean")) throw new JudgmentError("judgment_invalid", "Reason, operation identity and subject must have their declared types");
    if (body.expectedEvidence !== undefined && (!Array.isArray(body.expectedEvidence) || body.expectedEvidence.some(e => !e || typeof e.ref !== "string" || typeof e.sha256 !== "string"))) throw new JudgmentError("judgment_invalid", "Expected evidence must be prepared reference/digest pairs");
    if (body.subject?.comparison !== undefined && typeof body.subject.comparison !== "string") throw new JudgmentError("judgment_invalid", "Comparison must be an evidence reference");
    const identity = requireSenderIdentity(c, { verb: "proof judgment", bodyClaim: body.actorSession });
    if (!identity.ok) return identity.response;
    const { root, project } = source(c);
    const owner = project ? null : indexer(c);
    const result = recordJudgment(root, body, identity.session, resolveRecordedProvenance(c, identity));
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
