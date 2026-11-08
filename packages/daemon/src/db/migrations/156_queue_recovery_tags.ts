import type { Migration } from "../migrate.js";

/** The tag values queue_recovery_tags holds: the ones looked up by exact value (findQueueRecovery's `recovery-for:<id>`
 *  and the stuck sweep's `stuck-sweep:<kind>:<id>` dedup tag). */
const KEPT = `typeof(j.value) = 'text' AND (substr(j.value, 1, 13) = 'recovery-for:' OR substr(j.value, 1, 12) = 'stuck-sweep:')`;
/** json_each of a row's tags, as the per-row queries read them: nothing for NULL or invalid JSON. */
const VALUES = (tags: string) => `json_each(CASE WHEN json_valid(${tags}) THEN ${tags} ELSE '[]' END) j`;

/**
 * findQueueRecovery (the live read) and the stuck sweep's dedup lookup search queue_items by an exact tag value with
 * json_each, through the partial index of migration 099. That index narrows the scan to the tagged rows, but it holds
 * every finding and recovery ever made, open or closed, and only grows: each lookup parses all of them (2.2-6.7 ms
 * on a 23k-row queue with 2781 tagged rows), once per stuck candidate and per wake-ladder member.
 *
 * queue_recovery_tags is that lookup as a table: one row per (tag value, queue row) for the top-level text values of a
 * row's tags (valid JSON, as json_each reads them) that start with `recovery-for:` or `stuck-sweep:`. Triggers keep it
 * equal to queue_items on every insert, update of tags and delete, whoever writes (several writers set tags with a bare
 * UPDATE), and the backfill fills it from the rows already there.
 */
export const queueRecoveryTagsSchema: Migration = {
  name: "156_queue_recovery_tags.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS queue_recovery_tags (
      tag TEXT NOT NULL,
      qitem_id TEXT NOT NULL,
      PRIMARY KEY (tag, qitem_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_queue_recovery_tags_qitem ON queue_recovery_tags(qitem_id);

    INSERT OR IGNORE INTO queue_recovery_tags(tag, qitem_id)
      SELECT j.value, q.qitem_id FROM queue_items q, ${VALUES("q.tags")}
       WHERE ((q.tags LIKE '%"recovery-for:%' OR q.tags LIKE '%\\%') OR q.tags LIKE '%"stuck-sweep:%') AND ${KEPT};

    CREATE TRIGGER IF NOT EXISTS trg_queue_recovery_tags_insert AFTER INSERT ON queue_items
    BEGIN
      INSERT OR IGNORE INTO queue_recovery_tags(tag, qitem_id)
        SELECT j.value, new.qitem_id FROM ${VALUES("new.tags")} WHERE ${KEPT};
    END;

    CREATE TRIGGER IF NOT EXISTS trg_queue_recovery_tags_update AFTER UPDATE OF tags, qitem_id ON queue_items
    BEGIN
      DELETE FROM queue_recovery_tags WHERE qitem_id = old.qitem_id;
      INSERT OR IGNORE INTO queue_recovery_tags(tag, qitem_id)
        SELECT j.value, new.qitem_id FROM ${VALUES("new.tags")} WHERE ${KEPT};
    END;

    CREATE TRIGGER IF NOT EXISTS trg_queue_recovery_tags_delete AFTER DELETE ON queue_items
    BEGIN
      DELETE FROM queue_recovery_tags WHERE qitem_id = old.qitem_id;
    END;
  `,
};
