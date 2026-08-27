// FOUNDER ROOT INVARIANT (L2 row, transitions 10816/10817, superseding ruling cb19867f Q2):
// inside ONE OpenRig instance, seat identity is bare `member@rig` on every durable row and
// rendered surface — local queue create, handoff wake envelope, local From lines and reply
// hints, and (downstream) the Slack thread map. Host identity is added ONLY at the cross-host
// forwarding boundary (routes/queue.ts stamp-at-FORWARD, preserved) and rides verbatim when a
// genuine origin triple arrives.
//
// RED at pre-fix bytes: the 51-09 always-suffix producers stamp the self-host id locally —
// create persists the triple, the frozen wake envelope renders the triple From/reply-hint,
// and the envelope wrapper appends the id it is handed. These pins fail until the local
// producers are deleted.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
// P8: the canonical migration list — never a hand-curated inline subset.
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { wrapPaneEnvelope } from "../src/lib/pane-envelope.js";
import { setSelfHostId, getSelfHostId } from "../src/domain/hosts/fanout-contract.js";

const TEST_HOST = "host-red-invariant";

describe("local bare identity — no self-host suffix on any intra-instance surface", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let outbox: OutboxHandler;
  let priorSelfId: string | null;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    outbox = new OutboxHandler(db);
    repo.attachOutbox(outbox);
    priorSelfId = getSelfHostId();
    setSelfHostId(TEST_HOST); // the boot-reconciled self id IS known — and must not leak locally
  });
  afterEach(() => {
    setSelfHostId(priorSelfId);
    db.close();
  });

  it("queue CREATE persists the bare transport identity — never the self-host triple", async () => {
    const row = await repo.create({
      sourceSession: "dev-driver@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "local row",
    });
    expect(row.sourceSession, "local source_session must stay bare member@rig").toBe("dev-driver@v-openrig-build");
    expect(row.sourceSession).not.toContain(TEST_HOST);
  });

  it("a genuine ORIGIN TRIPLE arriving at create (cross-host forward) is stored verbatim — the boundary semantics survive the local deletion", async () => {
    const row = await repo.create({
      sourceSession: "pm-lead@other-rig@host-remote1",
      destinationSession: "orch-lead@v-openrig-build",
      body: "forwarded row",
    });
    expect(row.sourceSession).toBe("pm-lead@other-rig@host-remote1"); // never re-stamped, never stripped
  });

  it("the HANDOFF frozen wake envelope renders bare From and a copy-paste-local reply hint", async () => {
    const row = await repo.create({
      sourceSession: "dev-driver@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "to hand off",
    });
    await repo.handoff({
      qitemId: row.qitemId,
      fromSession: "dev-driver@v-openrig-build",
      toSession: "orch-lead@v-openrig-build",
      nudge: true,
    });
    const intents = db
      .prepare("SELECT outbox_id, body FROM outbox_entries WHERE outbox_id LIKE ?")
      .all(`${WAKE_INTENT_PREFIX}%`) as { outbox_id: string; body: string }[];
    expect(intents.length).toBeGreaterThan(0);
    const env = intents[intents.length - 1]!.body;
    expect(env).toContain("From: dev-driver@v-openrig-build\n"); // bare, newline-bounded (not a triple prefix)
    expect(env).toContain(`↩ Reply: rig send dev-driver@v-openrig-build "..."`); // verbatim-usable locally
    expect(env).not.toContain(TEST_HOST);
  });

  it("the envelope wrapper renders a LOCAL sender exactly as received (no appended host id)", () => {
    // Called through a loose cast so this pin is signature-stable across the fix: pre-fix the
    // 4th argument is the selfHostId the callers pass (and gets appended — RED); post-fix the
    // parameter is gone and the sender renders as received (GREEN).
    const env = (wrapPaneEnvelope as (...args: unknown[]) => string)(
      "dev-driver@v-openrig-build",
      "orch-lead@v-openrig-build",
      "hello",
      TEST_HOST,
    );
    expect(env).toContain("From: dev-driver@v-openrig-build\n");
    expect(env).toContain(`↩ Reply: rig send dev-driver@v-openrig-build "..."`);
    expect(env).not.toContain(TEST_HOST);
  });

  it("the envelope wrapper preserves a genuine origin TRIPLE verbatim (cross-host From stays qualified)", () => {
    const env = (wrapPaneEnvelope as (...args: unknown[]) => string)(
      "pm-lead@other-rig@host-remote1",
      "orch-lead@v-openrig-build",
      "hello from afar",
      TEST_HOST,
    );
    expect(env).toContain("From: pm-lead@other-rig@host-remote1");
    expect(env).toContain(`↩ Reply: rig send pm-lead@other-rig@host-remote1 "..."`);
  });
});
