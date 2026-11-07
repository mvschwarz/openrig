// A queue kept in one JSON file, so a test, the `rig exec` CLI process and its detached connector all see the same rows.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { AcpQueue, AcpQueueRow } from "../../src/acp/connector.js";

export type FileRow = AcpQueueRow & { notes: string[]; summary?: string };

export function readRows(file: string): Record<string, FileRow> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, FileRow>;
}

export function writeRows(file: string, rows: Record<string, FileRow>): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows));
  renameSync(tmp, file);
}

export function fileQueue(file: string): AcpQueue {
  const change = (fn: (rows: Record<string, FileRow>) => void) => { const rows = readRows(file); fn(rows); writeRows(file, rows); };
  let asks = 0;
  return {
    show: async (id) => {
      const row = readRows(file)[id];
      if (!row) throw new Error(`queue show ${id} returned HTTP 404`);
      return { ...row };
    },
    claim: async (id) => change((rows) => { rows[id]!.state = "in-progress"; }),
    update: async (id, update) => change((rows) => {
      rows[id]!.notes.push(update.note);
      if (update.state) rows[id]!.state = update.state;
    }),
    create: async (row) => {
      const id = `qitem-ask-${process.pid}-${++asks}`;
      change((rows) => { rows[id] = { qitemId: id, state: "pending", destinationSession: row.destination, body: row.body, resolution: null, tags: row.tags, notes: [], summary: row.summary }; });
      return id;
    },
  };
}
