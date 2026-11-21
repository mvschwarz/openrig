// A caller can already save and reset `files.allowlist` and `progress.scan_roots` through the config
// routes the Settings page uses, and it stays that way. What a reader of the event stream could not
// see before is that either one changed, so a change is published as `settings.changed`. The point is
// the record, not a refusal.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configRoutes } from "../src/routes/config.js";
import { EventBus } from "../src/domain/event-bus.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

/** A config route with a settings store in one temporary home, and an event bus to watch. */
function build(options: { bus?: unknown } = {}) {
  const home = mkdtempSync(join(tmpdir(), "config-events-"));
  const db = createDb(":memory:");
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const seen: Array<{ type: string; key?: string; action?: string }> = [];
  bus.subscribe((event) => { seen.push(event as { type: string; key?: string; action?: string }); });
  const app = new Hono();
  const store = new SettingsStore(join(home, "config.json"));
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, options.bus ?? bus);
    c.set("settingsStore" as never, store);
    await next();
  });
  app.route("/api/config", configRoutes({ home }));
  const post = (key: string, value: string) => app.request(`/api/config/${encodeURIComponent(key)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }),
  });
  const del = (key: string) => app.request(`/api/config/${encodeURIComponent(key)}`, { method: "DELETE" });
  const changes = () => seen.filter((event) => event.type === "settings.changed");
  /** The rows the event stream kept, which is what makes the record findable later. */
  const storedChanges = () => db.prepare("SELECT type, payload FROM events WHERE type = 'settings.changed' ORDER BY seq").all() as
    { type: string; payload: string }[];
  return { app, post, del, changes, storedChanges, done: () => { db.close(); rmSync(home, { recursive: true, force: true }); } };
}

describe("a boundary setting changed over HTTP is recorded on the event stream", () => {
  it("publishes settings.changed when files.allowlist is set, and still saves it", async () => {
    const f = build();
    try {
      const res = await f.post("files.allowlist", "workspace:/tmp/ws");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, key: "files.allowlist" });
      expect(f.changes()).toMatchObject([{ type: "settings.changed", key: "files.allowlist", action: "set" }]);
      // Stored, not transient: the row is what someone asking later can find.
      const rows = f.storedChanges();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toContain("files.allowlist");
    } finally { f.done(); }
  });

  it("publishes settings.changed when progress.scan_roots is set", async () => {
    const f = build();
    try {
      expect((await f.post("progress.scan_roots", "workspace:/tmp/ws")).status).toBe(200);
      expect(f.changes()).toMatchObject([{ type: "settings.changed", key: "progress.scan_roots", action: "set" }]);
    } finally { f.done(); }
  });

  it("publishes settings.changed with the reset action on DELETE", async () => {
    const f = build();
    try {
      expect((await f.del("files.allowlist")).status).toBe(200);
      expect(f.changes()).toMatchObject([{ type: "settings.changed", key: "files.allowlist", action: "reset" }]);
    } finally { f.done(); }
  });

  it("stays quiet for a setting that does not define a boundary", async () => {
    const f = build();
    try {
      expect((await f.post("workspace.slices_root", "/tmp/slices")).status).toBe(200);
      expect(f.changes()).toEqual([]);
    } finally { f.done(); }
  });

  it("records nothing when the write is refused", async () => {
    const f = build();
    try {
      const res = await f.post("policies.claude_compaction.threshold_percent", "101");
      expect(res.status).toBe(400);
      expect(f.changes()).toEqual([]);
      expect(f.storedChanges()).toEqual([]);
    } finally { f.done(); }
  });

  it("keeps a successful write successful when the event cannot be recorded", async () => {
    // Publishing reads the database to allocate a sequence number. A failure there happens after the
    // value is saved, so it must not surface as a 400 the client would retry as a failed write.
    const f = build({ bus: { emit: () => { throw new Error("events table unavailable"); } } });
    try {
      const res = await f.post("files.allowlist", "workspace:/tmp/ws");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, key: "files.allowlist" });
    } finally { f.done(); }
  });
});