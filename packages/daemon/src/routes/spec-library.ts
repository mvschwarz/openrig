import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ActiveLensStore } from "../domain/active-lens-store.js";
import type { SpecLibraryEntry, SpecLibraryService } from "../domain/spec-library-service.js";
import { SpecReviewService, SpecReviewError } from "../domain/spec-review-service.js";
import {
  getWorkflowReview,
  parseWorkflowLibraryId,
  scanWorkflowSpecs,
  scanWorkflowSpecFolder,
} from "../domain/spec-library-workflow-scanner.js";
import type { WorkflowSpecCache } from "../domain/workflow-spec-cache.js";
import type { EventBus } from "../domain/event-bus.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";

function visibleEntries(entries: SpecLibraryEntry[], settings: SettingsStore | undefined, includeBuiltins = false): SpecLibraryEntry[] {
  const showBuiltins = includeBuiltins || settings?.resolveOne("specs.builtins_visible").value !== false;
  return entries.filter((entry) => {
    if (entry.id.startsWith("workflow-source:") && entries.some((other) =>
      !other.id.startsWith("workflow-source:") && other.kind === "workflow" && other.sourcePath === entry.sourcePath)) return false;
    if (entry.id.startsWith("workflow-source:") && showBuiltins && !includeBuiltins) return false;
    return showBuiltins || entry.sourceType !== "builtin";
  });
}

