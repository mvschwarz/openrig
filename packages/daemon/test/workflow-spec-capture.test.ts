import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const fileProbe = vi.hoisted(() => ({
  readPaths: [] as string[],
  afterRead: null as null | ((file: string, value: unknown) => void),
  statOverrides: new Map<string, { mtimeMs: number; ctimeMs: number }>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = vi.fn(((file: unknown, ...args: unknown[]) => {
    const value = actual.readFileSync(file as never, ...(args as never[]));
    const filePath = String(file);
    fileProbe.readPaths.push(filePath);
    fileProbe.afterRead?.(filePath, value);
    return value;
  }) as typeof actual.readFileSync);
  const statSync = vi.fn(((file: unknown, ...args: unknown[]) => {
    const override = fileProbe.statOverrides.get(String(file));
    if (override) return { ...override, isFile: () => true } as ReturnType<typeof actual.statSync>;
    return actual.statSync(file as never, ...(args as never[]));
  }) as typeof actual.statSync);
  return { ...actual, readFileSync, statSync };
});

import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowSpecsDiagnosticSchema } from "../src/db/migrations/040_workflow_specs_diagnostic.js";
import { WorkflowSpecCache } from "../src/domain/workflow-spec-cache.js";
import { scanWorkflowSpecFolder } from "../src/domain/spec-library-workflow-scanner.js";
import { ActiveLensStore } from "../src/domain/active-lens-store.js";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { specLibraryRoutes } from "../src/routes/spec-library.js";

const VALID_YAML = (id: string) => `workflow:
  id: ${id}
  version: '1'
  objective: capture fixture
  target:
    rig: capture-fixture
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@capture-fixture
  steps:
    - id: produce
      actor_role: producer
      objective: Draft.
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - done
`;
const BROKEN_YAML = "workflow:\n  id: capture-repair\n  version: [unterminated\n";
const CAPTURE_TIME = new Date("2035-01-02T03:04:05.100Z");
const LATER_TIME = new Date("2035-01-02T03:04:06.100Z");
const TOUCHED_STAT_TIME = new Date("2035-01-02T03:04:06.900Z").getTime();
const P3_REFRESH_TIME = new Date("2035-01-02T03:04:07.100Z");
const NEWER_VERIFIED_TIME = new Date("2035-01-02T03:04:08.100Z");
const BACKWARDS_TIME = new Date("2035-01-02T03:04:07.100Z");
const NEWER_SQLITE_TIMESTAMP = "2035-01-02 03:04:08.100Z";
const OLDER_STAT_TIME = new Date("2035-01-02T03:00:00.000Z").getTime();
const captureHash = (text: string) => createHash("sha256").update(text).digest("hex");

function statAt(file: string, time = OLDER_STAT_TIME): void {
  fileProbe.statOverrides.set(file, { mtimeMs: time, ctimeMs: time });
}

function readsOf(file: string): number {
  return fileProbe.readPaths.filter((readPath) => readPath === file).length;
}

function resetFileProbe(): void {
  fileProbe.readPaths.length = 0;
  fileProbe.afterRead = null;
  fileProbe.statOverrides.clear();
}

function migrateSpecCache(db: Database.Database): void {
  migrate(db, [coreSchema, workflowSpecsSchema, workflowSpecsDiagnosticSchema]);
}

function makeLibraryApp(opts: {
  db: Database.Database;
  cache: WorkflowSpecCache;
  folder: string;
  root: string;
}): Hono {
  const builtinDir = join(opts.root, "builtins");
  fs.mkdirSync(builtinDir, { recursive: true });
  fs.writeFileSync(join(opts.root, "config.json"), JSON.stringify({ specs: { builtinsVisible: false } }));
  const lib = new SpecLibraryService({ roots: [], specReviewService: new SpecReviewService() });
  lib.scan();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("specLibraryService" as never, lib);
    c.set("specReviewService" as never, new SpecReviewService());
    c.set("activeLensStore" as never, new ActiveLensStore({ filePath: join(opts.root, "active-lens.json") }));
    c.set("rigRepo" as never, { db: opts.db });
    c.set("workflowBuiltinSpecsDir" as never, builtinDir);
    c.set("workflowSpecCache" as never, opts.cache);
    c.set("workflowsFolderDir" as never, opts.folder);
    c.set("settingsStore" as never, new SettingsStore(join(opts.root, "config.json")));
    await next();
  });
  app.route("/api/specs/library", specLibraryRoutes());
  return app;
}

