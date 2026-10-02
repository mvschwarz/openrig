import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { makeInboundFilePort } from "../src/domain/gateway/slack/slack-subsystem.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";

it("retains new and still-failing events across overlapping retries while successful work lands once", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-dead-retry-"));
  const db = createDb(join(home, "state.sqlite"));
  migrate(db, ALL_MIGRATIONS);
  let unavailable = true;
  const repo = new QueueRepository(db, new EventBus(db), {
    validateRig: (destination) => !unavailable || destination !== "worker@missing-rig",
  });
  const seen = new SeenStore(join(home, "seen.jsonl"));
  const dead = new DeadLetterStore<SlackEvent>(join(home, "dead.jsonl"));
  let started!: () => void;
  let release!: () => void;
  const downloading = new Promise<void>((resolve) => { started = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const server = createServer(async (_req, res) => {
    started();
    await released;
    res.setHeader("content-type", "application/octet-stream");
    res.end("fixture attachment");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const files = makeInboundFilePort({
      token: "synthetic-fixture-token", mediaDir: join(home, "media"),
      fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init),
    });
    const router = new InboundRouter({
      queue: makeQueuePorts(repo), seen, deadLetter: dead, files,
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human-fixture@external" }),
      resolveRoute: (event) => ({ destination: event.ts === "1000.1" ? "operator-agent@kernel" : "worker@missing-rig" }),
    });
    const old = { type: "message", user: "U-FIXTURE", channel: "C-FIXTURE", text: "recover attachment", ts: "1000.1",
      files: [{ name: "fixture.txt", url_private: "https://files.slack.com/fixture" }] };
    const failed = { type: "message", user: "U-FIXTURE", channel: "C-FIXTURE", text: "previously failed", ts: "1000.2" };
    const fresh = { type: "message", user: "U-FIXTURE", channel: "C-FIXTURE", text: "new owed work", ts: "1000.3" };
    dead.append(old, 1);
    dead.append(failed, 1);
    const retry = router.retryDeadLetters();
    await downloading;
    const overlap = router.retryDeadLetters();
    expect((await router.route(fresh)).disposition).toBe("dead-lettered");
    release();
    expect(await retry).toEqual({ retried: 2, landed: 1 });
    expect(await overlap).toEqual({ retried: 2, landed: 1 });
    expect(dead.readAll().map(({ ev, attempts }) => ({ ts: ev.ts, attempts }))).toEqual([
      { ts: failed.ts, attempts: 2 }, { ts: fresh.ts, attempts: 1 },
    ]);
    expect(repo.list({ limit: 100 })).toHaveLength(1);
    expect(seen.load().has(fresh.ts)).toBe(false);
    unavailable = false;
    expect(await router.retryDeadLetters()).toEqual({ retried: 2, landed: 2 });
    expect(dead.readAll()).toEqual([]);
    expect(repo.list({ limit: 100 })).toHaveLength(3);
    expect(await router.retryDeadLetters()).toEqual({ retried: 0, landed: 0 });
    expect(repo.list({ limit: 100 })).toHaveLength(3);
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("keeps later identical appends when replacing a processed action snapshot", () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-action-batch-"));
  try {
    const store = new DeadLetterStore(join(home, "actions.jsonl"), undefined, () => new Date("2026-10-01T00:00:00Z"));
    store.append({ type: "block_actions", action: "first" }, 1);
    const snapshot = store.readAll();
    store.append({ type: "block_actions", action: "first" }, 1);
    store.append({ type: "block_actions", action: "new" }, 1);
    store.replaceBatch(snapshot, snapshot.map((entry) => ({ ...entry, attempts: 2 })));
    expect(store.readAll().map(({ ev, attempts }) => ({ ev, attempts }))).toEqual([
      { ev: { type: "block_actions", action: "first" }, attempts: 2 },
      { ev: { type: "block_actions", action: "first" }, attempts: 1 },
      { ev: { type: "block_actions", action: "new" }, attempts: 1 },
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
