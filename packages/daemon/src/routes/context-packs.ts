// Rig Context / Composable Context Injection v0 (PL-014) — daemon HTTP
// routes for context_packs.
//
// Endpoints (Slice-03 Atom 5 — ref-primary; colon-id `/library/:id` removed):
//   GET    /api/context-packs/library                  — list all packs
//   POST   /api/context-packs/library/sync             — re-walk discovery roots
//   POST   /api/context-packs/library/compose          — compose files into a durable ref
//   GET    /api/context-packs/library/by-ref?ref=      — pack manifest + files
//   DELETE /api/context-packs/library/by-ref?ref=      — remove a pack
//   GET    /api/context-packs/library/by-ref/preview?ref= — assembled bundle (dry-run shape)
//
// A pack is addressed by its path-like ref (e.g. `packs/compaction-restore`);
// the entry's opaque `id` is `context-pack:<ref>` (UI routing key only).

import { Hono } from "hono";
import { readFileSync } from "node:fs";
import type { ContextPackLibraryService } from "../domain/context-packs/context-pack-library-service.js";
import { assembleBundle } from "../domain/context-packs/bundle-assembler.js";
import { ContextPackError, type ContextPackEntry } from "../domain/context-packs/context-pack-types.js";

interface ComposeBody {
  outRef?: string;
  sources?: unknown[];
}

type RefErrorStatus = 400 | 404 | 500;
function jsonError(
  status: RefErrorStatus,
  error: string,
  message: string,
  details?: Record<string, unknown>,
): { status: RefErrorStatus; body: Record<string, unknown> } {
  return { status, body: { error, message, ...(details ?? {}) } };
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

  // Slice-03 Atom 5 — preview migrated off the removed colon-id `/library/:id`
  // route onto the ref-primary `?ref=` surface (getByRef-backed). A resolved
  // entry's opaque `id` (context-pack:<ref>) is echoed for the UI, but resolution
  // is by ref only.
  const resolveByRef = (
    lib: ContextPackLibraryService,
    ref: string | undefined,
  ): { entry: ContextPackEntry } | { error: ReturnType<typeof jsonError> } => {
    if (!ref) return { error: jsonError(400, "ref_required", "query must include ?ref=<path-like-ref>") };
    let entry: ContextPackEntry | null;
    try {
      entry = lib.getByRef(ref);
    } catch (err) {
      if (err instanceof ContextPackError) {
        return { error: jsonError(err.code === "unsafe_ref" ? 400 : 500, err.code, err.message, err.details) };
      }
      return { error: jsonError(500, "by_ref_failed", (err as Error).message) };
    }
    if (!entry) return { error: jsonError(404, "pack_not_found", `Context pack '${ref}' not found in library`) };
    return { entry };
  };

  // GET /library/by-ref/preview?ref=<path-like-ref> — assembled bundle (read-only)
  router.get("/library/by-ref/preview", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const resolved = resolveByRef(lib, c.req.query("ref"));
    if ("error" in resolved) return c.json(resolved.error.body, resolved.error.status);
    const entry = resolved.entry;
    try {
      const bundle = assembleBundle({ packEntry: entry });
      return c.json({
        id: entry.id,
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

  // GET /library/by-ref/pieces?ref=<path-like-ref> — ordered per-member
  // contents for `rig walk`; missing members are reported before delivery.
  router.get("/library/by-ref/pieces", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const resolved = resolveByRef(lib, c.req.query("ref"));
    if ("error" in resolved) return c.json(resolved.error.body, resolved.error.status);
    const entry = resolved.entry;
    const pieces: Array<{ path: string; role: string; content: string }> = [];
    const missingFiles: Array<{ path: string; role: string }> = [];
    for (const file of entry.files) {
      if (file.absolutePath === null) {
        missingFiles.push({ path: file.path, role: file.role });
        continue;
      }
      try {
        const absolutePath = lib.resolveFileWithinPack(entry, file.path);
        pieces.push({ path: file.path, role: file.role, content: readFileSync(absolutePath, "utf-8") });
      } catch {
        missingFiles.push({ path: file.path, role: file.role });
      }
    }
    return c.json({ ref: entry.relativePath, id: entry.id, pieces, missingFiles });
  });

  return router;
}
