// Fork Primitive + Starter Agent Images v0 (PL-016) — daemon HTTP
// routes.
//
// Endpoints:
//   GET    /api/agent-images/library                — list all images (resume token redacted)
//   POST   /api/agent-images/library/sync           — re-walk discovery roots
//   GET    /api/agent-images/library/:id            — image manifest + stats (resume token redacted)
//   GET    /api/agent-images/library/:id/preview    — manifest + sized supplementary file metadata
//   POST   /api/agent-images/library/:id/pin        — pin from prune
//   POST   /api/agent-images/library/:id/unpin      — unpin
//   DELETE /api/agent-images/library/:id            — delete (subject to evidence guard unless force=true)
//   POST   /api/agent-images/snapshot               — capture a new image from a source seat
//   POST   /api/agent-images/prune                  — prune evictable images (dry-run by default)
//
// Resume tokens are NEVER returned over the wire — they're redacted at
// route boundary. Only the rigspec-instantiator (in-process) consumes
// the token directly.

import { Hono } from "hono";
import { rmSync } from "node:fs";
import type { AgentImageLibraryService } from "../domain/agent-images/agent-image-library-service.js";
import type { SnapshotCapturer } from "../domain/agent-images/snapshot-capturer.js";
import { evaluateProtection } from "../domain/agent-images/evidence-guard.js";
import { AgentImageError, type AgentImageEntry } from "../domain/agent-images/agent-image-types.js";

interface PruneBody {
  dryRun?: boolean;
  force?: boolean;
}

interface SnapshotBody {
  sourceSession?: string;
  name?: string;
  version?: string;
  notes?: string;
  estimatedTokens?: number;
  lineage?: string[];
}

interface DeleteQuery {
  force?: boolean;
}

function redactResumeToken<T extends Pick<AgentImageEntry, "sourceResumeToken">>(entry: T): Omit<T, "sourceResumeToken"> & { sourceResumeToken: string } {
  return { ...entry, sourceResumeToken: "(redacted)" };
}

export interface AgentImageRoutesDeps {
  /** Spec-library roots scanned by the evidence guard. v0 includes
   *  the canonical user spec directory + workspace specs root. */
  specRoots: () => readonly string[];
}

