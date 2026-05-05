// PL-007 Workspace Primitive v0 — workspace HTTP routes.
//
// One read-only endpoint at v0:
//
//   POST /api/workspace/validate
//     body: { root: string; workspaceKind?: WorkspaceKind;
//              recursive?: boolean; requireFrontmatter?: boolean;
//              maxFiles?: number }
//     response: FrontmatterValidationReport
//
// No filesystem mutation. Operator picks the root + kind per invocation.
//
// Whoami / node-inventory surface workspace data through their existing
// routes; no separate /api/workspace/whoami.

import { Hono } from "hono";
import {
  validateWorkspaceFrontmatter,
  type ValidateOpts,
} from "../domain/workspace/frontmatter-validator.js";
import { WORKSPACE_KINDS, type WorkspaceKind } from "../domain/types.js";

export function workspaceRoutes(): Hono {
  const app = new Hono();

  app.post("/validate", async (c) => {
    const body = await c.req.json<{
      root?: string;
      workspaceKind?: string;
      recursive?: boolean;
      requireFrontmatter?: boolean;
      maxFiles?: number;
    }>().catch(() => ({} as never));

    if (!body.root || typeof body.root !== "string") {
      return c.json({ error: "root_required", message: "root is required" }, 400);
    }
    let kind: WorkspaceKind | undefined;
    if (body.workspaceKind !== undefined) {
      if (!(WORKSPACE_KINDS as readonly string[]).includes(body.workspaceKind)) {
        return c.json({
          error: "invalid_workspace_kind",
          message: `workspaceKind must be one of: ${[...WORKSPACE_KINDS].join(", ")}`,
        }, 400);
      }
      kind = body.workspaceKind as WorkspaceKind;
    }

    const opts: ValidateOpts = {
      root: body.root,
      ...(kind !== undefined ? { workspaceKind: kind } : {}),
      ...(body.recursive !== undefined ? { recursive: body.recursive } : {}),
      ...(body.requireFrontmatter !== undefined ? { requireFrontmatter: body.requireFrontmatter } : {}),
      ...(body.maxFiles !== undefined ? { maxFiles: body.maxFiles } : {}),
    };
    try {
      const report = validateWorkspaceFrontmatter(opts);
      return c.json(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return c.json({ error: "validate_failed", message }, 500);
    }
  });

  return app;
}
