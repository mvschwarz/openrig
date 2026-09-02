import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import {
  addHumanFragment,
  listHumans,
  loadHumanRegistry,
  projectionPath,
  showHuman,
  validateHumanFragment,
} from "../src/domain/gateway/human-registry.js";
import { resolveExternal } from "../src/domain/gateway/external-admission.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { parseSessionName } from "../src/domain/session-name.js";
import { queueRoutes } from "../src/routes/queue.js";

const PROJECTION_HEADER =
  "# GENERATED FILE — DO NOT EDIT.\n" +
  "# Projection of the human fragments under gateway/humans/<entityId>.yaml.\n" +
  "# The fragment is truth: add/edit a human via its fragment (or `rig gateway human\n" +
  "# add`), then re-project. A hand-edit here is REFUSED at load.\n";

const HUMAN = {
  entityId: "founder",
  class: "human",
  displayName: "Founder",
  address: "founder@external",
  connectorBindings: [
    { kind: "slack", connectorRef: "main", secretsRef: "vault://founder", role: "primary" },
  ],
  prefs: { deliveryClass: "B" },
};

function adoptedV2Projection(): string {
  const validated = validateHumanFragment(HUMAN);
  if (!validated.ok) throw new Error(validated.error);
  const entityBody = stringifyYaml({ entities: [validated.fragment] });
  const digest = createHash("sha256").update(entityBody).digest("hex");
  return `${PROJECTION_HEADER}# Projection format: v2 content-addressed\n# projection-body-sha256: ${digest}\n${entityBody}`;
}

describe("public human registry -> queue admission journey", () => {
  let home: string;
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "human-queue-journey-"));
    expect(addHumanFragment(HUMAN, home).ok).toBe(true);

    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, inboxEntriesSchema, outboxEntriesSchema]);
    const bus = new EventBus(db);
    const registry = () => loadHumanRegistry(home);
    const validateRig = (sessionRef: string): boolean => {
      const parsed = parseSessionName(sessionRef);
      if (parsed.kind === "external") {
        const loaded = registry();
        const entities = loaded.ok
          ? loaded.entities.map(({ entityId, address }) => ({ entityId, address }))
          : [];
        return resolveExternal(parsed.local, entities).kind !== "unregistered";
      }
      return parsed.kind === "canonical" && parsed.rig === "known-rig";
    };
    const queueRepo = new QueueRepository(db, bus, { validateRig, loadHumanRegistry: registry });
    const inbox = new InboxHandler(db, bus, queueRepo);
    const outbox = new OutboxHandler(db);
    queueRepo.attachOutbox(outbox);
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, bus);
      c.set("queueRepo" as never, queueRepo);
      c.set("inboxHandler" as never, inbox);
      c.set("outboxHandler" as never, outbox);
      await next();
    });
    app.route("/api/queue", queueRoutes());
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const humanDestination = {
    destinationSession: "founder@external",
    body: "bounded public human queue journey",
    summary: "Public human registry and queue admission agree",
    evidenceRef: "release-0.5.8/slices/10-human-topology-journey/SPEC.md",
    nudge: false,
  };

  it("admits through queue create and handoff the same human shown by gateway list/show from an adopted v2 projection", async () => {
    writeFileSync(projectionPath(home), adoptedV2Projection());

    expect(listHumans(home)).toMatchObject({ ok: true, humans: [{ entityId: "founder", address: "founder@external" }] });
    expect(showHuman("founder", home)).toMatchObject({ ok: true, record: { entityId: "founder", address: "founder@external" } });

    const created = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "agent@known-rig" },
      body: JSON.stringify(humanDestination),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ destinationSession: "founder@external" });

    const source = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "agent@known-rig" },
      body: JSON.stringify({ destinationSession: "worker@known-rig", body: "handoff source", nudge: false }),
    });
    const sourceRow = await source.json() as { qitemId: string };
    const handed = await app.request(`/api/queue/${sourceRow.qitemId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@known-rig" },
      body: JSON.stringify({ toSession: "founder@external", ...humanDestination }),
    });
    expect(handed.status).toBe(201);
    expect(await handed.json()).toMatchObject({ created: { destinationSession: "founder@external" } });
  });

  it("reports a malformed projection as human_registry_unavailable with its cause", async () => {
    writeFileSync(projectionPath(home), `${readFileSync(projectionPath(home), "utf8")}# hand edit\n`);

    const response = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "agent@known-rig" },
      body: JSON.stringify(humanDestination),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ error: "human_registry_unavailable", registryLoadError: true, registryProjectionError: true });
    expect(String(body.registryError)).toMatch(/manual edit|hand-edited|canonical/i);
    expect(body).not.toHaveProperty("unregisteredEntity");
    expect(db.prepare("SELECT COUNT(*) AS count FROM queue_items").get()).toMatchObject({ count: 0 });
  });

  it("keeps unknown-human teaching when the registry is healthy", async () => {
    const response = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "agent@known-rig" },
      body: JSON.stringify({ ...humanDestination, destinationSession: "stranger@external" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ error: "unknown_destination_rig", unregisteredEntity: "stranger" });
    expect(String(body.hint)).toMatch(/no registered human|rig gateway human add/i);
    expect(body).not.toHaveProperty("registryLoadError");
  });
});