export function agentImagesRoutes(deps: AgentImageRoutesDeps): Hono {
  const router = new Hono();

  router.get("/library", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    return c.json(lib.list().map(redactResumeToken));
  });

  router.post("/library/sync", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const result = lib.scan();
    return c.json({ ...result, entries: lib.list().map(redactResumeToken) });
  });

  router.post("/snapshot", async (c) => {
    const capturer = c.get("snapshotCapturer" as never) as SnapshotCapturer | undefined;
    if (!capturer) return c.json({ error: "snapshot_capturer_unavailable" }, 503);
    const body = (await c.req.json<SnapshotBody>().catch(() => ({}))) as SnapshotBody;
    if (!body.sourceSession || !body.name) {
      return c.json({
        error: "missing_required_fields",
        hint: "POST body must include { sourceSession, name }",
      }, 400);
    }
    try {
      const result = capturer.capture({
        sourceSession: body.sourceSession,
        name: body.name,
        version: body.version,
        notes: body.notes,
        estimatedTokens: body.estimatedTokens,
        lineage: body.lineage,
      });
      // Redact resume token in the response — operator just needs the
      // image id and on-disk path.
      return c.json({
        imageId: result.imageId,
        imagePath: result.imagePath,
        manifest: { ...result.manifest, sourceResumeToken: "(redacted)" },
      });
    } catch (err) {
      if (err instanceof AgentImageError) {
        const status = err.code === "image_not_found" ? 404
          : err.code === "runtime_mismatch" ? 400
          : err.code === "image_referenced" ? 409
          : 500;
        return c.json({ error: err.code, message: err.message, details: err.details ?? null }, status);
      }
      return c.json({ error: "snapshot_failed", message: (err as Error).message }, 500);
    }
  });

  router.post("/prune", async (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const body = (await c.req.json<PruneBody>().catch(() => ({}))) as PruneBody;
    const dryRun = body.dryRun !== false;
    const force = !!body.force;
    const images = lib.list();
    const protections = evaluateProtection({
      images,
      specRoots: deps.specRoots(),
    });
    const protectedImages = protections.filter((p) => p.protected);
    const evictable = protections.filter((p) => !p.protected);
    if (dryRun) {
      return c.json({
        dryRun: true,
        protected: protectedImages,
        evictable: evictable.map((p) => ({ imageId: p.imageId, imageName: p.imageName, imageVersion: p.imageVersion })),
      });
    }
    // Real prune: delete evictable images. Force overrides the guard
    // — protected images get deleted too. CATASTROPHIC bounce risk on
    // force; surface it visibly in the response.
    const targets = force ? protections : evictable;
    const deleted: string[] = [];
    const errors: Array<{ imageId: string; error: string }> = [];
    for (const t of targets) {
      const entry = lib.get(t.imageId);
      if (!entry) continue;
      try {
        rmSync(entry.sourcePath, { recursive: true, force: true });
        deleted.push(t.imageId);
      } catch (err) {
        errors.push({ imageId: t.imageId, error: (err as Error).message });
      }
    }
    lib.scan();
    return c.json({
      dryRun: false,
      forced: force,
      deleted,
      errors,
      protected: force ? [] : protectedImages,
    });
  });

  router.get("/library/:id", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    if (id === "sync" || id === "snapshot" || id === "prune") return c.notFound();
    const entry = lib.get(id);
    if (!entry) return c.json({ error: `Agent image '${id}' not found in library` }, 404);
    return c.json(redactResumeToken(entry));
  });

  router.get("/library/:id/preview", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    const entry = lib.get(id);
    if (!entry) return c.json({ error: `Agent image '${id}' not found in library` }, 404);
    return c.json({
      id,
      name: entry.name,
      version: entry.version,
      runtime: entry.runtime,
      sourceSeat: entry.sourceSeat,
      manifestEstimatedTokens: entry.manifestEstimatedTokens,
      derivedEstimatedTokens: entry.derivedEstimatedTokens,
      stats: entry.stats,
      lineage: entry.lineage,
      pinned: entry.pinned,
      notes: entry.notes,
      files: entry.files,
      starterSnippet: buildStarterSnippet(entry),
    });
  });

  router.post("/library/:id/pin", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    try {
      lib.pin(id);
      return c.json({ ok: true, id, pinned: true });
    } catch (err) {
      if (err instanceof AgentImageError && err.code === "image_not_found") {
        return c.json({ error: err.code, message: err.message }, 404);
      }
      return c.json({ error: "pin_failed", message: (err as Error).message }, 500);
    }
  });

  router.post("/library/:id/unpin", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    try {
      lib.unpin(id);
      return c.json({ ok: true, id, pinned: false });
    } catch (err) {
      if (err instanceof AgentImageError && err.code === "image_not_found") {
        return c.json({ error: err.code, message: err.message }, 404);
      }
      return c.json({ error: "unpin_failed", message: (err as Error).message }, 500);
    }
  });

  router.delete("/library/:id", (c) => {
    const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
    if (!lib) return c.json({ error: "agent_image_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    const force = ((c.req.query("force") as string | undefined) ?? "") === "true";
    const entry = lib.get(id);
    if (!entry) return c.json({ error: `Agent image '${id}' not found in library` }, 404);
    // Evidence guard for non-force deletes.
    if (!force) {
      const protections = evaluateProtection({
        images: lib.list(),
        specRoots: deps.specRoots(),
      });
      const status = protections.find((p) => p.imageId === id);
      if (status && status.protected) {
        return c.json({
          error: "image_referenced",
          message: `Agent image '${id}' is protected: ${status.reasons.join(", ")}. Use force=true to override.`,
          reasons: status.reasons,
          references: status.references,
        }, 409);
      }
    }
    try {
      rmSync(entry.sourcePath, { recursive: true, force: true });
      lib.scan();
      return c.json({ ok: true, id, forced: force });
    } catch (err) {
      return c.json({ error: "delete_failed", message: (err as Error).message }, 500);
    }
  });

  return router;
}

/** PRD § Item 5: review-pane "Use as starter" surface. We synthesize
 *  the agent.yaml snippet here so the UI can render it directly with
 *  no client-side templating.
 *
 *  PL-016 Finding 2 (Option 3, founder-confirmed 2026-05-04): when the
 *  manifest carries source_cwd, the snippet emits `cwd: <source_cwd>`
 *  ahead of the session_source block — operator pastes verbatim, fork
 *  starts in the SAME directory the parent session was created in,
 *  Claude's project-dir-scoped session storage works because the jsonl
 *  file lives there. The daemon does NOT override cwd at fork dispatch
 *  (founder direction "respect the provider; no funny business") — if
 *  operator manually changes cwd, fork fails honestly with "no
 *  conversation found". Manifests without source_cwd (pre-Finding-2)
 *  render without the cwd line for back-compat. */
function buildStarterSnippet(entry: AgentImageEntry): string {
  const lines: string[] = [];
  if (entry.sourceCwd) {
    lines.push(`cwd: ${JSON.stringify(entry.sourceCwd)}`);
  }
  lines.push(
    "session_source:",
    "  mode: agent_image",
    "  ref:",
    "    kind: image_name",
    `    value: ${JSON.stringify(entry.name)}`,
    `    version: ${JSON.stringify(entry.version)}`,
  );
  return lines.join("\n") + "\n";
}
