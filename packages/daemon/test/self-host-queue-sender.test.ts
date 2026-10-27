// SUPERSEDED CONTRACT FLIPPED (founder root invariant 2026-08-27, was 51-09 incr 4
// stamp-at-write): a LOCAL queue create stores the BARE transport identity; host identity is
// added only at the cross-host forwarding boundary (routes/queue.ts stamp-at-FORWARD), and an
// arriving origin triple is stored verbatim. Deep pins live in local-bare-identity.test.ts;
// this file keeps the original suite's seam (repo-level create) under the new contract.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { setSelfHostId, getSelfHostId } from "../src/domain/hosts/fanout-contract.js";

describe("queue sender identity — bare at local write, triple only from the forward boundary", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let prior: string | null;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    prior = getSelfHostId();
    setSelfHostId("mars-01");
  });
  afterEach(() => { setSelfHostId(prior); db.close(); });

  it("stores source_session BARE even with a reconciled self-id", async () => {
    const row = await repo.create({ sourceSession: "dev50-driver@v-openrig-build", destinationSession: "b@r", body: "x" });
    expect(row.sourceSession).toBe("dev50-driver@v-openrig-build");
  });

  it("stores a forwarded ORIGIN triple verbatim (the not-bare guard: never re-stamped)", async () => {
    const row = await repo.create({ sourceSession: "pm@other-rig@mm2-openrig1", destinationSession: "b@r", body: "x" });
    expect(row.sourceSession).toBe("pm@other-rig@mm2-openrig1");
  });
});
