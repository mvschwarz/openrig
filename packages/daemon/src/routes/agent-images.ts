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
import type Database from "better-sqlite3";
import type { AgentImageLibraryService } from "../domain/agent-images/agent-image-library-service.js";
import type { SnapshotCapturer } from "../domain/agent-images/snapshot-capturer.js";
import { evaluateProtection } from "../domain/agent-images/evidence-guard.js";
import { discoverResumeToken } from "../domain/agent-images/resume-token-discovery.js";
import { convergeOp } from "../domain/topology-converge.js";
import type { PodRigInstantiator } from "../domain/rigspec-instantiator.js";
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

interface ForkBody {
  sourceSession?: string;
  rigId?: string;
  pod?: string;
  /** New member id for the forked successor. */
  member?: string;
  rigRoot?: string;
  /** When true, capture + PIN a durable image and launch via mode:agent_image. */
  keepImage?: boolean;
  imageName?: string;
  imageVersion?: string;
  edges?: Array<{ from: string; to: string; kind: string }>;
}

/** The forked successor mirrors the source seat's launch shape. Native resume
 *  id is resolved separately (discoverResumeToken) and kept daemon-local — it is
 *  deliberately NOT part of this shape so it can never leak into a response. */
interface ForkSourceShape {
  runtime: string | null;
  agentRef: string | null;
  profile: string | null;
  cwd: string | null;
  codexConfigProfile: string | null;
}

