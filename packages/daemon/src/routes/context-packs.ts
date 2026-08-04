// Rig Context / Composable Context Injection v0 (PL-014) — daemon HTTP
// routes for context_packs.
//
// Endpoints:
//   GET  /api/context-packs/library                — list all packs
//   POST /api/context-packs/library/sync           — re-walk discovery roots
//   GET  /api/context-packs/library/:id            — pack manifest + files
//   GET  /api/context-packs/library/:id/preview    — assembled bundle (dry-run shape)
//   POST /api/context-packs/library/:id/send       — send to a destination session
//
// :id is `context-pack:<name>:<version>` — same shape as
// SpecLibraryEntry.id for workflows, so URL-encoding rules carry over.

import { Hono } from "hono";
import type { ContextPackLibraryService } from "../domain/context-packs/context-pack-library-service.js";
import type { SessionTransport } from "../domain/session-transport.js";
import { assembleBundle } from "../domain/context-packs/bundle-assembler.js";
import { ContextPackError } from "../domain/context-packs/context-pack-types.js";

interface SendBody {
  destinationSession?: string;
  /** When true, returns the assembled bundle without invoking SessionTransport. */
  dryRun?: boolean;
}

interface ComposeBody {
  outRef?: string;
  sources?: unknown[];
}

export function contextPacksRoutes(): Hono {
  const router = new Hono();

  // GET /library
  router.get("/library", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    return c.json(lib.list());
  });

  // POST /library/sync
  router.post("/library/sync", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const result = lib.scan();
    return c.json({ ...result, entries: lib.list() });
  });

  // POST /library/compose — Atom 3's delivery-free file -> durable-ref path.
  router.post("/library/compose", async (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const body = await c.req.json<ComposeBody>().catch(() => ({} as ComposeBody));
    if (
      typeof body.outRef !== "string" ||
      !Array.isArray(body.sources) ||
      body.sources.some((source) =>
        typeof source !== "object" ||
        source === null ||
        Array.isArray(source) ||
        typeof (source as Record<string, unknown>).path !== "string" ||
        typeof (source as Record<string, unknown>).label !== "string"
      )
    ) {
      return c.json({
        error: "invalid_compose_request",
        message: "body must include { outRef, sources: [{ path, label }, ...] }",
      }, 400);
    }
    try {
      const result = lib.composeFromFiles({
        outRef: body.outRef,
        sources: body.sources as Array<{ path: string; label: string }>,
      });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof ContextPackError) {
        const status = err.code === "pack_exists"
          ? 409
          : err.code === "store_unavailable"
            ? 503
            : err.code === "pack_write_failed"
              ? 500
              : 400;
        return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 400);
      }
      return c.json({ error: "compose_failed", message: (err as Error).message }, 500);
    }
  });

  // Slice-03 Atom 4 — the ref-primary read/delete surface. A path-like ref
  // carries '/', so it travels as a `?ref=` query, never a `:id` path segment.
  // Registered BEFORE `/library/:id` so the static `by-ref` segment is never
  // captured as a colon-id. Both verbs flow through the store's sealed
  // getByRef/removeByRef boundary (assertSafePackRef before any effect).

  // GET /library/by-ref?ref=<path-like-ref>
  router.get("/library/by-ref", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const ref = c.req.query("ref");
    if (!ref) return c.json({ error: "ref_required", message: "query must include ?ref=<path-like-ref>" }, 400);
    try {
      const entry = lib.getByRef(ref);
      if (!entry) return c.json({ error: "pack_not_found", message: `Context pack '${ref}' not found in library` }, 404);
      return c.json(entry);
    } catch (err) {
      if (err instanceof ContextPackError) {
        const status = err.code === "unsafe_ref" ? 400 : 500;
        return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 400);
      }
      return c.json({ error: "by_ref_failed", message: (err as Error).message }, 500);
    }
  });

  // DELETE /library/by-ref?ref=<path-like-ref>
  router.delete("/library/by-ref", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const ref = c.req.query("ref");
    if (!ref) return c.json({ error: "ref_required", message: "query must include ?ref=<path-like-ref>" }, 400);
    try {
      const result = lib.removeByRef(ref);
      return c.json({ ...result, count: lib.list().length });
    } catch (err) {
      if (err instanceof ContextPackError) {
        const status = err.code === "unsafe_ref"
          ? 400
          : err.code === "pack_not_found"
            ? 404
            : err.code === "pack_not_removable"
              ? 403
              : 500;
        return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 400);
      }
      return c.json({ error: "rm_failed", message: (err as Error).message }, 500);
    }
  });

  // GET /library/:id
  router.get("/library/:id", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    // Guard: literal /sync is handled above; reject as 404 here so a
    // pack with id="sync" (which can't exist since ids carry a colon)
    // doesn't shadow the literal.
    if (id === "sync") return c.notFound();
    const entry = lib.get(id);
    if (!entry) return c.json({ error: `Context pack '${id}' not found in library` }, 404);
    return c.json(entry);
  });

  // GET /library/:id/preview — assembled bundle (read-only, no send)
  router.get("/library/:id/preview", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const id = decodeURIComponent(c.req.param("id"));
    const entry = lib.get(id);
    if (!entry) return c.json({ error: `Context pack '${id}' not found in library` }, 404);
    try {
      const bundle = assembleBundle({ packEntry: entry });
      return c.json({
        id,
        name: entry.name,
        version: entry.version,
        bundleText: bundle.text,
        bundleBytes: bundle.bytes,
        estimatedTokens: bundle.estimatedTokens,
        files: bundle.files,
        missingFiles: bundle.missingFiles,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // POST /library/:id/send
  router.post("/library/:id/send", async (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    const transport = c.get("sessionTransport" as never) as SessionTransport | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    if (!transport) return c.json({ error: "session_transport_unavailable" }, 503);

    const id = decodeURIComponent(c.req.param("id"));
    const entry = lib.get(id);
    if (!entry) return c.json({ error: `Context pack '${id}' not found in library` }, 404);

    const body = await c.req.json<SendBody>().catch(() => ({} as SendBody));
    const destinationSession = body.destinationSession;
    const dryRun = !!body.dryRun;
    if (typeof destinationSession !== "string" || destinationSession.length === 0) {
      return c.json({
        error: "destinationSession_required",
        hint: "POST body must include { destinationSession: <session-name> }",
      }, 400);
    }

    let bundle;
    try {
      bundle = assembleBundle({ packEntry: entry });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }

    const previewPayload = {
      id,
      name: entry.name,
      version: entry.version,
      destinationSession,
      bundleBytes: bundle.bytes,
      estimatedTokens: bundle.estimatedTokens,
      files: bundle.files,
      missingFiles: bundle.missingFiles,
      dryRun,
    };

    if (dryRun) {
      return c.json({ ...previewPayload, bundleText: bundle.text });
    }

    const result = await transport.send(destinationSession, bundle.text);
    if (!result.ok) {
      return c.json({
        ...previewPayload,
        sent: false,
        error: result.error ?? result.reason ?? "send_failed",
        reason: result.reason,
      }, 502);
    }
    return c.json({ ...previewPayload, sent: true });
  });

  return router;
}
