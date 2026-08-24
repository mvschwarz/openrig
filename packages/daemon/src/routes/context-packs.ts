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
import { join } from "node:path";
import type { ContextPackLibraryService } from "../domain/context-packs/context-pack-library-service.js";
import { assembleBundle, assemblePlainFiles } from "../domain/context-packs/bundle-assembler.js";
import { ContextPackError, type ContextPackEntry } from "../domain/context-packs/context-pack-types.js";
import { parseManifest } from "../domain/context-packs/manifest-parser.js";
import { composeProfile, ProfileComposeError, type ComposeRuntime, type ComposeSituation } from "../domain/context-packs/profile-composer.js";
import { makeProfileReadFile, sourceKindForAddress, SourceResolutionError, type ProfileSourceRoots, type SourceReadRecord } from "../domain/context-packs/profile-source-resolver.js";
import { parseAddress } from "../domain/markdown-address.js";
import { SettingsStore } from "../domain/user-settings/settings-store.js";

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
    // Slice-03 Atom 6b: `text` = the WHOLE plain content (present members joined
    // by the sealed compose separator via assemblePlainFiles, read-only) — the
    // one-payload form the --context/--body-context delivery flags inject/snapshot,
    // vs `pieces` which walk paces separately. `bytes` lets a caller size-warn.
    const assembled = assemblePlainFiles({ files: pieces.map((p) => ({ path: p.path, content: p.content })) });
    return c.json({ ref: entry.relativePath, id: entry.id, pieces, missingFiles, text: assembled.text, bytes: assembled.bytes });
  });

  // OPR.0.5.3.5 Atom 4b — GET /library/by-ref/profile?ref=&situation=&runtime=
  // [&budget=][&rig=&seat=]: situation-composed delivery over the pack's atom
  // graph + the seat tree. The manifest flows through the ONE parser chokepoint;
  // the seat root resolves from topology.root CONFIG (slice-06 D1 layout:
  // rigs/<rig>/seats/<seat>), never a literal; every compose failure is a NAMED
  // 4xx — a profile is never quietly thinner than its graph says.
  router.get("/library/by-ref/profile", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const resolved = resolveByRef(lib, c.req.query("ref"));
    if ("error" in resolved) return c.json(resolved.error.body, resolved.error.status);
    const entry = resolved.entry;

    const situation = c.req.query("situation");
    if (situation !== "fresh" && situation !== "handover" && situation !== "post-compaction") {
      return c.json({ error: "invalid_situation", message: `situation must be fresh | handover | post-compaction (got: ${situation ?? "(missing)"})` }, 400);
    }
    const runtime = c.req.query("runtime");
    if (runtime !== "claude" && runtime !== "codex") {
      return c.json({ error: "invalid_runtime", message: `runtime must be claude | codex (got: ${runtime ?? "(missing)"})` }, 400);
    }
    const budgetRaw = c.req.query("budget");
    let budgetTokens: number | undefined;
    if (budgetRaw !== undefined) {
      budgetTokens = Number(budgetRaw);
      if (!Number.isInteger(budgetTokens) || budgetTokens < 0) {
        return c.json({ error: "invalid_budget", message: `budget must be a non-negative integer (got: ${budgetRaw})` }, 400);
      }
    }

    let manifest;
    try {
      manifest = parseManifest(readFileSync(join(entry.sourcePath, "manifest.yaml"), "utf-8"), entry.sourcePath);
    } catch (err) {
      return c.json({ error: "manifest_unreadable", message: (err as Error).message }, 422);
    }
    if (!manifest.atoms || manifest.atoms.length === 0) {
      return c.json({ error: "no_atoms", message: `pack '${entry.relativePath}' declares no atoms — a profile composes from atom metadata (mini-req 1); add an atoms: section to its manifest` }, 422);
    }

    // Seat root from CONFIG when the caller names its seat. rig/seat are path
    // SEGMENTS — the bounded token check keeps a query string from walking the
    // topology tree (same class as the install-ref segment rule). TRUST
    // BOUNDARY (r1 rider 2): passing rig+seat is the caller's EXPLICIT GRANT of
    // read access to that seat DIRECTORY SUBTREE — the pack chooses paths
    // within the granted root (that is what a root grant means), and every tree
    // read is visible in the provenance surface below, so an untrusted
    // (URL-installed) pack's seat: atoms can neither read a root the caller
    // did not grant nor deliver bytes whose origin is hidden.
    const roots: ProfileSourceRoots = {};
    const rig = c.req.query("rig");
    const seat = c.req.query("seat");
    if (rig !== undefined || seat !== undefined) {
      const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
      if (!rig || !seat || !SEGMENT.test(rig) || !SEGMENT.test(seat)) {
        return c.json({ error: "invalid_seat_params", message: "rig and seat must BOTH be single bounded segments ([A-Za-z0-9][A-Za-z0-9._-]{0,63})" }, 400);
      }
      const topologyRoot = String(new SettingsStore().resolveOne("topology.root").value);
      roots.seat = join(topologyRoot, "rigs", rig, "seats", seat);
    }

    try {
      // Byte provenance per read (r1 rider 1): the source label must be
      // CHECKABLE. Keyed by ref — every piece with that ref shares the read.
      const readsByRef = new Map<string, SourceReadRecord>();
      const profile = composeProfile({
        atoms: manifest.atoms,
        situation: situation as ComposeSituation,
        runtime: runtime as ComposeRuntime,
        ...(budgetTokens !== undefined ? { budgetTokens } : {}),
        readFile: makeProfileReadFile({
          packDir: entry.sourcePath,
          roots,
          onRead: (record) => readsByRef.set(record.ref, record),
        }),
        sourceKindFor: (a) => sourceKindForAddress(a.address),
      });
      const pieces = profile.pieces.map((p) => {
        const record = readsByRef.get(parseAddress(p.address).ref);
        return record
          ? { ...p, provenance: { nominalPath: record.nominalPath, realPath: record.realPath, escapesRoot: record.escapesRoot } }
          : p;
      });
      // ALWAYS an array (consumer guards one shape): empty = every piece's
      // bytes came from inside its granted root. Report, never block —
      // realpath containment would break legitimately-symlinked layouts.
      const provenanceWarnings = pieces
        .filter((p) => "provenance" in p && (p as { provenance: { escapesRoot: boolean } }).provenance.escapesRoot)
        .map((p) => {
          const prov = (p as { provenance: { realPath: string } }).provenance;
          return `piece '${p.atomId}' (${p.address}): bytes came from OUTSIDE its ${p.sourceKind} root — real path ${prov.realPath}`;
        });
      return c.json({ ref: entry.relativePath, ...profile, pieces, provenanceWarnings });
    } catch (err) {
      if (err instanceof ProfileComposeError || err instanceof SourceResolutionError) {
        return c.json({ error: "profile_compose_failed", message: err.message }, 422);
      }
      throw err;
    }
  });

  return router;
}
