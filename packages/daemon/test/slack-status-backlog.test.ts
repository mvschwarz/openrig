// F2 — `rig slack status` shows the durable inbound dead-letter backlog. The
// connector status reported Socket, Recovery and per-process recovery counts,
// but never the backlog sitting in the dead-letter files: inbound events and
// button clicks that failed to land and await the retry loop. Across a restart
// the per-process counter resets to zero while the durable file keeps growing,
// so an operator had to read the raw JSONL to learn that messages were stuck.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";

type WireStatus = Record<string, unknown> & { deadLetterBacklog?: number | null; deadLetterBacklogState?: string; deadLetterBacklogReason?: string };

describe("slack status: durable inbound dead-letter backlog", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "slack-status-backlog-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });

  const configure = (enabled: boolean) => {
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled, channel: "C-TEST", secretsEnvFile: secrets }, home);
  };
  const record = (i: number) => JSON.stringify({ ev: { type: "message", text: `stuck ${i}` }, at: "2026-10-08T00:00:00Z", attempts: i + 1 }) + "\n";
  const writeRecords = (file: string, entries: number) => {
    mkdirSync(join(home, "state"), { recursive: true });
    for (let i = 0; i < entries; i++) appendFileSync(join(home, "state", file), record(i));
  };
  const writeBacklog = (entries: number) => writeRecords("slack-inbound-deadletter.jsonl", entries);
  const writeActionBacklog = (entries: number) => writeRecords("slack-inbound-action-deadletter.jsonl", entries);
  const build = () => {
    const repo = new QueueRepository(db, new EventBus(db));
    return buildSlackGatewayWire({ home, queueRepo: repo });
  };

  it("reports the retained dead-letter records awaiting retry on an enabled connector", () => {
    configure(true);
    writeBacklog(3);
    const wire = build();
    try {
      expect((wire.status() as WireStatus).deadLetterBacklog).toBe(3);
      expect((wire.status() as WireStatus).deadLetterBacklogState).toBe("ok");
    } finally { wire.stop(); }
  });

  it("counts the click dead-letter file too, so the number is every record the retry pass owns", () => {
    configure(true);
    writeBacklog(2);
    writeActionBacklog(3);
    const wire = build();
    try {
      expect((wire.status() as WireStatus).deadLetterBacklog).toBe(5);
    } finally { wire.stop(); }
  });

  it("reports zero when nothing is stuck", () => {
    configure(true);
    const wire = build();
    try {
      expect((wire.status() as WireStatus).deadLetterBacklog).toBe(0);
      expect((wire.status() as WireStatus).deadLetterBacklogState).toBe("ok");
    } finally { wire.stop(); }
  });

  it("reports a null backlog alongside the state when a file cannot be read, never a false zero", () => {
    configure(true);
    mkdirSync(join(home, "state", "slack-inbound-deadletter.jsonl"), { recursive: true }); // a directory reads as an error
    const wire = build();
    try {
      const status = wire.status() as WireStatus;
      // A number next to an unknown state would still read as "nothing stuck" to any
      // consumer that only looks at the count, so the count is null, not 0.
      expect(status.deadLetterBacklog).toBeNull();
      expect(status.deadLetterBacklogState).toBe("unknown");
      expect(typeof status.deadLetterBacklogReason).toBe("string");
      expect(status.deadLetterBacklogReason).not.toHaveLength(0);
    } finally { wire.stop(); }
  });

  it("omits every field on an inert (disabled) connector rather than lying about it", () => {
    configure(false);
    writeBacklog(2);
    const wire = build();
    try {
      const status = wire.status() as WireStatus;
      expect(Object.hasOwn(status, "deadLetterBacklog")).toBe(false);
      expect(Object.hasOwn(status, "deadLetterBacklogState")).toBe(false);
      expect(Object.hasOwn(status, "deadLetterBacklogReason")).toBe(false);
    } finally { wire.stop(); }
  });
});

describe("DeadLetterStore.readResult keeps absent apart from unreadable", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "deadletter-readresult-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it("treats an absent file as a real empty set", () => {
    const store = new DeadLetterStore<{ t: number }>(join(home, "absent.jsonl"));
    const result = store.readResult();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entries).toEqual([]);
  });

  it("names a read failure instead of reporting an empty set", () => {
    const file = join(home, "adir.jsonl");
    mkdirSync(file, { recursive: true });
    const result = new DeadLetterStore<{ t: number }>(file).readResult();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toHaveLength(0);
  });

  it("readAll still returns the entries for a healthy file", () => {
    const file = join(home, "ok.jsonl");
    writeFileSync(file, JSON.stringify({ ev: { t: 1 }, at: "2026-10-08T00:00:00Z", attempts: 1 }) + "\n");
    expect(new DeadLetterStore<{ t: number }>(file).readAll()).toHaveLength(1);
  });
});