describe("workflow spec persisted capture and Library reads", () => {
  let db: Database.Database;
  let root: string;
  let folder: string;

  beforeEach(() => {
    resetFileProbe();
    db = createDb();
    migrateSpecCache(db);
    root = fs.mkdtempSync(join(tmpdir(), "wf-capture-"));
    folder = join(root, "workflows");
    fs.mkdirSync(folder, { recursive: true });
  });

  afterEach(() => {
    if (db?.open) db.close();
    fs.rmSync(root, { recursive: true, force: true });
    resetFileProbe();
  });

  it("persists the capture timestamp for a successful read", () => {
    const file = join(folder, "capture.yaml");
    fs.writeFileSync(file, VALID_YAML("capture-time"));
    let bytesRead = false;
    const cache = new WorkflowSpecCache(db, () => new Date(bytesRead ? LATER_TIME : CAPTURE_TIME));
    fileProbe.afterRead = (readPath) => {
      if (readPath === file) bytesRead = true;
    };

    const row = cache.readThrough(file);
    const stored = db.prepare("SELECT cached_at FROM workflow_specs WHERE source_path = ?").get(file) as { cached_at: string };

    expect(row.cachedAt).toBe(CAPTURE_TIME.toISOString());
    expect(stored.cached_at).toBe(CAPTURE_TIME.toISOString());
  });

  it("finds a repair after a persisted diagnostic instead of skipping on its later handler timestamp", () => {
    const file = join(folder, "repair-after.yaml");
    fs.writeFileSync(file, BROKEN_YAML);
    statAt(file, CAPTURE_TIME.getTime());
    const cache = new WorkflowSpecCache(db, () => new Date(readsOf(file) === 0 ? CAPTURE_TIME : LATER_TIME));

    const failed = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    const diagnostic = db.prepare("SELECT source_hash, cached_at, status FROM workflow_specs WHERE source_path = ?").get(file) as {
      source_hash: string; cached_at: string; status: string;
    };
    expect(failed.errors).toBe(1);
    expect(diagnostic.source_hash).toBe(captureHash(BROKEN_YAML));

    fs.writeFileSync(file, VALID_YAML("repair-after"));
    const repaired = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });

    expect(repaired).toEqual({ scanned: 1, valid: 1, errors: 0, removed: 0, skipped: 0 });
    expect(db.prepare("SELECT status, name, error_message FROM workflow_specs WHERE source_path = ?").get(file))
      .toEqual({ status: "valid", name: "repair-after", error_message: null });
  });

  it("records failed bytes when the file is repaired after the read but before diagnostic handling", () => {
    const file = join(folder, "repair-race.yaml");
    fs.writeFileSync(file, BROKEN_YAML);
    statAt(file, CAPTURE_TIME.getTime());
    const cache = new WorkflowSpecCache(db, () => new Date(readsOf(file) === 0 ? CAPTURE_TIME : LATER_TIME));
    let repairedBetweenReadAndDiagnostic = false;
    fileProbe.afterRead = (readPath) => {
      if (readPath === file && !repairedBetweenReadAndDiagnostic) {
        repairedBetweenReadAndDiagnostic = true;
        fs.writeFileSync(file, VALID_YAML("repair-race"));
      }
    };

    const failed = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    const diagnostic = db.prepare("SELECT source_hash, cached_at FROM workflow_specs WHERE source_path = ?").get(file) as {
      source_hash: string; cached_at: string;
    };

    expect(failed.errors).toBe(1);
    expect(diagnostic.source_hash).toBe(captureHash(BROKEN_YAML));
    expect(diagnostic.cached_at).toBe(CAPTURE_TIME.toISOString());

    fileProbe.afterRead = null;
    const repaired = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });

    expect(repaired).toEqual({ scanned: 1, valid: 1, errors: 0, removed: 0, skipped: 0 });
  });

  it("keeps a warm aged Library list content-free", async () => {
    const file = join(folder, "warm.yaml");
    fs.writeFileSync(file, VALID_YAML("warm-list"));
    const cache = new WorkflowSpecCache(db, () => CAPTURE_TIME);
    cache.readThrough(file);
    statAt(file);
    const app = makeLibraryApp({ db, cache, folder, root });
    fileProbe.readPaths.length = 0;

    const response = await app.request("/api/specs/library?kind=workflow");
    const entries = await response.json() as Array<{ name: string; sourcePath: string }>;

    expect(response.status).toBe(200);
    expect(entries.some((entry) => entry.name === "warm-list" && entry.sourcePath === file)).toBe(true);
    expect(readsOf(file)).toBe(0);
  });

  it("keeps aged persisted entries content-free after reopening the database with a fresh cache", async () => {
    const dbFile = join(root, "workflow-specs.sqlite");
    db.close();
    db = createDb(dbFile);
    migrateSpecCache(db);
    const file = join(folder, "restart.yaml");
    fs.writeFileSync(file, VALID_YAML("restart-list"));
    const cache = new WorkflowSpecCache(db, () => CAPTURE_TIME);
    cache.readThrough(file);
    statAt(file);

    db.close();
    db = createDb(dbFile);
    const freshCache = new WorkflowSpecCache(db);
    expect(freshCache.getByNameVersion("restart-list", "1")?.cachedAt).toBe(CAPTURE_TIME.toISOString());
    const app = makeLibraryApp({ db, cache: freshCache, folder, root });
    fileProbe.readPaths.length = 0;

    const response = await app.request("/api/specs/library?kind=workflow");
    const entries = await response.json() as Array<{ name: string; sourcePath: string }>;

    expect(response.status).toBe(200);
    expect(entries.some((entry) => entry.name === "restart-list" && entry.sourcePath === file)).toBe(true);
    expect(readsOf(file)).toBe(0);
  });

  it("refreshes a touched unchanged user file once, then keeps warm and restarted Library lists content-free", async () => {
    const dbFile = join(root, "workflow-specs-touch.sqlite");
    db.close();
    db = createDb(dbFile);
    migrateSpecCache(db);
    const file = join(folder, "touched-unchanged.yaml");
    const contents = VALID_YAML("touched-unchanged");
    fs.writeFileSync(file, contents);
    let observedAt = CAPTURE_TIME;
    const cache = new WorkflowSpecCache(db, () => observedAt);
    cache.readThrough(file);

    // Keep the bytes unchanged while advancing both stat observations into the next second.
    statAt(file, TOUCHED_STAT_TIME);
    observedAt = P3_REFRESH_TIME;
    const app = makeLibraryApp({ db, cache, folder, root });
    fileProbe.readPaths.length = 0;

    const firstResponse = await app.request("/api/specs/library?kind=workflow");
    const firstEntries = await firstResponse.json() as Array<{ name: string; sourcePath: string; sourceType: string }>;
    const firstReads = readsOf(file);
    const firstRow = db.prepare("SELECT cached_at, source_hash, status FROM workflow_specs WHERE source_path = ?").get(file) as {
      cached_at: string; source_hash: string; status: string;
    };
    const readThroughCachedAt = cache.readThrough(file).cachedAt;

    fileProbe.readPaths.length = 0;
    const secondResponse = await app.request("/api/specs/library?kind=workflow");
    const secondEntries = await secondResponse.json() as Array<{ name: string; sourcePath: string; sourceType: string }>;
    const secondReads = readsOf(file);
    const secondCachedAt = (db.prepare("SELECT cached_at FROM workflow_specs WHERE source_path = ?").get(file) as { cached_at: string }).cached_at;

    db.close();
    db = createDb(dbFile);
    const freshCache = new WorkflowSpecCache(db);
    const restartedRow = db.prepare("SELECT cached_at, source_hash, status FROM workflow_specs WHERE source_path = ?").get(file) as {
      cached_at: string; source_hash: string; status: string;
    };
    const restartedApp = makeLibraryApp({ db, cache: freshCache, folder, root });
    fileProbe.readPaths.length = 0;
    const restartedResponse = await restartedApp.request("/api/specs/library?kind=workflow");
    const restartedEntries = await restartedResponse.json() as Array<{ name: string; sourcePath: string; sourceType: string }>;
    const restartedReads = readsOf(file);

    const hasUserEntry = (entries: Array<{ name: string; sourcePath: string; sourceType: string }>) =>
      entries.some((entry) => entry.name === "touched-unchanged" && entry.sourcePath === file && entry.sourceType === "user_file");
    expect(firstResponse.status).toBe(200);
    expect(hasUserEntry(firstEntries)).toBe(true);
    expect(secondResponse.status).toBe(200);
    expect(hasUserEntry(secondEntries)).toBe(true);
    expect(restartedResponse.status).toBe(200);
    expect(hasUserEntry(restartedEntries)).toBe(true);
    expect({
      firstReads,
      firstCachedAt: firstRow.cached_at,
      firstHash: firstRow.source_hash,
      firstStatus: firstRow.status,
      readThroughCachedAt,
      secondReads,
      secondCachedAt,
      restartedReads,
      restartedCachedAt: restartedRow.cached_at,
      restartedHash: restartedRow.source_hash,
      restartedStatus: restartedRow.status,
    }).toEqual({
      firstReads: 1,
      firstCachedAt: P3_REFRESH_TIME.toISOString(),
      firstHash: captureHash(contents),
      firstStatus: "valid",
      readThroughCachedAt: P3_REFRESH_TIME.toISOString(),
      secondReads: 0,
      secondCachedAt: P3_REFRESH_TIME.toISOString(),
      restartedReads: 0,
      restartedCachedAt: P3_REFRESH_TIME.toISOString(),
      restartedHash: captureHash(contents),
      restartedStatus: "valid",
    });
  });

  it("does not regress a newer SQLite-style cache timestamp when the injected clock moves backwards", () => {
    const file = join(folder, "backwards-clock.yaml");
    fs.writeFileSync(file, VALID_YAML("backwards-clock"));
    let observedAt = NEWER_VERIFIED_TIME;
    const cache = new WorkflowSpecCache(db, () => observedAt);
    cache.readThrough(file);
    db.prepare("UPDATE workflow_specs SET cached_at = ? WHERE source_path = ?").run(NEWER_SQLITE_TIMESTAMP, file);

    observedAt = BACKWARDS_TIME;
    const row = cache.readThrough(file);
    const stored = db.prepare("SELECT cached_at FROM workflow_specs WHERE source_path = ?").get(file) as { cached_at: string };

    expect(row.cachedAt).toBe(NEWER_SQLITE_TIMESTAMP);
    expect(stored.cached_at).toBe(NEWER_SQLITE_TIMESTAMP);
  });

  it.each([
    ["without reading an identical copy", false],
    ["after reading an identical copy", true],
  ] as const)("re-reads the owning file's edit %s", (_scenario, readIdenticalCopy) => {
    const file = join(folder, "owner.yaml");
    const duplicateDir = join(root, "other");
    fs.mkdirSync(duplicateDir);
    const duplicate = join(duplicateDir, "copy.yaml");
    const originalContents = VALID_YAML("duplicate-flow");
    const editedContents = originalContents.replace("objective: capture fixture", "objective: edited capture fixture");
    fs.writeFileSync(file, originalContents);
    fs.writeFileSync(duplicate, originalContents);
    let observedAt = CAPTURE_TIME;
    const cache = new WorkflowSpecCache(db, () => observedAt);
    cache.readThrough(file);

    // P's bytes really change after T0, but the stat fixture is deterministic and precedes T2.
    fileProbe.readPaths.length = 0;
    fs.writeFileSync(file, editedContents);
    statAt(file, TOUCHED_STAT_TIME);
    observedAt = P3_REFRESH_TIME;
    const copyRow = readIdenticalCopy ? cache.readThrough(duplicate) : null;
    const beforeScan = db.prepare("SELECT source_path, cached_at FROM workflow_specs WHERE name = ? AND version = '1'").get("duplicate-flow") as {
      source_path: string; cached_at: string;
    };
    const result = scanWorkflowSpecFolder({ db, cache, folder, builtinDir: null });
    const afterScan = db.prepare("SELECT source_path, source_hash, purpose, cached_at FROM workflow_specs WHERE name = ? AND version = '1'").get("duplicate-flow") as {
      source_path: string; source_hash: string; purpose: string; cached_at: string;
    };

    expect({
      copySourcePath: copyRow?.sourcePath ?? null,
      copyCachedAt: copyRow?.cachedAt ?? null,
      copyReads: readsOf(duplicate),
      ownerReads: readsOf(file),
      beforeScanSourcePath: beforeScan.source_path,
      beforeScanCachedAt: beforeScan.cached_at,
      result,
      afterScanSourcePath: afterScan.source_path,
      afterScanHash: afterScan.source_hash,
      afterScanPurpose: afterScan.purpose,
      afterScanCachedAt: afterScan.cached_at,
    }).toEqual({
      copySourcePath: readIdenticalCopy ? file : null,
      copyCachedAt: readIdenticalCopy ? CAPTURE_TIME.toISOString() : null,
      copyReads: readIdenticalCopy ? 1 : 0,
      ownerReads: 1,
      beforeScanSourcePath: file,
      beforeScanCachedAt: CAPTURE_TIME.toISOString(),
      result: { scanned: 1, valid: 1, errors: 0, removed: 0, skipped: 0 },
      afterScanSourcePath: file,
      afterScanHash: captureHash(editedContents),
      afterScanPurpose: "edited capture fixture",
      afterScanCachedAt: P3_REFRESH_TIME.toISOString(),
    });
  });
});
