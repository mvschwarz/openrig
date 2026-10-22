import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { sessionStopIntentSchema } from "../src/db/migrations/103_session_stop_intent.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

describe("session stop intent migration", () => {
  it("preserves legacy sessions without inferring intent, and keeps new intent across migration reruns", () => {
    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS.filter((migration) => migration.name !== sessionStopIntentSchema.name));
      db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'upgrade')").run();
      db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node-1', 'rig-1', 'dev.qa')").run();
      for (const status of ["exited", "detached", "running"]) {
        db.prepare(
          "INSERT INTO sessions (id, node_id, session_name, status, resume_type, resume_token) VALUES (?, 'node-1', 'dev-qa@upgrade', ?, 'claude_session_id', ?)",
        ).run(status, status, `synthetic-token-${status}`);
      }
      const before = db.prepare("SELECT * FROM sessions ORDER BY id").all();

      migrate(db, ALL_MIGRATIONS);
      const after = db.prepare("SELECT * FROM sessions ORDER BY id").all() as Array<Record<string, unknown>>;
      expect(after.map(({ intentionally_stopped, ...session }) => {
        expect(intentionally_stopped).toBe(0);
        return session;
      })).toEqual(before);

      new SessionRegistry(db).markIntentionallyStopped("exited");
      migrate(db, ALL_MIGRATIONS);
      expect(db.prepare("SELECT status, intentionally_stopped, resume_token FROM sessions WHERE id = 'exited'").get())
        .toEqual({ status: "exited", intentionally_stopped: 1, resume_token: "synthetic-token-exited" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = ?").get(sessionStopIntentSchema.name))
        .toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