export function specLibraryRoutes(): Hono {
  const router = new Hono();

  function refreshWorkflowEntries(c: { get: (k: string) => unknown }): SpecLibraryService {
    const lib = c.get("specLibraryService" as never) as SpecLibraryService;
    const db = c.get("rigRepoDb" as never) as Database.Database | undefined
      ?? (c.get("rigRepo" as never) as { db: Database.Database } | undefined)?.db;
    const builtinDir = c.get("workflowBuiltinSpecsDir" as never) as string | undefined;
    if (db) {
      // Slice 11 (workflow-spec-folder-discovery) — opportunistically
      // walk the operator's workspace workflows folder (if wired) so
      // newly-dropped YAML files materialize as cache rows (valid or
      // diagnostic) before the cache read below. Folder scan is gated
      // on context wiring; pre-slice-11 callers still get the
      // cache-only behavior.
      const cache = c.get("workflowSpecCache" as never) as WorkflowSpecCache | undefined;
      const folder = c.get("workflowsFolderDir" as never) as string | undefined;
      const eventBus = c.get("eventBus" as never) as EventBus | undefined;
      const aliases: Array<{ name: string; version: string; sourcePath: string; sourceHash: string }> = [];
      const verifiedSourceHashes = new Map<string, string>();
      if (cache && folder) {
        try {
          scanWorkflowSpecFolder({ db, cache, folder, builtinDir: builtinDir ?? null, eventBus,
            onBuiltinAlias: (name, version, sourcePath, sourceHash) => aliases.push({ name, version, sourcePath, sourceHash }),
            onVerifiedSource: (sourcePath, sourceHash) => verifiedSourceHashes.set(sourcePath, sourceHash) });
        } catch { /* best-effort — folder scan failure must not break Library list */ }
      }
      // Re-scan workflow specs on each list request — cheap (single
      // SELECT against the workflow_specs cache) and means lens-driven
      // surfaces always see the freshest cache state without a separate
      // POST /sync.
      const workflowEntries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir ?? null });
      for (const alias of aliases) {
        const original = workflowEntries.find((entry) => entry.sourceType === "builtin" && entry.name === alias.name && entry.version === alias.version);
        if (!original) continue;
        try {
          const hashFile = (file: string) => createHash("sha256").update(readFileSync(file, "utf8")).digest("hex");
          if (hashFile(alias.sourcePath) !== alias.sourceHash || hashFile(original.sourcePath) !== alias.sourceHash) continue;
          workflowEntries.push({ ...original, id: `workflow-source:${createHash("sha256").update(alias.sourcePath).digest("hex")}`,
            sourceType: "user_file", isBuiltIn: false, sourcePath: alias.sourcePath, relativePath: alias.sourcePath });
        } catch { /* A file changed or disappeared during the scan; try again on the next request. */ }
      }
      // Keep a source-specific link valid when an identical copy is edited and
      // becomes the cache's own user-file row. The normal row is listed once.
      if (folder && cache) {
        // Reuse the scanner's persisted/stat-validated hash for ordinary user files. Alias copies intentionally keep
        // their separate two-file byte check above because they have no persisted row of their own.
        const sourceHashes = verifiedSourceHashes;
        for (const entry of [...workflowEntries]) {
          if (entry.id.startsWith("workflow-source:") || entry.sourceType !== "user_file" || entry.status === "error" || dirname(entry.sourcePath) !== folder) continue;
          try {
            let sourceHash = sourceHashes.get(entry.sourcePath);
            if (sourceHash === undefined) {
              sourceHash = createHash("sha256").update(readFileSync(entry.sourcePath, "utf8")).digest("hex");
              sourceHashes.set(entry.sourcePath, sourceHash);
            }
            const cached = cache.getByNameVersion(entry.name, entry.version);
            if (!cached || cached.sourcePath !== entry.sourcePath || cached.sourceHash !== sourceHash) continue;
          } catch { continue; /* Missing or changed source: do not project an unverified alias. */ }
          workflowEntries.push({ ...entry, id: `workflow-source:${createHash("sha256").update(entry.sourcePath).digest("hex")}` });
        }
      }
      lib.setWorkflowEntries(workflowEntries);
    }
    return lib;
  }

  // GET /active-lens — read the active workflow lens (if any).
  // Mounted BEFORE /:id so the literal path doesn't get eaten by the
  // bare-param catchall (Phase A R1 SSE route-order lesson).
  router.get("/active-lens", (c) => {
    const store = c.get("activeLensStore" as never) as ActiveLensStore | undefined;
    if (!store) return c.json({ activeLens: null });
    return c.json({ activeLens: store.get() });
  });

  // POST /active-lens — set / replace the active workflow lens.
  router.post("/active-lens", async (c) => {
    const store = c.get("activeLensStore" as never) as ActiveLensStore | undefined;
    if (!store) return c.json({ error: "active_lens_unavailable" }, 503);
    const body = await c.req.json<{ specName?: string; specVersion?: string }>().catch(() => ({} as { specName?: string; specVersion?: string }));
    if (!body.specName || !body.specVersion) {
      return c.json({ error: "specName and specVersion are required" }, 400);
    }
    const lens = store.set(body.specName, body.specVersion);
    return c.json({ activeLens: lens });
  });

  // DELETE /active-lens — clear the active workflow lens.
  router.delete("/active-lens", (c) => {
    const store = c.get("activeLensStore" as never) as ActiveLensStore | undefined;
    if (!store) return c.json({ error: "active_lens_unavailable" }, 503);
    store.clear();
    return c.json({ activeLens: null });
  });

  // GET / — list library entries
  router.get("/", (c) => {
    const lib = refreshWorkflowEntries(c);
    const kind = c.req.query("kind") as "rig" | "agent" | "workflow" | undefined;
    const settings = c.get("settingsStore" as never) as SettingsStore | undefined;
    const entries = visibleEntries(lib.list(kind ? { kind } : undefined), settings, c.req.query("include_builtins") === "true");
    return c.json(entries.map((entry) => {
      // Preserve the authored/catalog path and also identify its actual source.
      // Consumers still read through the existing file-root boundary.
      let resolvedSourcePath: string | null = null;
      try { resolvedSourcePath = realpathSync(entry.sourcePath); } catch { /* missing/denied source stays explicit */ }
      return { ...entry, resolvedSourcePath };
    }));
  });

  // GET /:id — entry metadata + YAML content
  router.get("/:id", (c) => {
    const lib = refreshWorkflowEntries(c);
    const id = c.req.param("id");

    // Guard: don't match sub-paths like /review or /sync or /active-lens
    if (id === "sync" || id === "review" || id === "active-lens") return c.notFound();

    const result = lib.get(id);
    if (!result) {
      return c.json({ error: `Spec '${id}' not found in library` }, 404);
    }
    return c.json(result);
  });

  // GET /:id/review — structured review with library provenance
  router.get("/:id/review", (c) => {
    const lib = refreshWorkflowEntries(c);
    const svc = c.get("specReviewService" as never) as SpecReviewService;
    const id = c.req.param("id");

    const result = lib.get(id);
    if (!result) {
      return c.json({ error: `Spec '${id}' not found in library` }, 404);
    }

    // Workflows in Spec Library v0: workflow review is a separate
    // payload shape — topology graph + per-step list + source-path
    // — projected from the workflow_specs SQLite cache.
    if (result.entry.kind === "workflow") {
      const parsed = id.startsWith("workflow-source:")
        ? { name: result.entry.name, version: result.entry.version }
        : parseWorkflowLibraryId(id);
      if (!parsed) return c.json({ error: `Workflow library id '${id}' could not be parsed` }, 400);
      const db = (c.get("rigRepo" as never) as { db: Database.Database } | undefined)?.db;
      const builtinDir = c.get("workflowBuiltinSpecsDir" as never) as string | undefined;
      if (!db) return c.json({ error: "workflow_specs_db_unavailable" }, 503);
      const review = getWorkflowReview({
        db,
        workflowBuiltinSpecsDir: builtinDir ?? null,
        name: parsed.name,
        version: parsed.version,
      });
      if (!review) {
        return c.json({ error: `Workflow spec '${parsed.name}' v${parsed.version} not in workflow_specs cache` }, 404);
      }
      return c.json({ ...review, sourcePath: result.entry.sourcePath,
        isBuiltIn: result.entry.sourceType === "builtin", libraryEntryId: id });
    }

    try {
      let review: Record<string, unknown>;
      if (result.entry.kind === "rig") {
        review = svc.reviewRigSpec(result.yaml, "library_item") as unknown as Record<string, unknown>;
      } else {
        review = svc.reviewAgentSpec(result.yaml, "library_item") as unknown as Record<string, unknown>;
      }

      // Enrich service-backed rigs with composePreview (best-effort)
      const services = review["services"] as Record<string, unknown> | undefined;
      if (services && services["composeFile"]) {
        try {
          const composeFilePath = join(dirname(result.entry.sourcePath), services["composeFile"] as string);
          const composeYaml = readFileSync(composeFilePath, "utf-8");
          const composeDoc = parseYaml(composeYaml) as Record<string, unknown>;
          const composeServices = composeDoc["services"] as Record<string, Record<string, unknown>> | undefined;
          if (composeServices && typeof composeServices === "object") {
            const preview = Object.entries(composeServices).map(([name, svc]) => ({
              name,
              image: (svc["image"] as string) ?? undefined,
            }));
            services["composePreview"] = { services: preview };
          }
        } catch { /* best-effort: missing compose file = no preview */ }
      }

      // Add library provenance
      return c.json({
        ...review,
        libraryEntryId: id,
        sourcePath: result.entry.sourcePath,
      });
    } catch (err) {
      if (err instanceof SpecReviewError) {
        return c.json({ errors: err.errors }, 400);
      }
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // POST /sync — rescan roots
  router.post("/sync", (c) => {
    const lib = c.get("specLibraryService" as never) as SpecLibraryService;
    lib.scan();
    refreshWorkflowEntries(c);
    const settings = c.get("settingsStore" as never) as SettingsStore | undefined;
    return c.json(visibleEntries(lib.list(), settings, c.req.query("include_builtins") === "true"));
  });

  // DELETE /:id — remove a user-file library entry
  router.delete("/:id", (c) => {
    const lib = c.get("specLibraryService" as never) as SpecLibraryService;
    const result = lib.remove(c.req.param("id"));
    if (!result.ok) {
      const status = result.code === "not_found" ? 404
        : result.code === "read_only" ? 409
        : result.code === "conflict" ? 409
        : 400;
      return c.json(result, status);
    }
    return c.json({ ok: true, id: result.entry.id, name: result.entry.name });
  });

  // POST /:id/rename — rename a user-file library entry
  router.post("/:id/rename", async (c) => {
    const lib = c.get("specLibraryService" as never) as SpecLibraryService;
    const body = await c.req.json().catch(() => ({}));
    const name = body["name"];
    if (typeof name !== "string" || name.trim().length === 0) {
      return c.json({ ok: false, code: "invalid_spec", error: "name is required" }, 400);
    }

    const result = lib.rename(c.req.param("id"), name);
    if (!result.ok) {
      const status = result.code === "not_found" ? 404
        : result.code === "read_only" ? 409
        : result.code === "conflict" ? 409
        : 400;
      return c.json(result, status);
    }
    return c.json({ ok: true, entry: result.entry });
  });

  return router;
}
