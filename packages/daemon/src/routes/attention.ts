import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AttentionRead, AttentionItem } from "../attention-surface.js";
import type { QueueRepository } from "../domain/queue-repository.js";
import { isHumanSeatSessionRef } from "../domain/session-name.js";
import type { HealthProjectionService } from "../domain/health-detectors.js";
import type { OperatingPostureService } from "../domain/rig-mode/operating-posture.js";
import { listProjects, insideProject, projectMission, type ProjectRead } from "../domain/workspace/project-read.js";
import { readMissionReadiness } from "../domain/proof/judgments.js";
import { WorkflowInstanceStore } from "../domain/workflow-instance-store.js";
import { WorkflowStepTrailLog } from "../domain/workflow-step-trail-log.js";

export function attentionRoutes(): Hono {
  const app = new Hono();
  app.get("/", c => {
    const wanted = c.req.query("item");
    const result: AttentionRead = { scope: "instance", readAt: new Date().toISOString(), items: [], sources: [], detail: null, detailError: null };
    const add = (item: AttentionItem, lines: () => string[], files: () => Array<{ label: string; path: string }> = () => []) => {
      if (!result.items.some(i => i.id === item.id)) result.items.push(item);
      if (wanted === item.id) result.detail = { item, lines: lines(), files: files() };
    };
    const unavailable = (source: string, error: unknown) => result.sources.push({ source, state: "unavailable", detail: error instanceof Error ? error.message : String(error) });
    let projects: ProjectRead[] = [];
    try {
      projects = listProjects(c).projects;
      result.sources.push({ source: "project catalog", state: "available", detail: "Exact catalog identities; unscoped requests remain instance facts." });
    } catch (e) { unavailable("project catalog", e); }
    const queue = c.get("queueRepo" as never) as QueueRepository | undefined;
    const posture = c.get("operatingPosture" as never) as OperatingPostureService | undefined;
    try {
      if (!queue) throw new Error("Queue repository unavailable");
      const rows = queue.listAttention({ limit: 1001 });
      result.sources.push({ source: "queue", state: rows.length >= 1001 ? "partial" : "available", detail: rows.length >= 1001 ? "Attention query reached 1001 rows; showing at most 1000." : "Open human-addressed requests and explicit human blockers; a human-gate tier alone is insufficient." });
      const current = rows.slice(0, 1000).filter(q => isHumanSeatSessionRef(q.destinationSession) || q.state === "blocked" && isHumanSeatSessionRef(q.blockedOn ?? ""));
      // Keep an opened request inspectable after its source is resolved, without
      // retaining it in the current Action required feed or inventing an inbox.
      const opened = wanted?.startsWith("queue:") ? queue.getById(wanted.slice(6)) : null;
      const detailOnly = opened && !current.some(q => q.qitemId === opened.qitemId) ? opened : null;
      for (const q of [...current, ...(detailOnly ? [detailOnly] : [])]) {
        const tags = [...new Set((q.tags ?? []).filter(t => t.startsWith("project:")).map(t => t.slice(8)))];
        const p = tags.length === 1 ? projects.find(p => p.id === tags[0] && !p.error) : undefined;
        const deps = queue.db.prepare("SELECT summary, qitem_id FROM queue_items WHERE blocked_on = ? AND state IN ('pending','in-progress','blocked') ORDER BY ts_created DESC LIMIT 101").all(q.qitemId) as Array<{ summary: string | null; qitem_id: string }>;
        const unblocks = isHumanSeatSessionRef(q.blockedOn ?? "") ? q.summary || "The blocked task (inspect the request)" : deps.length ? deps.slice(0, 100).map(d => d.summary || "An unnamed dependent task").join("; ") + (deps.length > 100 ? "; more dependents omitted" : "") : "No dependent task recorded; inspect the request for its intended outcome.";
        const item: AttentionItem = { id: `queue:${q.qitemId}`, kind: "action", recipient: isHumanSeatSessionRef(q.destinationSession) ? q.destinationSession : q.blockedOn, summary: q.summary || q.body.trim().split(/\r?\n/).find(Boolean) || "Request summary unavailable", urgency: q.priority, unblocks, at: q.tsUpdated, scope: p ? `project ${p.id}` : "instance · project unknown", project: p ? { id: p.id, root: p.root } : null, source: `/api/queue/${encodeURIComponent(q.qitemId)}` };
        add(item, () => {
          const mode = posture?.resolve({ qitemId: q.qitemId });
          return ["Request:", q.body, ...(q.humanDetail ? ["Supplemental detail:", q.humanDetail] : []), `State: ${q.state}`, `To: ${q.destinationSession}`, `From: ${q.sourceSession}`, `Blocked on: ${q.blockedOn ?? "none"}`, `Posture: ${mode?.posture ?? "unknown"} · ${mode?.reason ?? "posture source unavailable"}`, `Evidence reference: ${q.evidenceRef ?? "none recorded"}`, `Decision route: follow the correlated human request in Slack. Inspect: rig queue show ${q.qitemId} --full`, "Queue history (read/delivery is not approval):", ...queue.listTransitions(q.qitemId).map(t => JSON.stringify(t))];
        }, () => {
          if (!q.evidenceRef || !path.isAbsolute(q.evidenceRef) && (!p || /^[a-z][a-z\d+.-]*:/i.test(q.evidenceRef))) return [];
          const hash = q.evidenceRef.indexOf("#"), anchor = hash < 0 ? "" : q.evidenceRef.slice(hash);
          let file = hash < 0 ? q.evidenceRef : q.evidenceRef.slice(0, hash);
          file = path.isAbsolute(file) ? file : path.resolve(p!.root, file);
          try { file = fs.realpathSync(file); } catch { /* The file reader reports the unavailable source. */ }
          return [{ label: "Request evidence", path: file + anchor }];
        });
        if (q === detailOnly) result.items = result.items.filter(i => i.id !== item.id);
      }
    } catch (e) { unavailable("queue", e); }
    try {
      if (!queue) throw new Error("Queue repository unavailable");
      const rows = queue.listOpenHumanUpdates({ limit: 1001 });
      result.sources.push({ source: "queue updates", state: rows.length >= 1001 ? "partial" : "available",
        detail: rows.length >= 1001 ? "Open human updates reached 1001 rows; showing at most 1000, urgent first." : "Open explicit human-addressed updates, urgent first; local FYIs do not require a delivery receipt or decision." });
      const current = rows.slice(0, 1000);
      const opened = wanted?.startsWith("queue-update:") ? queue.getById(wanted.slice(13)) : null;
      const detailOnly = opened?.humanIntent === "update" && isHumanSeatSessionRef(opened.destinationSession)
        && !current.some(q => q.qitemId === opened.qitemId) ? opened : null;
      for (const q of [...current, ...(detailOnly ? [detailOnly] : [])]) {
        const tags = [...new Set((q.tags ?? []).filter(t => t.startsWith("project:")).map(t => t.slice(8)))];
        const p = tags.length === 1 ? projects.find(p => p.id === tags[0] && !p.error) : undefined;
        const item: AttentionItem = { id: `queue-update:${q.qitemId}`, kind: "update", recipient: q.destinationSession,
          summary: q.summary || q.body.trim().split(/\r?\n/).find(Boolean) || "Update summary unavailable",
          urgency: q.priority, unblocks: null, at: q.tsUpdated, scope: p ? `project ${p.id}` : "instance · project unknown",
          project: p ? { id: p.id, root: p.root } : null, source: `/api/queue/${encodeURIComponent(q.qitemId)}` };
        add(item, () => ["Informational update; no action needed. Viewing is not approval or proof of delivery.",
          q.body, ...(q.humanDetail ? ["Supplemental detail:", q.humanDetail] : []),
          `State: ${q.state}`, `To: ${q.destinationSession}`, `From: ${q.sourceSession}`,
          `Evidence reference: ${q.evidenceRef ?? "none recorded"}`, `Inspect: rig queue show ${q.qitemId} --full`,
          "Queue history (read/delivery is not approval):", ...queue.listTransitions(q.qitemId).map(t => JSON.stringify(t))], () => {
          if (!q.evidenceRef || !path.isAbsolute(q.evidenceRef) && (!p || /^[a-z][a-z\d+.-]*:/i.test(q.evidenceRef))) return [];
          const hash = q.evidenceRef.indexOf("#"), anchor = hash < 0 ? "" : q.evidenceRef.slice(hash);
          let file = hash < 0 ? q.evidenceRef : q.evidenceRef.slice(0, hash);
          file = path.isAbsolute(file) ? file : path.resolve(p!.root, file);
          try { file = fs.realpathSync(file); } catch { /* The file reader reports the unavailable source. */ }
          return [{ label: "Update evidence", path: file + anchor }];
        });
        if (q === detailOnly) result.items = result.items.filter(i => i.id !== item.id);
      }
    } catch (e) { unavailable("queue updates", e); }
    for (const p of projects) {
      const source = `proof: project ${p.id}`;
      try {
        if (p.error) throw new Error(p.error);
        insideProject(p.root, p.missionsRoot);
        const missions = fs.readdirSync(p.missionsRoot, { withFileTypes: true }).filter(d => d.isDirectory() || d.isSymbolicLink());
        result.sources.push({ source, state: missions.length > 200 ? "partial" : "available", detail: "Native outcome judgments by mission/slice; no completion inferred from queue state. At most 200 missions." });
        for (const entry of missions.slice(0, 200)) {
          try {
            const dir = projectMission(p, entry.name), mission = readMissionReadiness(dir);
            if (mission.issues.length) result.sources.push({ source: `${source}/${entry.name}`, state: "partial", detail: mission.issues.join("; ") });
            for (const slice of mission.slices) {
              const ready = slice.readiness;
              if (ready.issues.length) result.sources.push({ source: `${source}/${entry.name}/${slice.scope}`, state: "partial", detail: ready.issues.join("; ") });
              for (const proof of ready.items) {
                if (!proof.judgment) continue;
                const j = proof.judgment, scope = `${entry.name}/slices/${slice.scope}`;
                const item: AttentionItem = { id: `proof:${p.id}:${scope}:${proof.id}`, kind: "update", summary: `${proof.text} · ${proof.state}`, urgency: "outcome", unblocks: null, at: j.at, scope: `project ${p.id} · ${scope}`, project: { id: p.id, root: p.root }, source: path.resolve(dir, "slices", slice.scope, proof.source.file) };
                add(item, () => [`Current proof state: ${proof.state} · ${proof.reason}`, `Slice readiness: ${ready.state}; mission readiness: ${mission.state}. Readiness does not itself close a mission.`, `Judged by: ${j.actor} at ${j.at}`, `Reason: ${j.reason}`, `Posture: ${posture?.resolve({ projectId: p.id, missionId: entry.name }).posture ?? "unknown"}; attributed proof does not grant additional authority.`, `Evidence: ${j.evidence.map(e => `${e.ref} (sha256 ${e.sha256})`).join("; ")}`, "Judgment history:", ...ready.history.filter(h => h.itemId === proof.id).map(h => `${h.verdict} · ${h.id} · previous ${h.previous ?? "none"} · ${h.ref}`)], () => [{ label: "Outcome contract", path: item.source }, ...ready.history.filter(h => h.itemId === proof.id).map(h => ({ label: `Judgment: ${h.verdict}`, path: path.resolve(p.root, h.ref) }))]);
              }
            }
          } catch (e) { unavailable(`${source}/${entry.name}`, e); }
        }
      } catch (e) { unavailable(source, e); }
    }
    try {
      if (!queue) throw new Error("Workflow repository unavailable");
      const ids = queue.db.prepare("SELECT instance_id FROM workflow_instances WHERE lifecycle_binding_json IS NOT NULL ORDER BY created_at DESC LIMIT 201").all() as Array<{ instance_id: string }>;
      const instances = new WorkflowInstanceStore(queue.db), trails = new WorkflowStepTrailLog(queue.db);
      result.sources.push({ source: "mission outcomes", state: ids.length > 200 ? "partial" : "available", detail: "At most 200 manifest-bound workflows; attributed terminal receipts, with current workflow state. Unbound historical workflows are excluded." });
      for (const { instance_id: id } of ids.slice(0, 200)) {
        const instance = instances.getByIdOrThrow(id), binding = instance.lifecycleBinding!;
        const identity = binding.identity as { project?: string; mission?: string } | undefined;
        const p = projects.find(p => p.id === identity?.project && !p.error);
        if (!p || !identity?.mission) continue;
        const sources = binding.sources as Array<{ kind: string; path: string }> | undefined;
        const mission = projectMission(p, identity.mission);
        if (!sources?.some(s => s.kind === "project" && s.path === path.join(p.root, "project.yaml")) || !sources.some(s => s.kind === "mission" && s.path === path.join(mission, "mission.yaml"))) continue;
        const history = trails.listForInstance(id, 201), receipt = history.find(t => t.closureReason === "done" || t.closureReason === "failed");
        if (!receipt) continue;
        const item: AttentionItem = { id: `workflow:${id}`, kind: "update", summary: `${identity.mission}: ${receipt.stepId} ${receipt.closureReason} · workflow ${instance.status}`, urgency: "outcome", unblocks: null, at: receipt.closedAt, scope: `project ${p.id} · mission ${identity.mission}`, project: { id: p.id, root: p.root }, source: `/api/workflow/${encodeURIComponent(id)}/trace` };
        add(item, () => [`Current workflow state: ${instance.status}; a step receipt alone does not complete the mission.`, `Posture: ${posture?.resolve({ projectId: p.id, missionId: identity.mission }).posture ?? "unknown"}`, `Actor: ${receipt.actorSession}`, `Outcome evidence: ${JSON.stringify(receipt.closureEvidence)}`, `Workflow history${history.length > 200 ? " (partial: 200 retained entries shown)" : ""}:`, ...history.slice(0, 200).map(t => JSON.stringify(t))], () => [{ label: "Mission authority", path: path.join(mission, "mission.yaml") }]);
      }
    } catch (e) { unavailable("mission outcomes", e); }
    try {
      const service = c.get("healthProjection" as never) as HealthProjectionService | undefined;
      if (!service) throw new Error("Health projection unavailable");
      // Canonical episodes supply status and observation time, including retained
      // clears. No liveness stream, inferred transition or new retention store.
      const records = service.records().filter(r => r.severity !== "info" && (!r.ceremony || r.ceremony.stage === "confirmed" || r.ceremony.stage === "cleared"));
      const coverage = service.coverage();
      const unavailableSource = coverage.some(s => s.status === "unavailable");
      const partial = coverage.filter(s => s.partial);
      result.sources.push({ source: "health", state: unavailableSource ? "unavailable" : records.length > 200 || partial.length ? "partial" : "available",
        detail: ["Material canonical episodes (including retained clears), at most 200. Source retention bounds apply; absence is not proof of recovery.",
          ...partial.map(s => s.status === "unavailable" ? `${s.source}: unavailable — ${s.reason}`
            : `${s.source}: partial — evaluated ${s.evaluated} of ${s.total} ${s.unit}; ${s.omitted} omitted (limit ${s.limit}, ${s.order}).`)].join(" ") });
      for (const r of records.slice(0, 200)) {
        const projectId = "projectId" in r.scope ? r.scope.projectId : undefined;
        const p = projects.find(p => p.id === projectId && !p.error);
        const item: AttentionItem = { id: `health:${r.id}`, kind: "update", summary: `${r.summary} · ${r.status}`, urgency: r.severity, unblocks: null, at: r.lastObservedAt, scope: `instance health · ${Object.values(r.scope).join(" / ")}`, project: p ? { id: p.id, root: p.root } : null, source: `/api/health/${encodeURIComponent(r.id)}` };
        add(item, () => [`Status: ${r.status}; first observed ${r.startedAt ?? "unknown"}; last observed ${r.lastObservedAt ?? "unknown"}`, `Freshness: ${r.freshness.state}; ${r.indeterminateReason ?? ""}`, `Posture: ${r.operatingPosture?.posture ?? "unknown"} · ${r.operatingPosture?.reason ?? "not supplied by source"}`, r.explanation, r.suggestedInspection, `Threshold: ${r.threshold}`, "Canonical source and bounded evidence:", JSON.stringify(r, null, 2)]);
      }
    } catch (e) { unavailable("health", e); }
    result.items.sort((a, b) => a.kind.localeCompare(b.kind) || (a.kind === "update" ? Number(b.urgency === "urgent") - Number(a.urgency === "urgent") : 0) || (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id));
    if (wanted && !result.detail) result.detailError = "Selected source is unavailable or outside the current source window. Return to Attention to refresh; absence is not resolution.";
    return c.json(result);
  });
  return app;
}
