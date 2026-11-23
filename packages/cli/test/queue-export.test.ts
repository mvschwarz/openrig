import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const { OPENRIG_DB: _db, RIGGED_DB: _legacy, ...env } = process.env;
  return spawnSync(process.execPath, [fileURLToPath(new URL("../dist/bin-wrapper.js", import.meta.url)), "queue", "export", ...args], {
    encoding: "utf8", timeout: 5000, env: { ...env, OPENRIG_HOME: home },
  });
}

it("exports from the last launch database when db.path is not configured", () => {
  const db = join(home, "selected.sqlite");
  renameSync(join(home, "openrig.sqlite"), db);
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ db }));

  const result = run("--whole-host", "--preview");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ rows: [{ qitemId: "qitem-a" }] });
});

it("previews an unfrozen local archive without creating a file", () => {
  const result = run("--qitems", "qitem-a", "--preview");
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain("not_ready_for_activation");
  expect(JSON.parse(result.stdout)).toMatchObject({ format: "openrig.queue-transfer/v2", rows: [{ qitemId: "qitem-a", body: "task body" }] });
});

it("writes a private archive and refuses to overwrite it", () => {
  const out = join(home, "archive.json");
  const result = run("--whole-host", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(statSync(out).mode & 0o777).toBe(0o600);
  const bytes = readFileSync(out, "utf8");
  expect(JSON.parse(bytes).scope.qitemIds).toEqual(["qitem-a"]);
  expect(run("--whole-host", "--out", out).status).toBe(1);
  expect(readFileSync(out, "utf8")).toBe(bytes);
});

it("requires exactly one explicit source scope", () => {
  expect(run("--preview").status).toBe(1);
  expect(run("--whole-host", "--rig", "demo", "--preview").status).toBe(1);
});

it("does not print a success summary when the output file already exists", () => {
  const out = join(home, "openrig.sqlite");
  const result = run("--rig", "demo", "--out", out);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/^.*EEXIST.*\n$/);
});

it.each(["--rig", "--mission", "--slice", "--qitems", "--whole-host"])(
  "warns once without failing when %s matches nothing", flag => {
    if (flag === "--whole-host") {
      const db = new Database(join(home, "openrig.sqlite"));
      try { db.exec("DELETE FROM queue_items"); } finally { db.close(); }
    }
    const result = run(...(flag === "--whole-host" ? [flag] : [flag, "missing"]), "--preview");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ rows: [], erasedIds: [], erasedRigs: [] });
    expect(result.stderr.trim().split("\n")).toEqual([
      expect.stringMatching(new RegExp(`.*${flag}.*matched nothing`)),
      "not_ready_for_activation",
    ]);
  },
);

it("uses the configured archive byte limit for collection and sealing", () => {
  for (const limit of [1, 256]) {
    const result = run("--rig", "demo", "--preview", "--max-bytes", String(limit));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`archive_too_large: archive exceeds ${limit} bytes`);
    expect(result.stdout).toBe("");
  }
  expect(run("--rig", "demo", "--preview", "--max-bytes", "4096").status).toBe(0);
});

it.each(["0", "2.5", "1e6", "9007199254740992"])("rejects an invalid byte limit (%s)", limit => {
  const result = run("--rig", "demo", "--preview", "--max-bytes", limit);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("positive safe integer");
});

it("selects the local queue with --whole-host, not --host", () => {
  const result = run("--whole-host", "--preview");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ scope: { kind: "host" }, rows: [{ qitemId: "qitem-a" }] });
  expect(run("--host", "--preview").stderr).toContain("unknown option '--host'");
  expect(run("--help").stdout).toContain("--whole-host");
});

it("warns on a host-qualified rig selector and keeps the valid part", () => {
  const result = run("--rig", "demo@elsewhere", "--rig", "demo", "--preview");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ scope: { rigs: ["demo", "demo@elsewhere"] } });
  expect(result.stderr).toContain('"demo@elsewhere" is host-qualified and was not resolved or exported');
  expect(result.stderr).toContain("--qitems for exact rows");
});
