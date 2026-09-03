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
import {
  SETTINGS_VALID_KEYS,
  isSettingsValidKey,
  parseFeedHostSubscriptionKey,
  removedContextSettingMessage,
  type SettingsStore,
} from "../domain/user-settings/settings-store.js";
import {
  ensureDefaultWorkspace,
} from "../domain/workspace/default-workspace-scaffold.js";

interface InitWorkspaceBody {
  root?: string;
  /** Deprecated compatibility input. Existing files are always preserved. */
  force?: boolean;
  dryRun?: boolean;
}

export function configRoutes(): Hono {
  const router = new Hono();

  router.get("/", (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    // OPR.0.4.4.15: dynamic-class enumeration rides ADDITIVELY beside the
    // static settings map (existing consumers of `settings` unaffected).
    try {
      return c.json({ settings: store.resolveAllWithSource(), feedHostSubscriptions: store.listFeedHostSubscriptions() });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  router.post("/init-workspace", async (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const body = (await c.req.json<InitWorkspaceBody>().catch(() => ({}))) as InitWorkspaceBody;
    const root = body.root ?? (store.resolveOne("workspace.root").value as string);
    const dryRun = !!body.dryRun;
    const result = ensureDefaultWorkspace({ root, dryRun });
    if (!result.ok) return c.json({ error: "init_workspace_conflict", ...result }, 409);
    return c.json(result);
  });

  router.get("/:key", (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const key = c.req.param("key");
    const removedMessage = removedContextSettingMessage(key);
    if (removedMessage) return c.json({ error: removedMessage, replacement: "context.root" }, 400);
    // OPR.0.4.4.15: the ONE registered dynamic class resolves here; every
    // other unknown key keeps the 400 below byte-for-byte.
    const dynamic = store.resolveFeedHostSubscription(key);
    if (dynamic) return c.json(dynamic);
    if (!isSettingsValidKey(key)) {
      return c.json({ error: `Unknown config key '${key}'`, validKeys: SETTINGS_VALID_KEYS }, 400);
    }
    return c.json(store.resolveOne(key));
  });

  router.post("/:key", async (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const key = c.req.param("key");
    const removedMessage = removedContextSettingMessage(key);
    if (removedMessage) return c.json({ error: removedMessage, replacement: "context.root" }, 400);
    const isDynamic = parseFeedHostSubscriptionKey(key) !== null;
    if (!isDynamic && !isSettingsValidKey(key)) {
      return c.json({ error: `Unknown config key '${key}'`, validKeys: SETTINGS_VALID_KEYS }, 400);
    }
    const body = (await c.req.json<{ value?: string }>().catch(() => ({}))) as { value?: string };
    if (typeof body.value !== "string") {
      return c.json({ error: "value_required", hint: "POST body must be { \"value\": <string> }" }, 400);
    }
    try {
      store.set(key, body.value);
      return c.json({ ok: true, key, resolved: isDynamic ? store.resolveFeedHostSubscription(key) : store.resolveOne(key as never) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  router.delete("/:key", (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    const key = c.req.param("key");
    const removedMessage = removedContextSettingMessage(key);
    if (removedMessage) return c.json({ error: removedMessage, replacement: "context.root" }, 400);
    const isDynamic = parseFeedHostSubscriptionKey(key) !== null;
    if (!isDynamic && !isSettingsValidKey(key)) {
      return c.json({ error: `Unknown config key '${key}'`, validKeys: SETTINGS_VALID_KEYS }, 400);
    }
    try {
      store.reset(key);
      return c.json({ ok: true, key, resolved: isDynamic ? store.resolveFeedHostSubscription(key) : store.resolveOne(key as never) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return router;
}
