import { Hono } from "hono";
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

  return router;
}
