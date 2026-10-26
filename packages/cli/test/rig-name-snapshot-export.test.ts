// `rig snapshot`, `rig snapshot list`, `rig export` and `rig restore --rig` take a rig name as well as an id,
// the way `rig down`, `rig grow` and `rig remove` already do. The daemon answers these routes by exact rig id,
// and lists [] for an id it has no snapshots for, so a name used to read as "No snapshots".
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { snapshotCommand } from "../src/commands/snapshot.js";
import { exportCommand, type ExportDeps } from "../src/commands/export.js";
import { restoreCommand } from "../src/commands/restore.js";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

const RIG_ID = "01M5F0YZQXETQ4YVH3MJVQPQXQ";
const REMOVED_RIG_ID = "01M5F0REMOVEDRIGIDXXXXXXXX";
const SNAPSHOTS: Record<string, unknown[]> = {
  [RIG_ID]: [{ id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-10-21 10:43:58" }],
  // Snapshots recorded under a rig that no longer exists still list by its id.
  [REMOVED_RIG_ID]: [{ id: "snap-old", kind: "auto-pre-down", status: "complete", createdAt: "2026-10-20 09:00:00" }],
};

function lifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "t.sqlite", startedAt: "2026-10-21T00:00:00Z" }) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

/** A daemon that resolves only exact rig ids, as the real routes do, with two rigs named "solo" and "twin". */
function fakeDaemon(rigs = [{ id: RIG_ID, name: "solo" }]) {
  const requests: string[] = [];
  const client = {
    get: vi.fn(async (path: string) => {
      requests.push(`GET ${path}`);
      if (path.startsWith("/api/rigs/summary")) return { status: 200, data: rigs.map((r) => ({ ...r, archivedAt: null })) };
      const m = /^\/api\/rigs\/([^/]+)\/snapshots$/.exec(path);
      if (m) return { status: 200, data: SNAPSHOTS[decodeURIComponent(m[1]!)] ?? [] };
      return { status: 404, data: { error: "not found" } };
    }),
    getText: vi.fn(async (path: string) => {
      requests.push(`GET ${path}`);
      return path === `/api/rigs/${RIG_ID}/spec` ? { status: 200, data: "name: solo\n" } : { status: 404, data: "not found" };
    }),
    post: vi.fn(async (path: string) => {
      requests.push(`POST ${path}`);
      if (path === `/api/rigs/${RIG_ID}/snapshots`) return { status: 201, data: { id: "snap-new" } };
      if (path === `/api/rigs/${RIG_ID}/restore/snap-1`) return { status: 200, data: { ok: true, rigResult: "fully_restored", nodes: [] } };
      return { status: 404, data: { error: "not found" } };
    }),
  };
  const deps: StatusDeps = { lifecycleDeps: lifecycleDeps(), clientFactory: () => client as unknown as DaemonClient };
  return { requests, deps };
}

