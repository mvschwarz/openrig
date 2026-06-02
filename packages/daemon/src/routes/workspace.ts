// PL-007 Workspace Primitive v0 — workspace HTTP routes.
//
// Read-only endpoints:
//
//   POST /api/workspace/validate
//     body: { root: string; workspaceKind?: WorkspaceKind;
//              recursive?: boolean; requireFrontmatter?: boolean;
//              maxFiles?: number }
//     response: FrontmatterValidationReport
//
//   POST /api/workspace/doctor  (slice-21 FR-5)
//     body (all optional): { workspaceRoot?: string;
//                            filesAllowlistOverride?: string }
//     response: DoctorReport (7-check workspace-readiness report)
//
// No filesystem mutation. Operator picks the root + kind per invocation.
//
// Whoami / node-inventory surface workspace data through their existing
// routes; no separate /api/workspace/whoami.

import { Hono } from "hono";
import * as path from "node:path";
import {
  validateWorkspaceFrontmatter,
  type ValidateOpts,
} from "../domain/workspace/frontmatter-validator.js";
import { WORKSPACE_KINDS, type WorkspaceKind } from "../domain/types.js";
import {
  runWorkspaceDoctor,
  type WorkspaceRootSource,
} from "../domain/workspace/workspace-doctor.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";

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

  // Slice-21 FR-5 — workspace doctor.
  //
  // Resolves all inputs from the daemon's SettingsStore (matching
  // /api/config), runs the 7-check orchestrator, and returns the
  // DoctorReport. Caller can override the workspace under check via
  // body.workspaceRoot — useful for `rig workspace doctor --workspace
  // <path>` to probe an alternate workspace without restarting the
  // daemon. When overridden, the daemon-side workspace.root is still
  // resolved for check #4 (daemon-points-at-this-workspace).
  app.post("/doctor", async (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);

    const body = await c.req.json<{
      workspaceRoot?: string;
      filesAllowlistOverride?: string;
    }>().catch(
      () => ({} as { workspaceRoot?: string; filesAllowlistOverride?: string }),
    );

    try {
      const daemonResolved = store.resolveOne("workspace.root");
      const workspaceUnderCheck =
        typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0
          ? body.workspaceRoot
          : (daemonResolved.value as string);
      // Caller-supplied workspaceRoot is treated as an explicit
      // operator choice for fix-hint purposes (akin to env). When
      // not supplied, source is the daemon's actual resolution
      // channel (env / file / default).
      const workspaceRootSource: WorkspaceRootSource =
        typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0
          ? "env"
          : (daemonResolved.source as WorkspaceRootSource);

      // When caller overrode workspace, slicesRoot defaults to
      // `<workspaceRoot>/missions` (the same derivation ConfigStore
      // would apply for an unset workspace.slices_root). When not
      // overridden, honor the daemon's resolved slicesRoot.
      const slicesRoot =
        typeof body.workspaceRoot === "string" && body.workspaceRoot.length > 0
          ? path.join(body.workspaceRoot, "missions")
          : (store.resolveOne("workspace.slices_root").value as string);

      // FR-5e A2 — files.allowlist CLI-side env overlay. When the
      // CLI sets OPENRIG_FILES_ALLOWLIST in its own shell, the
      // daemon's SettingsStore can't observe that env (different
      // process); the CLI forwards the raw value as
      // body.filesAllowlistOverride and we honor it here with
      // source="env" so check #3's fix-hint targets the right
      // remediation channel.
      const allowlistResolved = store.resolveOne("files.allowlist");
      const usingAllowlistOverride =
        typeof body.filesAllowlistOverride === "string"
        && body.filesAllowlistOverride.length > 0;
      const allowlistValue = usingAllowlistOverride
        ? body.filesAllowlistOverride!
        : (allowlistResolved.value as string);
      const allowlistSource: WorkspaceRootSource = usingAllowlistOverride
        ? "env"
        : (allowlistResolved.source as WorkspaceRootSource);

      // Daemon start time captured from process.uptime() at request
      // time. Per banked discipline (cited in workspace-doctor.ts:
      // CheckDaemonReloadInput.daemonStartTime JSDoc), this is a
      // pragmatic approximation — sufficient for "did config change
      // since startup" but does not account for explicit clock skew.
      const daemonStartTime = new Date(Date.now() - process.uptime() * 1000);

      const report = runWorkspaceDoctor({
        workspaceRoot: workspaceUnderCheck,
        workspaceRootSource,
        slicesRoot,
        allowlistValue,
        allowlistSource,
        daemonResolvedWorkspaceRoot: daemonResolved.value as string,
        configFilePath: store.configPath,
        daemonStartTime,
      });
      return c.json(report);
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return c.json({ error: "doctor_failed", message }, 500);
    }
  });

  return app;
}
