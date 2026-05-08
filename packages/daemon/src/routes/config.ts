// User Settings v0 — daemon HTTP route for the UI System drawer
// Settings panel.
//
// Endpoints:
//   GET    /api/config                  → all keys with value/source/default
//   GET    /api/config/:key             → one key with value/source/default
//   POST   /api/config/:key             → set a key (body: { value: string })
//   DELETE /api/config/:key             → reset one key (revert to default)
//   POST   /api/config/init-workspace   → scaffold default workspace dirs
//
// The CLI (`rig config get/set/reset/init-workspace`) is the canonical
// edit surface for operators + agents. This route exists for the UI;
// agents stay on CLI-shell-out per the shipped openrig-user-settings skill.

import { Hono } from "hono";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  SETTINGS_VALID_KEYS,
  isSettingsValidKey,
  type SettingsStore,
} from "../domain/user-settings/settings-store.js";
import {
  workspaceScaffoldDirs,
  workspaceScaffoldFiles,
} from "../domain/workspace/default-workspace-scaffold.js";

interface InitWorkspaceBody {
  root?: string;
  force?: boolean;
  dryRun?: boolean;
}

export function configRoutes(): Hono {
  const router = new Hono();

  router.get("/", (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    return c.json({ settings: store.resolveAllWithSource() });
  });

  router.post("/init-workspace", async (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const body = (await c.req.json<InitWorkspaceBody>().catch(() => ({}))) as InitWorkspaceBody;
    const root = body.root ?? (store.resolveOne("workspace.root").value as string);
    const dryRun = !!body.dryRun;
    const force = !!body.force;

    const subdirs: Array<{ name: string; path: string; created: boolean }> = [];
    const files: Array<{ relPath: string; absPath: string; created: boolean; skipped: "exists" | null }> = [];

    const rootExists = existsSync(root);
    if (!rootExists && !dryRun) mkdirSync(root, { recursive: true });

    for (const sub of workspaceScaffoldDirs()) {
      const subPath = join(root, sub);
      const subExists = existsSync(subPath);
      if (!subExists && !dryRun) mkdirSync(subPath, { recursive: true });
      subdirs.push({ name: sub, path: subPath, created: !subExists });
    }

    for (const file of workspaceScaffoldFiles()) {
      const absPath = join(root, file.relPath);
      const fileExists = existsSync(absPath);
      if (fileExists && !force) {
        files.push({ relPath: file.relPath, absPath, created: false, skipped: "exists" });
      } else {
        if (!dryRun) writeFileSync(absPath, file.content, "utf-8");
        files.push({ relPath: file.relPath, absPath, created: true, skipped: null });
      }
    }

    return c.json({ root, rootCreated: !rootExists, subdirs, files, dryRun });
  });

  router.get("/:key", (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const key = c.req.param("key");
    if (!isSettingsValidKey(key)) {
      return c.json({ error: `Unknown config key '${key}'`, validKeys: SETTINGS_VALID_KEYS }, 400);
    }
    return c.json(store.resolveOne(key));
  });

  router.post("/:key", async (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const key = c.req.param("key");
    if (!isSettingsValidKey(key)) {
      return c.json({ error: `Unknown config key '${key}'`, validKeys: SETTINGS_VALID_KEYS }, 400);
    }
    const body = (await c.req.json<{ value?: string }>().catch(() => ({}))) as { value?: string };
    if (typeof body.value !== "string") {
      return c.json({ error: "value_required", hint: "POST body must be { \"value\": <string> }" }, 400);
    }
    try {
      store.set(key, body.value);
      return c.json({ ok: true, key, resolved: store.resolveOne(key) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  router.delete("/:key", (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const key = c.req.param("key");
    if (!isSettingsValidKey(key)) {
      return c.json({ error: `Unknown config key '${key}'`, validKeys: SETTINGS_VALID_KEYS }, 400);
    }
    try {
      store.reset(key);
      return c.json({ ok: true, key, resolved: store.resolveOne(key) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return router;
}
