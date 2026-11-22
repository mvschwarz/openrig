import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { migrate } from "../../daemon/src/db/migrate.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "queue-export-"));
  const db = new Database(join(home, "openrig.sqlite"));
  try {
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO self_host_identity VALUES (1, 'origin', 'minted', 'reconciled');
      INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
      VALUES ('qitem-a', '1', '1', 'a@demo', 'b@demo', 'pending', 'task body');`);
  } finally {
    db.close();
  }
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(...args: string[]) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("../dist/bin-wrapper.js", import.meta.url)), "queue", "export", ...args], {
    encoding: "utf8", timeout: 5000, env: { ...process.env, OPENRIG_HOME: home, OPENRIG_DB: join(home, "openrig.sqlite") },
  });
}

it("previews an unfrozen local archive without creating a file", () => {
  const result = run("--qitems", "qitem-a", "--preview");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("not_ready_for_activation");
  expect(JSON.parse(result.stdout)).toMatchObject({ format: "openrig.queue-transfer/v2", rows: [{ qitemId: "qitem-a", body: "task body" }] });
});

it("writes a private archive and refuses to overwrite it", () => {
  const out = join(home, "archive.json");
  const result = run("--host", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(statSync(out).mode & 0o777).toBe(0o600);
  const bytes = readFileSync(out, "utf8");
  expect(JSON.parse(bytes).scope.qitemIds).toEqual(["qitem-a"]);
  expect(run("--host", "--out", out).status).toBe(1);
  expect(readFileSync(out, "utf8")).toBe(bytes);
});

it("requires exactly one explicit source scope", () => {
  expect(run("--preview").status).toBe(1);
  expect(run("--host", "--rig", "demo", "--preview").status).toBe(1);
});
