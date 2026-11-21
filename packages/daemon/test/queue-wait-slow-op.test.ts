import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { createSlowOpRequestMiddleware, SlowOpRecorder } from "../src/domain/slow-op-recorder.js";
import { queueRoutes } from "../src/routes/queue.js";

describe("queue wait request measurements", () => {
  let db: ReturnType<typeof createDb>;
  let bus: EventBus;
  let repo: QueueRepository;
  let recorder: SlowOpRecorder;
  let home: string;
  let logPath: string;
  let app: Hono;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-wait-slow-op-"));
    logPath = path.join(home, "slow.jsonl");
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
    recorder = new SlowOpRecorder({ logPath });
    app = new Hono();
    let clock = 0;
    app.use("*", createSlowOpRequestMiddleware(recorder, () => clock));
    app.use("*", async (c, next) => {
      c.set("queueRepo", repo);
      c.set("eventBus", bus);
      await next();
      // Deterministic slow duration; exercise the actual recorder without a sleep.
      clock += 1_000;
    });
    app.route("/api/queue", queueRoutes());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await recorder.close();
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function records(): Promise<unknown[]> {
    await recorder.flush();
    const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
  }

  async function create() {
    return repo.create({ sourceSession: "lead@team", destinationSession: "lead@team", body: "Question", nudge: false });
  }

  it("does not log an intentional timeout as a slow request, but retains synchronous measurements", async () => {
    const item = await create();
    const response = await app.request(`/api/queue/${item.qitemId}?waitSeconds=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "pending", waited: { outcome: "timeout", seconds: 1 } });
    recorder.recordSlowSync("queue.test.slow-read", 1_000, "ok");
    expect(await records()).toMatchObject([{ site: "queue.test.slow-read", durationMs: 1_000 }]);
  });

  it("does not log a waited answer as slow and still measures the next ordinary read", async () => {
    const item = await create();
    const timer = setTimeout(() => repo.update({ qitemId: item.qitemId, actorSession: "lead@team",
      state: "done", closureReason: "no-follow-on", nudge: false }), 20);
    try {
      const response = await app.request(`/api/queue/${item.qitemId}?waitSeconds=1`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "done" });
      expect(await records()).toEqual([]);
      expect((await app.request(`/api/queue/${item.qitemId}`)).status).toBe(200);
      expect(await records()).toMatchObject([{ site: `request:GET /api/queue/${item.qitemId}`, durationMs: 1_000 }]);
    } finally { clearTimeout(timer); }
  });

  it.each(["", "?waitSeconds=0", "?waitSeconds=-1", "?waitSeconds=51", "?waitSeconds=invalid"])(
    "keeps ordinary or invalid reads measured (%s)", async query => {
      const item = await create();
      const response = await app.request(`/api/queue/${item.qitemId}${query}`);
      expect(response.status).toBe(query && query !== "?waitSeconds=0" ? 400 : 200);
      expect(await records()).toMatchObject([{ site: `request:GET /api/queue/${item.qitemId}`, durationMs: 1_000 }]);
    });

  it("keeps missing waited items measured", async () => {
    expect((await app.request("/api/queue/qitem-missing?waitSeconds=1")).status).toBe(404);
    expect(await records()).toMatchObject([{ site: "request:GET /api/queue/qitem-missing", durationMs: 1_000 }]);
  });

  it("records a slow read of an already-finished item even with a positive wait", async () => {
    const item = await create();
    repo.update({ qitemId: item.qitemId, actorSession: "lead@team", state: "done", closureReason: "no-follow-on", nudge: false });
    const response = await app.request(`/api/queue/${item.qitemId}?waitSeconds=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ state: "done" });
    expect(await records()).toMatchObject([{ site: `request:GET /api/queue/${item.qitemId}`, durationMs: 1_000 }]);
  });

  it("still records an error after a genuinely parked read", async () => {
    const item = await create();
    vi.spyOn(repo, "closingTransition").mockImplementationOnce(() => { throw new Error("projection failed"); });
    app.onError((_error, c) => c.json({ error: "projection_failed" }, 500));
    const timer = setTimeout(() => repo.update({ qitemId: item.qitemId, actorSession: "lead@team",
      state: "done", closureReason: "no-follow-on", nudge: false }), 20);
    try {
      expect((await app.request(`/api/queue/${item.qitemId}?waitSeconds=1`)).status).toBe(500);
      expect(await records()).toMatchObject([{ site: `request:GET /api/queue/${item.qitemId}`, durationMs: 1_000 }]);
    } finally { clearTimeout(timer); }
  });
});