async function run(command: Command, argv: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  process.exitCode = undefined;
  try {
    const program = new Command();
    program.exitOverride();
    program.addCommand(command);
    await program.parseAsync(["node", "rig", ...argv]);
    return { out: lines.join("\n"), exitCode: process.exitCode };
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
}

afterEach(() => { process.exitCode = undefined; });

describe("rig snapshot list", () => {
  it("lists a rig's snapshots by its name", async () => {
    const d = fakeDaemon();
    const { out, exitCode } = await run(snapshotCommand(d.deps), ["snapshot", "list", "solo"]);
    expect(d.requests).toContain(`GET /api/rigs/${RIG_ID}/snapshots`);
    expect(out).toContain("snap-1");
    expect(exitCode).toBeUndefined();
  });

  it("refuses a name or id that matches no rig instead of reporting no snapshots", async () => {
    const d = fakeDaemon();
    const { out, exitCode } = await run(snapshotCommand(d.deps), ["snapshot", "list", "no-such-rig"]);
    expect(out).toContain("Rig 'no-such-rig' not found");
    expect(out).not.toContain("No snapshots");
    expect(exitCode).toBe(1);
  });

  it("still lists snapshots kept under a removed rig's id, and still says a known rig has none", async () => {
    const removed = await run(snapshotCommand(fakeDaemon().deps), ["snapshot", "list", REMOVED_RIG_ID]);
    expect(removed.out).toContain("snap-old");
    expect(removed.exitCode).toBeUndefined();

    const empty = await run(snapshotCommand(fakeDaemon([{ id: "01EMPTYRIGIDXXXXXXXXXXXXXX", name: "empty" }]).deps), ["snapshot", "list", "empty"]);
    expect(empty.out).toBe("No snapshots");
    expect(empty.exitCode).toBeUndefined();
  });

  it("stops on a name two active rigs share, before listing", async () => {
    const d = fakeDaemon([{ id: RIG_ID, name: "twin" }, { id: "01M5F0OTHERRIGIDXXXXXXXXXX", name: "twin" }]);
    const { out, exitCode } = await run(snapshotCommand(d.deps), ["snapshot", "list", "twin"]);
    expect(out).toContain("'twin' matches 2 rigs");
    expect(d.requests.filter((r) => r.includes("/snapshots"))).toEqual([]);
    expect(exitCode).toBe(1);
  });
});

describe("rig snapshot, rig export and rig restore --rig", () => {
  it("snapshot creates under the named rig's id", async () => {
    const d = fakeDaemon();
    const { out } = await run(snapshotCommand(d.deps), ["snapshot", "solo"]);
    expect(d.requests).toContain(`POST /api/rigs/${RIG_ID}/snapshots`);
    expect(out).toContain("Snapshot created: snap-new");
    // The printed restore command names the rig by id, so it stays unambiguous if the name is reused.
    expect(out).toContain(`To restore: rig restore snap-new --rig ${RIG_ID}`);
  });

  it("export reads the named rig's spec", async () => {
    const d = fakeDaemon();
    const writeFile = vi.fn();
    const { out } = await run(exportCommand({ ...d.deps, writeFile } as ExportDeps), ["export", "solo", "-o", "out.yaml"]);
    expect(d.requests).toContain(`GET /api/rigs/${RIG_ID}/spec`);
    expect(writeFile).toHaveBeenCalledWith("out.yaml", "name: solo\n");
    expect(out).toContain("Exported to out.yaml");
  });

  it("restore posts to the named rig's id", async () => {
    const d = fakeDaemon();
    await run(restoreCommand(d.deps), ["restore", "snap-1", "--rig", "solo"]);
    expect(d.requests).toContain(`POST /api/rigs/${RIG_ID}/restore/snap-1`);
  });

  it("restore status --json reports a shared name as rig_ambiguous JSON, like rig grow and rig remove", async () => {
    const other = "01M5F0OTHERRIGIDXXXXXXXXXX";
    const d = fakeDaemon([{ id: RIG_ID, name: "twin" }, { id: other, name: "twin" }]);
    const { out, exitCode } = await run(restoreCommand(d.deps), ["restore", "status", "45", "--rig", "twin", "--json"]);
    expect(JSON.parse(out)).toMatchObject({ ok: false, code: "rig_ambiguous", candidates: [RIG_ID, other] });
    expect(d.requests.filter((r) => r.includes("/restore/"))).toEqual([]);
    expect(exitCode).toBe(1);

    const plain = await run(restoreCommand(fakeDaemon([{ id: RIG_ID, name: "twin" }, { id: other, name: "twin" }]).deps), ["restore", "status", "45", "--rig", "twin"]);
    expect(plain.out).toContain("'twin' matches 2 rigs");
    expect(plain.exitCode).toBe(1);
  });

  it("an id still goes to that id", async () => {
    const d = fakeDaemon();
    await run(snapshotCommand(d.deps), ["snapshot", RIG_ID]);
    expect(d.requests).toContain(`POST /api/rigs/${RIG_ID}/snapshots`);
  });
});
