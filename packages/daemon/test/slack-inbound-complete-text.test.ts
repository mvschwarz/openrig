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
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";

it("keeps complete short and long human briefs durable while bounding summaries and deduplicating retries", async () => {
  const home = mkdtempSync(join(tmpdir(), "openrig-slack-complete-"));
  const db = createDb(join(home, "state.sqlite"));
  migrate(db, ALL_MIGRATIONS);
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  const seen = new SeenStore(join(home, "seen.jsonl"));
  const deadLetter = new DeadLetterStore<SlackEvent>(join(home, "dead.jsonl"));
  const router = new InboundRouter({
    queue: makeQueuePorts(repo), seen, deadLetter, destination: "operator-agent@kernel",
    resolveSender: () => ({ admitted: true, source: "human-fixture@external" }),
  });
  try {
    for (const [index, text] of ["Short complete brief.", "x".repeat(1799) + "🧪\nKeep this final condition."].entries()) {
      const event = { type: "message", user: "U-FIXTURE", channel: "C-FIXTURE", text, ts: `1000.${index}` };
      const result = await router.route(event);
      expect(result.disposition).toBe("accepted");
      const row = repo.getById(result.qitemId!)!;
      expect(row.body).toBe(`${text}\n\n---\nSource: slack channel=C-FIXTURE user=U-FIXTURE ts=${event.ts}\nRouted by openrig slack-inbound. Default destination per config; re-route via queue as needed.`);
      expect(row.summary).toBe(`Founder via Slack: ${text.slice(0, 90)}`);
      expect(seen.load().has(event.ts)).toBe(true);
      expect((await router.route(event)).disposition).toBe("ignored");
    }
    expect(repo.list({ limit: 100 })).toHaveLength(2);
    expect(deadLetter.readAll()).toEqual([]);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
