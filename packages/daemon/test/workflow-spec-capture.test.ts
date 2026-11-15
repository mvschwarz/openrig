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
const SAME_TICK_YAML = (version: "1" | "2", revision: "one" | "two") => `workflow:
  id: same-tick-flow
  version: '${version}'
  objective: Objective ${revision}
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
      objective: Step ${revision}.
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

  it.each([
    ["immediately", 0],
    ["at the first lookup five seconds later", 5_000],
  ] as const)("reviews the current Library source after a same-tick rewrite %s", async (_timing, delayMs) => {
    const file = join(folder, "same-tick.yaml");
    const versionOne = SAME_TICK_YAML("1", "one");
    const versionTwo = SAME_TICK_YAML("2", "two");
    expect(Buffer.byteLength(versionOne, "utf8")).toBe(Buffer.byteLength(versionTwo, "utf8"));

    fs.writeFileSync(file, versionOne);
    statAt(file, CAPTURE_TIME.getTime());
    const initialStat = { ...fileProbe.statOverrides.get(file)! };
    expect(initialStat).toEqual({ mtimeMs: CAPTURE_TIME.getTime(), ctimeMs: CAPTURE_TIME.getTime() });
    let observedAt = CAPTURE_TIME.getTime();
    const cache = new WorkflowSpecCache(db, () => new Date(observedAt));
    const app = makeLibraryApp({ db, cache, folder, root });

    const initialListResponse = await app.request("/api/specs/library?kind=workflow");
    const initialEntries = await initialListResponse.json() as Array<{
      id: string; name: string; version: string; sourcePath: string; sourceType: string;
    }>;
    const initialEntry = initialEntries.find((entry) => entry.sourcePath === file
      && entry.sourceType === "user_file"
      && entry.name === "same-tick-flow"
      && entry.version === "1");
    expect(initialListResponse.status).toBe(200);
    expect(initialEntry).toMatchObject({
      id: "workflow:same-tick-flow:1",
      name: "same-tick-flow",
      version: "1",
      sourcePath: file,
      sourceType: "user_file",
    });
    expect(initialEntry).toBeDefined();

    const initialRow = db.prepare("SELECT cached_at, source_hash, status FROM workflow_specs WHERE source_path = ? AND name = ? AND version = '1'")
      .get(file, "same-tick-flow") as { cached_at: string; source_hash: string; status: string };
    expect(initialRow).toEqual({ cached_at: CAPTURE_TIME.toISOString(), source_hash: captureHash(versionOne), status: "valid" });

    const beforeUnchangedReviewReads = readsOf(file);
    const initialReviewResponse = await app.request(`/api/specs/library/${encodeURIComponent(initialEntry!.id)}/review`);
    const initialReview = await initialReviewResponse.json() as {
      version: string; sourcePath: string; purpose: string; steps: Array<{ objective: string }>;
    };
    expect(initialReviewResponse.status).toBe(200);
    expect(initialReview).toMatchObject({
      version: "1",
      sourcePath: file,
      purpose: "Objective one",
      steps: [expect.objectContaining({ objective: "Step one." })],
    });
    expect(readsOf(file)).toBeGreaterThan(beforeUnchangedReviewReads);
    const unchangedRow = db.prepare("SELECT cached_at, source_hash FROM workflow_specs WHERE source_path = ? AND name = ? AND version = '1'")
      .get(file, "same-tick-flow") as { cached_at: string; source_hash: string };
    expect(unchangedRow).toEqual({ cached_at: CAPTURE_TIME.toISOString(), source_hash: captureHash(versionOne) });

    const readsBeforeRewrite = readsOf(file);
    fs.writeFileSync(file, versionTwo);
    statAt(file, CAPTURE_TIME.getTime());
    expect(fileProbe.statOverrides.get(file)).toEqual(initialStat);
    observedAt = CAPTURE_TIME.getTime() + delayMs;
    const expectedLookupAt = new Date(observedAt);

    // This ordinary Library list is the first request after the rewrite, including in the T+5s case.
    const currentListResponse = await app.request("/api/specs/library?kind=workflow");
    const currentEntries = await currentListResponse.json() as Array<{
      id: string; name: string; version: string; sourcePath: string; sourceType: string;
    }>;
    const currentEntry = currentEntries.find((entry) => entry.sourcePath === file
      && entry.sourceType === "user_file"
      && entry.name === "same-tick-flow"
      && entry.version === "2");
    expect(currentListResponse.status).toBe(200);
    expect(currentEntry).toMatchObject({
      id: "workflow:same-tick-flow:2",
      name: "same-tick-flow",
      version: "2",
      sourcePath: file,
      sourceType: "user_file",
    });
    expect(currentEntry).toBeDefined();
    expect(readsOf(file)).toBeGreaterThan(readsBeforeRewrite);
    expect(fileProbe.statOverrides.get(file)).toEqual(initialStat);

    const currentRow = db.prepare("SELECT cached_at, source_hash, status FROM workflow_specs WHERE source_path = ? AND name = ? AND version = '2'")
      .get(file, "same-tick-flow") as { cached_at: string; source_hash: string; status: string };
    expect(currentRow).toEqual({ cached_at: expectedLookupAt.toISOString(), source_hash: captureHash(versionTwo), status: "valid" });

    const currentReviewResponse = await app.request(`/api/specs/library/${encodeURIComponent(currentEntry!.id)}/review`);
    const currentReview = await currentReviewResponse.json() as {
      version: string; sourcePath: string; purpose: string; steps: Array<{ objective: string }>;
    };
    expect(currentReviewResponse.status).toBe(200);
    expect(currentReview).toMatchObject({
      version: "2",
      sourcePath: file,
      purpose: "Objective two",
      steps: [expect.objectContaining({ objective: "Step two." })],
    });
    expect(fileProbe.statOverrides.get(file)).toEqual(initialStat);

    const historyResponse = await app.request(`/api/specs/library/${encodeURIComponent("workflow:same-tick-flow:1")}/review`);
    const historicalReview = await historyResponse.json() as {
      version: string; sourcePath: string; purpose: string; steps: Array<{ objective: string }>;
    };
    expect(historyResponse.status).toBe(200);
    expect(historicalReview).toMatchObject({
      version: "1",
      sourcePath: file,
      purpose: "Objective one",
      steps: [expect.objectContaining({ objective: "Step one." })],
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

  it("lists an identical built-in alias with two user reads while keeping edited user source links", async () => {
    const builtin = join(root, "builtins", "same.yaml");
    const user = join(folder, "same.yaml");
    const identicalYaml = VALID_YAML("same");
    const expectedSourceId = `workflow-source:${captureHash(user)}`;
    let observedAt = CAPTURE_TIME;
    const cache = new WorkflowSpecCache(db, () => observedAt);
    const app = makeLibraryApp({ db, cache, folder, root });

    fs.writeFileSync(builtin, identicalYaml);
    cache.readThrough(builtin);
    fs.writeFileSync(user, identicalYaml);
    statAt(builtin);
    statAt(user);

    const readThroughSpy = vi.spyOn(cache, "readThrough");
    fileProbe.readPaths.length = 0;

    const firstList = await app.request("/api/specs/library?kind=workflow");
    const firstEntries = await firstList.json() as Array<{
      id: string; kind: string; name: string; version: string; sourcePath: string; sourceType: string; isBuiltIn: boolean;
    }>;
    const firstPassCounts = {
      status: firstList.status,
      userReads: readsOf(user),
      builtinReads: readsOf(builtin),
      readThroughPaths: readThroughSpy.mock.calls.map(([specPath]) => specPath),
    };

    fileProbe.readPaths.length = 0;
    readThroughSpy.mockClear();
    const secondList = await app.request("/api/specs/library?kind=workflow");
    const secondPassCounts = {
      status: secondList.status,
      userReads: readsOf(user),
      builtinReads: readsOf(builtin),
      readThroughPaths: readThroughSpy.mock.calls.map(([specPath]) => specPath),
    };

    expect(firstPassCounts).toEqual({
      status: 200,
      userReads: 2,
      builtinReads: 1,
      readThroughPaths: [user],
    });
    expect(secondPassCounts).toEqual({
      status: 200,
      userReads: 2,
      builtinReads: 1,
      readThroughPaths: [user],
    });
    expect(firstEntries).toEqual([
      expect.objectContaining({
        id: expectedSourceId,
        kind: "workflow",
        name: "same",
        version: "1",
        sourcePath: user,
        sourceType: "user_file",
        isBuiltIn: false,
      }),
    ]);
    expect(db.prepare("SELECT source_path, source_hash, cached_at FROM workflow_specs WHERE name = 'same' AND version = '1'").get())
      .toEqual({
        source_path: builtin,
        source_hash: captureHash(identicalYaml),
        cached_at: CAPTURE_TIME.toISOString(),
      });

    const withBuiltins = await (await app.request("/api/specs/library?kind=workflow&include_builtins=true")).json() as Array<{
      id: string; sourcePath: string; sourceType: string; isBuiltIn: boolean;
    }>;
    expect(withBuiltins.map(({ id, sourcePath, sourceType, isBuiltIn }) => ({ id, sourcePath, sourceType, isBuiltIn }))).toEqual([
      { id: "workflow:same:1", sourcePath: builtin, sourceType: "builtin", isBuiltIn: true },
      { id: expectedSourceId, sourcePath: user, sourceType: "user_file", isBuiltIn: false },
    ]);

    const aliasReview = await app.request(`/api/specs/library/${encodeURIComponent(expectedSourceId)}/review`);
    expect(aliasReview.status).toBe(200);
    expect(await aliasReview.json()).toMatchObject({
      name: "same",
      version: "1",
      sourcePath: user,
      isBuiltIn: false,
      libraryEntryId: expectedSourceId,
      purpose: "capture fixture",
    });

    // Deleting the identical user copy removes the synthetic alias entry without removing the canonical built-in row.
    fs.rmSync(user);
    fileProbe.statOverrides.delete(user);
    const syncAfterDelete = await app.request("/api/specs/library/sync", { method: "POST" });
    expect(syncAfterDelete.status).toBe(200);
    expect(await syncAfterDelete.json()).toEqual([]);
    expect(await (await app.request("/api/specs/library?kind=workflow")).json()).toEqual([]);
    expect((await app.request(`/api/specs/library/${encodeURIComponent(expectedSourceId)}/review`)).status).toBe(404);
    expect(db.prepare("SELECT source_path, cached_at FROM workflow_specs WHERE name = 'same' AND version = '1'").get())
      .toEqual({ source_path: builtin, cached_at: CAPTURE_TIME.toISOString() });

    // Control: an ordinary edited user copy owns the cache row and still receives its source-specific review link.
    const editedYaml = identicalYaml.replace("objective: capture fixture", "objective: edited capture fixture");
    fs.writeFileSync(user, editedYaml);
    statAt(user, TOUCHED_STAT_TIME);
    observedAt = P3_REFRESH_TIME;

    const editedList = await app.request("/api/specs/library?kind=workflow");
    const editedEntries = await editedList.json() as Array<{
      id: string; sourcePath: string; sourceType: string; isBuiltIn: boolean;
    }>;
    expect(editedList.status).toBe(200);
    expect(editedEntries.map(({ id, sourcePath, sourceType, isBuiltIn }) => ({ id, sourcePath, sourceType, isBuiltIn }))).toEqual([
      { id: "workflow:same:1", sourcePath: user, sourceType: "user_file", isBuiltIn: false },
    ]);
    expect(db.prepare("SELECT source_path, source_hash, cached_at FROM workflow_specs WHERE name = 'same' AND version = '1'").get())
      .toEqual({
        source_path: user,
        source_hash: captureHash(editedYaml),
        cached_at: P3_REFRESH_TIME.toISOString(),
      });

    statAt(user);
    fileProbe.readPaths.length = 0;
    const warmEditedList = await app.request("/api/specs/library?kind=workflow");
    expect(warmEditedList.status).toBe(200);
    expect(readsOf(user)).toBe(0);

    fileProbe.readPaths.length = 0;
    const editedSourceReview = await app.request(`/api/specs/library/${encodeURIComponent(expectedSourceId)}/review`);
    expect(editedSourceReview.status).toBe(200);
    expect(await editedSourceReview.json()).toMatchObject({
      name: "same",
      version: "1",
      sourcePath: user,
      isBuiltIn: false,
      libraryEntryId: expectedSourceId,
      purpose: "edited capture fixture",
    });
    // SpecLibraryService.get reads the workflow YAML once on /:id/review; refreshWorkflowEntries itself adds 0 reads.
    expect(readsOf(user)).toBe(1);

    // Exclude ordinary user-file fallback verification from the synthetic-entry skip: when the scanner skips without
    // pre-populating verifiedSourceHashes (e.g. a newer #503 diagnostic row shares the path), the route still reads
    // the ordinary user file once to verify its cached bytes (plus one SpecLibraryService.get read on 200 review)
    // and rejects changed disk bytes before SpecLibraryService.get runs.
    const fallbackSpec = join(folder, "fallback.yaml");
    const fallbackSourceId = `workflow-source:${captureHash(fallbackSpec)}`;
    const fallbackYaml = VALID_YAML("fallback-flow");
    observedAt = CAPTURE_TIME;
    fs.writeFileSync(fallbackSpec, fallbackYaml);
    cache.readThrough(fallbackSpec);
    cache.writeDiagnostic({
      sourcePath: fallbackSpec,
      sourceHash: captureHash(BROKEN_YAML),
      errorMessage: "diagnostic alongside cached v1",
      cachedAt: P3_REFRESH_TIME.toISOString(),
    });
    statAt(fallbackSpec);
    fileProbe.readPaths.length = 0;

    const fallbackReview = await app.request(`/api/specs/library/${encodeURIComponent(fallbackSourceId)}/review`);
    expect(fallbackReview.status).toBe(200);
    expect(await fallbackReview.json()).toMatchObject({
      name: "fallback-flow",
      version: "1",
      sourcePath: fallbackSpec,
      isBuiltIn: false,
      libraryEntryId: fallbackSourceId,
    });
    expect(readsOf(fallbackSpec)).toBe(2);

    fs.writeFileSync(fallbackSpec, BROKEN_YAML);
    fileProbe.readPaths.length = 0;
    expect((await app.request(`/api/specs/library/${encodeURIComponent(fallbackSourceId)}/review`)).status).toBe(404);
    expect(readsOf(fallbackSpec)).toBe(1);
  });
});
