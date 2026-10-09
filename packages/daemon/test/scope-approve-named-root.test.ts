// #995 — the caller's missions root travels WITH the approve request, so a
// second worktree of the same repo is stamped where the caller asked instead of
// in the daemon's own workspace. Before this, the daemon resolved the relative
// scopePath against its own root: the same relative path existed in both trees,
// so the stamp landed in the daemon's copy and the command reported success.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";
import { ScopeApproveError, ScopeApproveService } from "../src/domain/scope/scope-approve.js";

const SPEC = "---\nid: OPR.X.19\nstatus: building\n---\n\n# The slice\nbody prose stays intact\n";
const SCOPE_PATH = "release-x/slices/19-signal-layer";

describe("ScopeApproveService — the caller's missions root (#995)", () => {
  let db: Database.Database;
  let actionLog: MissionControlActionLog;
  let auditBrowse: MissionControlAuditBrowse;
  let daemonRoot: string;
  let namedRoot: string;

  /** A missions tree holding the same slice at the same relative path. */
  function seedRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-approve-root-"));
    const sliceDir = path.join(root, "release-x", "slices", "19-signal-layer");
    fs.mkdirSync(sliceDir, { recursive: true });
    fs.writeFileSync(path.join(sliceDir, "SPEC.md"), SPEC, "utf8");
    return root;
  }

  const specOf = (root: string): string =>
    fs.readFileSync(path.join(root, SCOPE_PATH, "SPEC.md"), "utf8");

  function frontmatterOf(root: string): Record<string, unknown> {
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(specOf(root));
    return m ? (YAML.parse(m[1]!) as Record<string, unknown>) : {};
  }

  function service(): ScopeApproveService {
    return new ScopeApproveService({ missionsRoot: () => daemonRoot, actionLog });
  }

  const input = {
    scopeTier: "slice" as const,
    scopePath: SCOPE_PATH,
    approvalScope: "delivery" as const,
    actorSession: "human-review@kernel",
  };

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, queueItemsSchema, missionControlActionsSchema]);
    actionLog = new MissionControlActionLog(db);
    auditBrowse = new MissionControlAuditBrowse(db);
    daemonRoot = seedRoot();
    namedRoot = seedRoot();
  });

  afterEach(() => {
    db.close();
    fs.rmSync(daemonRoot, { recursive: true, force: true });
    fs.rmSync(namedRoot, { recursive: true, force: true });
  });

  it("stamps the named tree and leaves the daemon's copy byte-for-byte unchanged", () => {
    const result = service().approve({ ...input, missionsRoot: namedRoot });

    expect(frontmatterOf(namedRoot)["approved-by"]).toBe("human-review@kernel");
    expect(specOf(daemonRoot)).toBe(SPEC);
    expect(result.scopePath).toBe(SCOPE_PATH);
  });

  it("records the root it wrote under in the audit row, next to scope_path", () => {
    service().approve({ ...input, missionsRoot: namedRoot });

    const rows = auditBrowse.query({ scopeId: "OPR.X.19" }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.auditNotes).toMatchObject({
      kind: "scope-approval",
      scope_path: SCOPE_PATH,
      missions_root: fs.realpathSync(namedRoot),
    });
  });

  it("counts a symlinked worktree as the same root", () => {
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "scope-approve-link-"));
    const link = path.join(linkParent, "linked-work");
    fs.symlinkSync(namedRoot, link);
    expect(fs.realpathSync(link)).not.toBe(link);

    service().approve({ ...input, missionsRoot: link });

    expect(frontmatterOf(namedRoot)["approved-by"]).toBe("human-review@kernel");
    expect(specOf(daemonRoot)).toBe(SPEC);
    const notes = auditBrowse.query({ scopeId: "OPR.X.19" }).rows[0]!.auditNotes as Record<string, unknown>;
    expect(notes.missions_root).toBe(fs.realpathSync(namedRoot));
    fs.rmSync(linkParent, { recursive: true, force: true });
  });

  it("writes the daemon's own root when the request carries no named root", () => {
    for (const missionsRoot of [undefined, null]) {
      fs.writeFileSync(path.join(daemonRoot, SCOPE_PATH, "SPEC.md"), SPEC, "utf8");
      db.exec("DELETE FROM mission_control_actions");

      service().approve({ ...input, missionsRoot });

      expect(frontmatterOf(daemonRoot)["approved-by"]).toBe("human-review@kernel");
      expect(specOf(namedRoot)).toBe(SPEC);
      const notes = auditBrowse.query({ scopeId: "OPR.X.19" }).rows[0]!.auditNotes as Record<string, unknown>;
      expect(notes.missions_root).toBe(fs.realpathSync(daemonRoot));
    }
  });

  it("refuses a named root that is not an existing directory, writing nothing", () => {
    const filePath = path.join(namedRoot, "a-file");
    fs.writeFileSync(filePath, "not a directory", "utf8");

    for (const bad of [path.join(namedRoot, "does-not-exist"), filePath, "relative/missions"]) {
      let err: unknown;
      try {
        service().approve({ ...input, missionsRoot: bad });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ScopeApproveError);
      expect((err as ScopeApproveError).code).toBe("missions_root_invalid");
      // Neither tree was touched, and no audit row was left behind.
      expect(specOf(daemonRoot)).toBe(SPEC);
      expect(specOf(namedRoot)).toBe(SPEC);
      expect(auditBrowse.query({ scopeId: "OPR.X.19" }).rows).toHaveLength(0);
    }
  });

  it("still refuses a scopePath that escapes the named root", () => {
    let err: unknown;
    try {
      service().approve({ ...input, scopePath: "../escape", missionsRoot: namedRoot });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScopeApproveError);
    expect((err as ScopeApproveError).code).toBe("scope_path_escape");
    expect(specOf(namedRoot)).toBe(SPEC);
    expect(specOf(daemonRoot)).toBe(SPEC);
  });
});
