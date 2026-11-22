import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { buildQueueTransfer } from "../../daemon/src/domain/queue-transfer-export.js";

let home: string;
let file: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "queue-import-"));
  file = join(home, "archive.json");
  const source = new Database(":memory:");
  const destination = new Database(join(home, "openrig.sqlite"));
  try {
    migrate(source, ALL_MIGRATIONS);
    migrate(destination, ALL_MIGRATIONS);
    source.exec(`INSERT INTO self_host_identity VALUES (1, 'origin', 'minted', 'reconciled');
      INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
      VALUES ('qitem-a', '1', '1', 'a@demo', 'b@demo', 'pending', 'archive body');`);
    writeFileSync(file, buildQueueTransfer(source, { kind: "host" }).archive);
  } finally {
    source.close();
    destination.close();
  }
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(...args: string[]): unknown {
  const result = invoke(...args);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function invoke(...args: string[]) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("../dist/bin-wrapper.js", import.meta.url)), "queue", ...args], {
    encoding: "utf8", timeout: 10_000, env: { ...process.env, OPENRIG_HOME: home, OPENRIG_DB: join(home, "openrig.sqlite") },
  });
}

it("dry-runs without a manifest, stages across CLI invocations, and discards by import ID", () => {
  expect(run("import", file, "--dry-run")).toMatchObject({ status: "not_ready_for_activation", dryRun: true, stage: null });
  expect(run("staging", "list")).toEqual([]);
  const result = run("import", file);
  expect(result).toMatchObject({ status: "not_ready_for_activation", stage: { status: "staged", rowCount: 1 } });
  const manifests = run("staging", "list");
  expect(manifests).toMatchObject([{ status: "staged" }]);
  if (!Array.isArray(manifests) || typeof manifests[0]?.importId !== "string") throw new Error("missing import ID");
  expect(run("staging", "discard", manifests[0].importId)).toMatchObject({ status: "discarded" });
});

it("exits nonzero with an explicit dry-run refusal for an unknown major", () => {
  writeFileSync(file, '{"format":"openrig.queue-transfer/v3"}');
  const result = invoke("import", file, "--dry-run");
  expect(result.status, result.stderr).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "rejected", refusals: [{ code: "format_unsupported" }] });
  expect(run("staging", "list")).toEqual([]);
});

it("uses the configured byte bound without truncating the archive", () => {
  const result = invoke("import", file, "--dry-run", "--max-bytes", "16");
  expect(result.status, result.stderr).toBe(2);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "rejected", refusals: [{ code: "archive_too_large" }] });
  expect(run("import", file, "--dry-run", "--max-bytes", "4096")).toMatchObject({ status: "not_ready_for_activation" });
});
