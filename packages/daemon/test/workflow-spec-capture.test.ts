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
});
