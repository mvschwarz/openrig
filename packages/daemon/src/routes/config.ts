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
import { settingsBrowser } from "../domain/user-settings/settings-browser.js";
import { resolveDefaultReceiver, type DefaultReceiver } from "../domain/default-receiver.js";
import type { QueueRepository } from "../domain/queue-repository.js";
import {
  SETTINGS_VALID_KEYS,
  isBoundarySettingKey,
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

/** The event bus surface this route needs; the daemon's bus is wider than this. */
interface SettingsEventBus {
  emit?(event: { type: "settings.changed"; key: string; action: "set" | "reset" }): unknown;
}

/**
 * Record that a key which decides what this daemon may reach changed over HTTP.
 *
 * Stored rather than transient, so a person asking later why the file surface changed has something to
 * find. Its own try/catch, and called after the write: this reads the database to allocate a sequence
 * number, and a failure here must not change the response to a write that already happened.
 */
function recordSettingsChange(c: { get(key: never): unknown }, key: string, action: "set" | "reset"): void {
  try {
    (c.get("eventBus" as never) as SettingsEventBus | undefined)?.emit?.({ type: "settings.changed", key, action });
  } catch (err) {
    console.error(`settings.changed for ${key} (${action}) could not be recorded:`, err);
  }
}

export function configRoutes(opts: { home?: string } = {}): Hono {
  const router = new Hono();

  router.get("/", (c) => {
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    if (!store) return c.json({ error: "settings_unavailable" }, 503);
    if (c.req.query("view") === "browser") {
      const gateway = c.get("gatewaySubsystem" as never) as { status(): Record<string, unknown> } | undefined;
      let observed: Record<string, unknown> | null = null;
      try { observed = gateway?.status() ?? null; } catch { /* configuration still browsable */ }
      let receiver: DefaultReceiver | null = null;
      try {
        const repo = c.get("queueRepo" as never) as QueueRepository | undefined;
        if (repo) receiver = resolveDefaultReceiver(repo.db);
      } catch { /* the rest stays browsable; the receiver row is left out */ }
      return c.json(settingsBrowser(store, observed, opts.home, receiver));
    }
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
    try {
      return c.json(store.resolveOne(key));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
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
      // After the save, never inside its outcome: publishing reads the database to allocate a sequence
      // number, and a failure there must not turn a write that happened into a 400 the client retries.
      if (isBoundarySettingKey(key)) recordSettingsChange(c, key, "set");
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
      if (isBoundarySettingKey(key)) recordSettingsChange(c, key, "reset");
      return c.json({ ok: true, key, resolved: isDynamic ? store.resolveFeedHostSubscription(key) : store.resolveOne(key as never) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return router;
}
