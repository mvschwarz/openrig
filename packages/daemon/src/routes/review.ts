// Living Notes Packet 2 — the composed-review route family (OPR.0.4.4.20).
//
// Endpoints (ONE contract, all consumers — slice Review tab, U5 mission-board
// expansion, For-You expansion):
//   GET /api/review/slice/:name        — ComposedSliceReview
//   GET /api/review/mission/:name      — ComposedMissionReview
//   GET /api/review/agents?scope=...   — AgentsBand; scope is the THREE-VALUED
//                                        parameter slice:<id> | mission:<id> | rig
//                                        (never a second endpoint per consumer).
//
// Git lineage facts come from the repo at OPENRIG_REVIEW_GIT_REPO when set;
// otherwise lineage degrades honestly to "unknown" (the composer renders the
// three N1 facts with what it has — never a remembered claim).

import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewGatherer } from "../domain/review/gather.js";
import type { AgentsScope } from "../domain/review/types.js";
import { FileWriteService, sha256Hex } from "../domain/files/file-write-service.js";
import type { AllowlistRoot } from "../domain/files/path-safety.js";
import { freezeSliceExport, resolveAllowlisted } from "../domain/review/freeze.js";
import { applyBriefSpine } from "../domain/review/brief-spine.js";
import { composeFleet } from "../domain/review/fleet-compose.js";
import { defaultHostRegistryPath, loadHostRegistry } from "../domain/hosts/hosts-registry-reader.js";
import type { HostRegistryLoadResult } from "../domain/hosts/hosts-registry-reader.js";

function getGatherer(c: { get(key: string): unknown }): ReviewGatherer | null {
  return (c.get("reviewGatherer") as ReviewGatherer | undefined) ?? null;
}

function parseScope(raw: string | undefined): AgentsScope | null {
  if (!raw) return null;
  if (raw === "rig") return raw;
  if (raw.startsWith("slice:") && raw.length > "slice:".length) return raw as AgentsScope;
  if (raw.startsWith("mission:") && raw.length > "mission:".length) return raw as AgentsScope;
  return null;
}