function resolveForkSourceNode(db: Database.Database, sourceSession: string): ForkSourceShape | null {
  // SELECT n.* so an older DB missing codex_config_profile simply yields
  // undefined for that key rather than throwing.
  const row = db
    .prepare(
      `SELECT n.* FROM sessions s JOIN nodes n ON n.id = s.node_id
       WHERE s.session_name = ? ORDER BY s.id DESC LIMIT 1`,
    )
    .get(sourceSession) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    runtime: (row["runtime"] as string | null) ?? null,
    agentRef: (row["agent_ref"] as string | null) ?? null,
    profile: (row["profile"] as string | null) ?? null,
    cwd: (row["cwd"] as string | null) ?? null,
    codexConfigProfile: (row["codex_config_profile"] as string | null) ?? null,
  };
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

  // OPR.0.4.3.05 seat-forking closeout — the narrow daemon fork composer.
  //
  // `rig fork <source-session>` posts here. This is the ONLY net-new surface
  // in the slice: it composes the ALREADY-SHIPPED primitives (resume-token
  // discovery + add_member converge, or snapshot + pin + add_member) into one
  // operator verb. It exists server-side because the native resume id is
  // redacted at every wire boundary by design — the default one-shot fork MUST
  // resolve the token in-process so the id NEVER leaves the daemon.
  //
  //   default            → discoverResumeToken → add_member(mode: fork,
  //                        native_id) → launch. NO image. Native id stays
  //                        daemon-local (never serialized into the response).
  //   { keepImage: true } → snapshot capture → PIN (evidence-guard protection)
  //                        → add_member(mode: agent_image) → launch.
  router.post("/fork", async (c) => {
    const db = c.get("db" as never) as Database.Database | undefined;
    const podInstantiator = c.get("podInstantiator" as never) as PodRigInstantiator | undefined;
    if (!db || !podInstantiator) return c.json({ error: "fork_composer_unavailable" }, 503);

    const body = (await c.req.json<ForkBody>().catch(() => ({}))) as ForkBody;
    const sourceSession = body.sourceSession;
    const rigId = body.rigId;
    const pod = body.pod;
    const member = body.member;
    if (!sourceSession || !rigId || !pod || !member) {
      return c.json({
        error: "missing_required_fields",
        hint: "POST body must include { sourceSession, rigId, pod, member }",
      }, 400);
    }
    const rigRoot = typeof body.rigRoot === "string" ? body.rigRoot : ".";

    // Resolve the source seat's launch shape so the successor mirrors it
    // (agent_ref / profile / cwd / codex profile). The native resume id is
    // NOT read here — it is resolved separately below and kept daemon-local.
    const source = resolveForkSourceNode(db, sourceSession);
    if (!source) {
      return c.json({
        error: "session_not_found",
        message: `Source session '${sourceSession}' not found. Run 'rig ps --nodes' to see what's running.`,
      }, 404);
    }

    let sessionSource: Record<string, unknown>;
    let keptImage: { id: string; name: string; version: string; pinned: true } | undefined;

    if (body.keepImage) {
      // --keep-image: durable image → PIN-ON-KEEP (the evidence guard protects
      // pinned images from prune/delete) → agent_image launch. Native id is
      // captured into the manifest (redacted at every route boundary) and is
      // consumed only in-process by the instantiator — it never leaves here.
      const capturer = c.get("snapshotCapturer" as never) as SnapshotCapturer | undefined;
      const lib = c.get("agentImageLibrary" as never) as AgentImageLibraryService | undefined;
      if (!capturer || !lib) return c.json({ error: "snapshot_capturer_unavailable" }, 503);
      const imageName = (body.imageName && body.imageName.trim()) || `fork-${member}`;
      const version = (body.imageVersion && body.imageVersion.trim()) || "1";
      try {
        const cap = capturer.capture({ sourceSession, name: imageName, version });
        // PIN-ON-KEEP: protection is the evidence guard's PINNED reason, an
        // explicit + shipped mechanism that survives prune/delete.
        lib.pin(cap.imageId);
        keptImage = { id: cap.imageId, name: imageName, version, pinned: true };
      } catch (err) {
        if (err instanceof AgentImageError) {
          const status = err.code === "image_not_found" ? 404
            : err.code === "runtime_mismatch" ? 400
            : err.code === "image_referenced" ? 409
            : 500;
          return c.json({ error: err.code, message: err.message, details: err.details ?? null }, status);
        }
        return c.json({ error: "fork_snapshot_failed", message: (err as Error).message }, 500);
      }
      sessionSource = { mode: "agent_image", ref: { kind: "image_name", value: imageName, version } };
    } else {
      // Default one-shot: resolve the native resume id server-side. Honest
      // rejection on terminal / no-token — NEVER fabricate (resume-honesty).
      const discovery = discoverResumeToken(db, sourceSession);
      if (!discovery.ok) {
        const status = discovery.failure.code === "session_not_found" ? 404 : 400;
        return c.json({ error: discovery.failure.code, message: discovery.failure.message }, status);
      }
      const nativeId = discovery.result.nativeId;
      if (!nativeId) {
        return c.json({
          error: "resume_token_unavailable",
          message: `Could not discover a resume token for ${discovery.result.runtime} source session '${sourceSession}'. The seat may not have a native conversation id yet — try again after it has produced output. No token was fabricated and no fresh seat was cold-started.`,
        }, 409);
      }
      // The native id is used ONLY to build the in-process member fragment
      // below. It is deliberately NOT echoed in the response (kept daemon-local,
      // consistent with the route redaction boundary).
      sessionSource = { mode: "fork", ref: { kind: "native_id", value: nativeId } };
    }

    const memberFragment: Record<string, unknown> = {
      id: member,
      runtime: source.runtime,
      ...(source.agentRef ? { agent_ref: source.agentRef } : {}),
      ...(source.profile ? { profile: source.profile } : {}),
      ...(source.cwd ? { cwd: source.cwd } : {}),
      ...(source.codexConfigProfile ? { codex_config_profile: source.codexConfigProfile } : {}),
      session_source: sessionSource,
    };

    const converged = await convergeOp(
      { instantiator: podInstantiator },
      rigId,
      { kind: "add_member", pod, member: memberFragment, edges: body.edges },
      rigRoot,
    );
    if (converged.kind !== "add_member" || !converged.supported) {
      return c.json({ error: "fork_failed", message: "Unexpected converge result for fork add_member" }, 500);
    }
    const outcome = converged.outcome;
    // The outcome never carries the native id (add_member persists no
    // session_source; RigRepository.addNode stores no agent-image reference).
    if (!outcome.ok) {
      const status =
        outcome.code === "rig_not_found" || outcome.code === "pod_not_found" ? 404
        : outcome.code === "member_conflict" ? 409
        : outcome.code === "edge_unresolved" || outcome.code === "validation_failed" || outcome.code === "preflight_failed" ? 400
        : 500;
      // A kept image is already pinned/protected even if launch failed — report
      // it honestly so the operator knows it was retained.
      return c.json({ ...outcome, ...(keptImage ? { image: keptImage } : {}) }, status);
    }
    return c.json({ ...outcome, ...(keptImage ? { image: keptImage } : {}) }, 201);
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
 *  PL-016 source-cwd behavior: when the
 *  manifest carries source_cwd, the snippet emits `cwd: <source_cwd>`
 *  ahead of the session_source block. The fork
 *  starts in the SAME directory the parent session was created in,
 *  Claude's project-dir-scoped session storage works because the jsonl
 *  file lives there. The daemon relies on provider cwd resolution and
 *  does NOT override cwd at fork dispatch. If the operator manually
 *  changes cwd, fork fails honestly with "no
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
