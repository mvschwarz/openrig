import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SpecLibraryService } from "../domain/spec-library-service.js";
import { SpecReviewService, SpecReviewError } from "../domain/spec-review-service.js";

export function specLibraryRoutes(): Hono {
  const router = new Hono();

  // GET / — list library entries
  router.get("/", (c) => {
    const lib = c.get("specLibraryService" as never) as SpecLibraryService;
    const kind = c.req.query("kind") as "rig" | "agent" | undefined;
    const entries = lib.list(kind ? { kind } : undefined);
    return c.json(entries);
  });

  // GET /:id — entry metadata + YAML content
  router.get("/:id", (c) => {
    const lib = c.get("specLibraryService" as never) as SpecLibraryService;
    const id = c.req.param("id");

    // Guard: don't match sub-paths like /review or /sync
    if (id === "sync" || id === "review") return c.notFound();

    const result = lib.get(id);
    if (!result) {
      return c.json({ error: `Spec '${id}' not found in library` }, 404);
    }
    return c.json(result);
  });

  // GET /:id/review — structured review with library provenance
  router.get("/:id/review", (c) => {
    const lib = c.get("specLibraryService" as never) as SpecLibraryService;
    const svc = c.get("specReviewService" as never) as SpecReviewService;
    const id = c.req.param("id");

    const result = lib.get(id);
    if (!result) {
      return c.json({ error: `Spec '${id}' not found in library` }, 404);
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
    return c.json(lib.list());
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