export function reviewRoutes(): Hono {
  const app = new Hono();

  app.get("/agents", (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    const scope = parseScope(c.req.query("scope"));
    if (!scope) {
      return c.json(
        {
          error: "scope_invalid",
          hint: "scope must be one of: slice:<id> | mission:<id> | rig",
        },
        400,
      );
    }
    const band = gatherer.composeAgents(scope);
    if (!band) return c.json({ error: "scope_not_found", scope }, 404);
    return c.json(band);
  });

  // OPR.0.4.4.22 — the rig-scope standalone altitude root (FR-1..FR-4):
  // NEEDS YOU + AGENTS (health line) + SETTLED, same contract family as
  // /slice/:name and /mission/:name. Read-only pure projection; the panel's
  // standing cost is queue+ps only (drill-in rides the SHIPPED transcript
  // routes — zero new routes for reading panes, per FR-6).
  app.get("/rig", (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    return c.json(gatherer.composeRig());
  });

  // OPR.0.4.6.MH5 — the FLEET aggregate root (arch Q2: a SIBLING aggregate
  // beside this family, never a fourth AgentsScope value). Fans out each
  // registered host's OWN composed rig root and unions + host-dimensions +
  // counts (arch Q1 — exception truth is never recomputed here); the LOCAL
  // host joins in-process via the same gatherer this family uses (D-1).
  // Read + surface only (FR-5); bearers stay server-side (the fan-out is
  // daemon-side like the shipped feed aggregate). Registry access rides the
  // same DI style as /api/queue/attention-aggregate — tests inject a
  // loader/probe; production falls back to the shared S11 reader.
  app.get("/fleet", async (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    const registryLoader = (c.get("hostRegistryLoader" as never) as (() => HostRegistryLoadResult) | undefined) ?? loadHostRegistry;
    const registryProbe = (c.get("hostRegistryExists" as never) as (() => boolean) | undefined) ?? (() => fs.existsSync(defaultHostRegistryPath()));
    const fleet = await composeFleet({
      composeLocalRig: () => gatherer.composeRig(),
      loadRegistry: registryLoader,
      registryExists: registryProbe,
      // The view-time fact enters at the edge — the composer stays clock-free.
      nowIso: new Date().toISOString(),
    });
    return c.json(fleet);
  });

  app.get("/slice/:name", (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    const composed = gatherer.composeSlice(c.req.param("name"));
    if (!composed) return c.json({ error: "slice_not_found", name: c.req.param("name") }, 404);
    return c.json(composed);
  });

  app.get("/mission/:name", (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    const composed = gatherer.composeMission(c.req.param("name"));
    if (!composed) return c.json({ error: "mission_not_found", name: c.req.param("name") }, 404);
    return c.json(composed);
  });

  // FR-6 — the ONE synchronous compose-and-freeze endpoint (the P1/P2
  // interface cell). Invoked by the approve flow AFTER the stamp + audit
  // row commit; a failed render never un-approves and re-invocation is
  // idempotent. No watcher loop, no polling — deliberate, low-frequency.
  app.post("/freeze", async (c) => {
    const gatherer = getGatherer(c);
    if (!gatherer) return c.json({ error: "review_composer_unavailable" }, 503);
    const writeService = (c.get("fileWriteService" as never) as FileWriteService | undefined) ?? null;
    const allowlist = (c.get("filesAllowlist" as never) as AllowlistRoot[] | undefined) ?? [];
    if (!writeService) {
      return c.json(
        {
          error: "file_write_service_unavailable",
          hint: "the freeze write path is allowlist-governed; set OPENRIG_FILES_ALLOWLIST=name:/abs/path and restart the daemon",
        },
        503,
      );
    }
    let body: { scope?: string; name?: string; actor?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body_invalid", hint: 'POST JSON {"scope":"slice","name":"<slice>","actor":"<session>"}' }, 400);
    }
    if (body.scope !== "slice" || !body.name || !body.actor) {
      // Mission-tier freeze rides the same path once mission approval ships
      // end-to-end (Packet 1 FR-9 mission semantics); slice is the v1 surface.
      return c.json({ error: "freeze_request_invalid", hint: 'required: {"scope":"slice","name":"<slice>","actor":"<session>"}' }, 400);
    }
    const ctx = gatherer.composeSliceWithContext(body.name);
    if (!ctx) return c.json({ error: "slice_not_found", name: body.name }, 404);
    const outcome = freezeSliceExport({
      composed: ctx.composed,
      sliceDir: ctx.sliceDir,
      mediaRefs: ctx.mediaRefs,
      allowlist,
      writeService,
      actor: body.actor,
    });
    if (!outcome.ok) {
      const status = outcome.error === "stamp_missing" ? 409 : outcome.error === "allowlist_missing" ? 403 : 500;
      return c.json({ error: outcome.error, message: outcome.message, hint: outcome.hint }, status);
    }

    // FR-8: the freeze IS one of the two deliberate brief-write moments —
    // fold the generated status spine into MISSION_BRIEF.md, section-scoped,
    // schema-order-preserving. Best-effort: a brief-write failure never
    // un-freezes (the export + stamp already stand); it surfaces as a warning.
    let briefWrite: string | null = null;
    if (!outcome.alreadyFrozen && ctx.composed.missionId) {
      try {
        const mission = gatherer.composeMission(ctx.composed.missionId);
        const target = gatherer.missionBriefTarget(ctx.composed.missionId);
        if (mission && target) {
          const applied = applyBriefSpine(target.content, mission.briefSpine);
          if (applied === null) {
            briefWrite = "skipped: MISSION_BRIEF.md does not carry the pinned exact-order schema (generation never guess-rewrites a malformed brief)";
          } else if (applied !== target.content) {
            const stat = fs.statSync(target.briefPath);
            const mapped = resolveAllowlisted(allowlist, path.dirname(target.briefPath));
            if (!mapped) {
              briefWrite = "skipped: mission folder not under OPENRIG_FILES_ALLOWLIST";
            } else {
              writeService.writeAtomic({
                rootName: mapped.root,
                path: path.join(mapped.rel, "MISSION_BRIEF.md"),
                content: applied,
                expectedMtime: stat.mtime.toISOString(),
                expectedContentHash: sha256Hex(target.content),
                actor: body.actor,
              });
              briefWrite = "spine updated";
            }
          } else {
            briefWrite = "spine unchanged";
          }
        }
      } catch (err) {
        briefWrite = `failed (freeze unaffected): ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return c.json({ ok: true, path: outcome.path, alreadyFrozen: outcome.alreadyFrozen, briefWrite });
  });

  return app;
}
