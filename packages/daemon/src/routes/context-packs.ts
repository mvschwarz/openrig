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
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ContextPackLibraryService } from "../domain/context-packs/context-pack-library-service.js";
import { assembleBundle, assemblePlainFiles } from "../domain/context-packs/bundle-assembler.js";
import { ContextPackError, type ContextPackAtom, type ContextPackEntry } from "../domain/context-packs/context-pack-types.js";
import { parseManifest } from "../domain/context-packs/manifest-parser.js";
import { composeNamedProfile, composeProfile, ProfileComposeError, type ComposeInput, type ComposeRuntime, type ComposeSituation } from "../domain/context-packs/profile-composer.js";
import { makeProfileReadFile, sourceKindForAddress, SourceResolutionError, type ProfileSourceRoots, type SourceReadRecord } from "../domain/context-packs/profile-source-resolver.js";
import { AddressResolutionError, parseAddress, resolveAddress } from "../domain/markdown-address.js";
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

function isRelativeMarkdownAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let path: string;
  try {
    path = parseAddress(value).ref;
  } catch (err) {
    if (err instanceof AddressResolutionError) return false;
    throw err;
  }
  return path.length > 0 &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/).some((segment) => segment.length === 0 || segment === "." || segment === "..") &&
    [".md", ".markdown"].includes(extname(path).toLowerCase());
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

  // OPR.0.5.3.5 Atom 4c — GET /library/resolve-address?address=<name#H2/H3>:
  // the ONE resolver home for the ref-grammar address form (mini-req 6 / Q4).
  // The daemon owns the whole resolution — longest-prefix pack match against
  // the library index, file within the pack (containment-checked by the
  // library service), span within the file (Atom-1 machinery: Q1 full span,
  // fence-protected, fail-loud with candidates, ambiguity rejected). The
  // addressable unit is the FILE per the locked grammar; the assembled bundle
  // is never an address target (its '## File:' frames are themselves H2s).
  router.get("/library/resolve-address", (c) => {
    const lib = c.get("contextPackLibrary" as never) as ContextPackLibraryService | undefined;
    if (!lib) return c.json({ error: "context_pack_library_unavailable" }, 503);
    const address = c.req.query("address");
    if (!address) return c.json({ error: "missing_address", message: "address is required: <pack-ref>/<file>[#H2-slug[/H3-slug]]" }, 400);

    let parsed;
    try {
      parsed = parseAddress(address);
    } catch (err) {
      return c.json({ error: "invalid_address", message: (err as Error).message }, 400);
    }

    // Longest-prefix pack match: pack refs and file paths share '/', so the
    // library index decides the split — never a guess. BORROWED INVARIANT,
    // named here because this loop's correctness rests on it (r1 4c rec): the
    // scanner does NOT recurse into a pack directory, so no pack ref can be a
    // segment-boundary prefix of another and this loop matches AT MOST ONE
    // pack. If sub-pack indexing is ever added, this split becomes ambiguous —
    // the no-nested-packs pin in context-pack-address-route.test.ts goes red
    // there so the change cannot land silently.
    const entries = lib.list();
    const segments = parsed.ref.split("/");
    let entry: ContextPackEntry | undefined;
    let filePath = "";
    for (let cut = segments.length - 1; cut >= 1; cut--) {
      const candidateRef = segments.slice(0, cut).join("/");
      const found = entries.find((e) => e.relativePath === candidateRef);
      if (found) {
        entry = found;
        filePath = segments.slice(cut).join("/");
        break;
      }
    }
    if (!entry) {
      return c.json({ error: "pack_not_found", message: `no library pack matches any prefix of '${parsed.ref}' — run 'rig context list' for the available refs` }, 404);
    }
    if (filePath.length === 0) {
      return c.json({ error: "missing_file_path", message: `'${parsed.ref}' names pack '${entry.relativePath}' but no file within it — the addressable unit is the file: <pack-ref>/<file>[#...]` }, 400);
    }
    const declared = entry.files.find((f) => f.path === filePath);
    if (!declared) {
      return c.json({ error: "file_not_in_pack", message: `pack '${entry.relativePath}' declares no file '${filePath}' — declared: ${entry.files.map((f) => f.path).join(", ")}` }, 404);
    }
    let fileText: string;
    try {
      fileText = readFileSync(lib.resolveFileWithinPack(entry, filePath), "utf-8");
    } catch (err) {
      return c.json({ error: "file_unreadable", message: `pack '${entry.relativePath}' file '${filePath}': ${(err as Error).message}` }, 422);
    }
    if (parsed.headerPath.length === 0) {
      return c.json({ address, packRef: entry.relativePath, filePath, text: fileText });
    }
    try {
      const section = resolveAddress(fileText, parsed.headerPath);
      return c.json({
        address,
        packRef: entry.relativePath,
        filePath,
        headerPath: section.headerPath,
        headerLine: section.headerLine,
        text: section.text,
        ownText: section.ownText,
      });
    } catch (err) {
      if (err instanceof AddressResolutionError) {
        return c.json({ error: "address_unresolved", message: `${parsed.ref}: ${err.message}` }, 422);
      }
      throw err;
    }
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
    const requestedProfileId = c.req.query("profile");
    const selectedProfile = requestedProfileId === undefined
      ? undefined
      : manifest.profiles?.find((profile) => profile.id === requestedProfileId);
    if (requestedProfileId !== undefined && !selectedProfile) {
      return c.json({
        error: "profile_not_found",
        message: `pack '${entry.relativePath}' declares no profile '${requestedProfileId}' — available: ${manifest.profiles?.map((profile) => profile.id).join(", ") || "(none)"}`,
      }, 400);
    }
    if (selectedProfile && !selectedProfile.situations.includes(situation)) {
      return c.json({ error: "profile_situation_mismatch", message: `profile '${selectedProfile.id}' does not apply to situation '${situation}'` }, 400);
    }
    if (selectedProfile && !selectedProfile.runtimes.includes(runtime)) {
      return c.json({ error: "profile_runtime_mismatch", message: `profile '${selectedProfile.id}' does not apply to runtime '${runtime}'` }, 400);
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
    let atoms: ContextPackAtom[] = manifest.atoms;
    const contextAtoms: Partial<Record<"project" | "mission" | "seat" | "slice", ContextPackAtom[]>> = {};
    const workMeta = new Map<string, { altitude: "project" | "mission" | "seat" | "slice"; source: "default" | "manifest" }>();
    const warnings: string[] = [];
    const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    const rig = c.req.query("rig");
    const seat = c.req.query("seat");
    if (rig !== undefined || seat !== undefined) {
      if (!rig || !seat || !SEGMENT.test(rig) || !SEGMENT.test(seat)) {
        return c.json({ error: "invalid_seat_params", message: "rig and seat must BOTH be single bounded segments ([A-Za-z0-9][A-Za-z0-9._-]{0,63})" }, 400);
      }
      const topologyRoot = String(new SettingsStore().resolveOne("topology.root").value);
      roots.seat = join(topologyRoot, "rigs", rig, "seats", seat);
      contextAtoms.seat = [{
        id: "profile-seat-learned",
        address: "seat:LEARNED.md",
        taxonomy: "lore",
        situations: ["fresh"],
        purpose: "width",
        runtime: "any",
        order: 1,
        priority: "core",
      }];
      workMeta.set("profile-seat-learned", { altitude: "seat", source: "default" });
    }
    // Mission root on the RULED existing key (desk row 2675535d: reuse
    // workspace.slices_root, never mint a sibling): mission root =
    // <slices_root>/<mission>, same bounded-segment gate, same grant
    // semantics — naming the mission grants this compose read access to that
    // mission directory subtree.
    const mission = c.req.query("mission");
    const slice = c.req.query("slice");
    const requiredProfileContext = new Set(selectedProfile?.phases.flatMap((phase) => phase.context ?? []) ?? []);
    if (requiredProfileContext.has("seat") && (!rig || !seat)) {
      return c.json({ error: "profile_context_missing", message: `profile '${selectedProfile!.id}' needs seat context; pass both rig and seat` }, 400);
    }
    if (["project", "mission", "slice"].some((source) => requiredProfileContext.has(source as "project" | "mission" | "slice")) && (!mission || !slice)) {
      return c.json({ error: "profile_context_missing", message: `profile '${selectedProfile!.id}' needs situated project/mission/task context; pass both mission and slice` }, 400);
    }
    if (slice !== undefined && mission === undefined) {
      return c.json({ error: "mission_required", message: "slice requires an exact mission selection; the legacy work hierarchy is project -> mission -> slice" }, 400);
    }
    if (slice !== undefined && !SEGMENT.test(slice)) {
      return c.json({ error: "invalid_slice_param", message: "slice must be a single bounded segment ([A-Za-z0-9][A-Za-z0-9._-]{0,63})" }, 400);
    }
    if (mission !== undefined) {
      if (!SEGMENT.test(mission)) {
        return c.json({ error: "invalid_mission_param", message: "mission must be a single bounded segment ([A-Za-z0-9][A-Za-z0-9._-]{0,63})" }, 400);
      }
      const settings = new SettingsStore();
      const slicesRoot = String(settings.resolveOne("workspace.slices_root").value);
      roots.mission = join(slicesRoot, mission);

      const hasAuthoredWorkAtom = manifest.atoms.some((atom) => {
        const kind = sourceKindForAddress(atom.address);
        return kind === "project" || kind === "mission";
      });
      if (slice === undefined && !hasAuthoredWorkAtom && !selectedProfile) {
        return c.json({
          error: "slice_required",
          message: `pack '${entry.relativePath}' declares no project: or mission: atoms, so --mission alone would be a no-op; pass the exact --slice to request the legacy default work walk`,
        }, 400);
      }

      // Story 1's bounded compatibility seam. Supplying BOTH mission and slice
      // asks for the existing single-project hierarchy's conventional Markdown
      // walk. It is deliberately limited to the unambiguous legacy layout;
      // multi-project/catalog resolution belongs to its later story.
      if (slice !== undefined) {
        if (situation !== "fresh") {
          return c.json({ error: "legacy_default_fresh_only", message: "the bounded legacy default work walk is available only for a fresh profile" }, 400);
        }
        const workspaceRoot = String(settings.resolveOne("workspace.root").value);
        if (resolve(slicesRoot) !== resolve(workspaceRoot, "missions")) {
          return c.json({
            error: "legacy_workspace_required",
            message: `legacy default composition requires workspace.slices_root to be <workspace.root>/missions; got ${slicesRoot}`,
          }, 422);
        }
        roots.project = workspaceRoot;
        const maxOrder = atoms.reduce((max, atom) => Math.max(max, atom.order), Number.MIN_SAFE_INTEGER);
        const idPrefix = selectedProfile ? "profile" : "legacy-default";
        let projectIntent = "SPEC.md";
        let projectIntentSource: "default" | "manifest" = "default";
        let projectContext: string[] = [];
        const projectManifestPath = join(workspaceRoot, "project.yaml");
        if (existsSync(projectManifestPath)) {
          const projectManifest = parseYaml(readFileSync(projectManifestPath, "utf-8")) as {
            install?: { intent?: unknown; context?: unknown };
          } | null;
          const manifestIntent = projectManifest?.install?.intent;
          if (isRelativeMarkdownAddress(manifestIntent)) {
            projectIntent = manifestIntent;
            projectIntentSource = "manifest";
          } else if (manifestIntent !== undefined) {
            warnings.push("project.yaml: optional install.intent must be a relative Markdown address; ignored the invalid value and kept the baseline work install.");
          }
          const manifestContext = projectManifest?.install?.context;
          if (Array.isArray(manifestContext) && manifestContext.every(isRelativeMarkdownAddress)) {
            projectContext = manifestContext;
          } else if (manifestContext !== undefined) {
            warnings.push("project.yaml: optional install.context must be a list of relative Markdown addresses; ignored the invalid value and kept the baseline work install.");
          }
        }
        const projectAtoms: ContextPackAtom[] = [
          {
            id: `${idPrefix}-project-spec`,
            address: `project:${projectIntent}`,
            taxonomy: "mission",
            situations: ["fresh"],
            purpose: "depth",
            runtime: "any",
            order: maxOrder + 1,
            priority: "core",
          },
          ...projectContext.map((address, index): ContextPackAtom => ({
            id: `${idPrefix}-project-context-${index + 1}`,
            address: `project:${address}`,
            taxonomy: "mission",
            situations: ["fresh"],
            purpose: "depth",
            runtime: "any",
            order: maxOrder + index + 2,
            requires: [index === 0 ? `${idPrefix}-project-spec` : `${idPrefix}-project-context-${index}`],
            priority: "core",
          })),
        ];
        const finalProjectAtom = projectAtoms.at(-1)!;
        const defaultAtoms: ContextPackAtom[] = [
          ...projectAtoms,
          {
            id: `${idPrefix}-mission-spec`,
            address: "mission:SPEC.md",
            taxonomy: "mission",
            situations: ["fresh"],
            purpose: "depth",
            runtime: "any",
            order: finalProjectAtom.order + 1,
            requires: [finalProjectAtom.id],
            priority: "core",
          },
          {
            id: `${idPrefix}-slice-spec`,
            address: `mission:slices/${slice}/SPEC.md`,
            taxonomy: "mission",
            situations: ["fresh"],
            purpose: "depth",
            runtime: "any",
            order: finalProjectAtom.order + 2,
            requires: [`${idPrefix}-mission-spec`],
            priority: "core",
          },
        ];
        const collision = defaultAtoms.find((atom) => atoms.some((existing) => existing.id === atom.id));
        if (collision) {
          return c.json({ error: "default_atom_conflict", message: `pack '${entry.relativePath}' already declares reserved atom id '${collision.id}'` }, 422);
        }
        if (selectedProfile) {
          contextAtoms.project = projectAtoms;
          const missionSpec = defaultAtoms[projectAtoms.length]!;
          const sliceSpec = defaultAtoms[projectAtoms.length + 1]!;
          contextAtoms.mission = [
            missionSpec,
            {
              id: "profile-mission-arrangement",
              address: "mission:mission.yaml",
              taxonomy: "mission",
              situations: ["fresh"],
              purpose: "width",
              runtime: "any",
              order: missionSpec.order + 1,
              priority: "core",
            },
            {
              id: "profile-mission-progress",
              address: "mission:PROGRESS.md",
              taxonomy: "mission",
              situations: ["fresh"],
              purpose: "width",
              runtime: "any",
              order: missionSpec.order + 2,
              priority: "core",
            },
          ];
          contextAtoms.slice = [
            sliceSpec,
            {
              id: "profile-slice-progress",
              address: `mission:slices/${slice}/PROGRESS.md`,
              taxonomy: "mission",
              situations: ["fresh"],
              purpose: "width",
              runtime: "any",
              order: sliceSpec.order + 1,
              priority: "core",
            },
          ];
        } else {
          atoms = [...atoms, ...defaultAtoms];
        }
        workMeta.set(`${idPrefix}-project-spec`, { altitude: "project", source: projectIntentSource });
        projectContext.forEach((_, index) => {
          workMeta.set(`${idPrefix}-project-context-${index + 1}`, { altitude: "project", source: "manifest" });
        });
        workMeta.set(`${idPrefix}-mission-spec`, { altitude: "mission", source: "default" });
        workMeta.set(`${idPrefix}-slice-spec`, { altitude: "slice", source: "default" });
        if (selectedProfile) {
          workMeta.set("profile-mission-arrangement", { altitude: "mission", source: "default" });
          workMeta.set("profile-mission-progress", { altitude: "mission", source: "default" });
          workMeta.set("profile-slice-progress", { altitude: "slice", source: "default" });
        }
      }
    }

    try {
      // Byte provenance per read (r1 rider 1): the source label must be
      // CHECKABLE. Keyed by ref — every piece with that ref shares the read.
      const readsByRef = new Map<string, SourceReadRecord>();
      const composeInput: ComposeInput = {
        atoms,
        situation: situation as ComposeSituation,
        runtime: runtime as ComposeRuntime,
        ...(budgetTokens !== undefined ? { budgetTokens } : {}),
        readFile: makeProfileReadFile({
          packDir: entry.sourcePath,
          roots,
          onRead: (record) => readsByRef.set(record.ref, record),
        }),
        sourceKindFor: (a) => sourceKindForAddress(a.address),
      };
      const profile = selectedProfile
        ? composeNamedProfile({ ...composeInput, profile: selectedProfile, contextAtoms })
        : composeProfile(composeInput);
      const pieces = profile.pieces.map((p) => {
        const record = readsByRef.get(parseAddress(p.address).ref);
        // Per-piece sha256: the Test-A door compares the profile's selected
        // pieces to the walk's delivered pieces hash-exactly, not by count.
        const pieceWorkMeta = workMeta.get(p.atomId);
        const hashed = { ...p, ...(pieceWorkMeta ?? {}), sha256: createHash("sha256").update(p.text, "utf8").digest("hex") };
        return record
          ? { ...hashed, provenance: { nominalPath: record.nominalPath, realPath: record.realPath, escapesRoot: record.escapesRoot } }
          : hashed;
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
      const phases = profile.phases?.map((phase) => ({
        ...phase,
        pieces: pieces.filter((piece) => piece.phaseId === phase.id),
      }));
      return c.json({
        ref: entry.relativePath,
        ...profile,
        pieces,
        ...(phases ? { phases } : {}),
        warnings,
        provenanceWarnings,
      });
    } catch (err) {
      if (err instanceof ProfileComposeError || err instanceof SourceResolutionError) {
        return c.json({ error: "profile_compose_failed", message: err.message }, 422);
      }
      throw err;
    }
  });

  return router;
}
