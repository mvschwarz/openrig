// #2729 — `rig scope slice ls --with-queue` / `--derived <state>` show the queue-derived
// state the daemon reports in `GET /api/slices`, beside the authored status. The CLI does
// not recompute the state. It reads the daemon's one list and matches each slice by its
// physical path. A slice the daemon does not list, an older daemon without `derivedState`
// and a daemon that cannot answer are all `unknown`, never `idle` or `none`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { Hono } from "hono";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { SliceDetailProjector } from "../../daemon/src/domain/slices/slice-detail-projector.js";
import { SliceIndexer } from "../../daemon/src/domain/slices/slice-indexer.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
import { slicesRoutes } from "../../daemon/src/routes/slices.js";

type MockReply = { status: number; data: unknown } | Error;

const daemon = vi.hoisted(() => ({
  status: { state: "running", healthy: true, pid: 1234, port: 7433 } as Record<string, unknown>,
  respond: null as null | ((reqPath: string) => MockReply | Promise<MockReply>),
  gets: [] as string[],
  clientDefaultUrl: "http://localhost:7433",
  clientUrls: [] as string[],
  /** The instance-identity check: true only when the daemon is this home's own daemon. */
  local: true,
  identityChecks: 0,
}));

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => daemon.status),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

vi.mock("../src/client.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/client.js");
  return {
    ...actual,
    DaemonClient: class {
      constructor(baseUrl?: string) {
        daemon.clientUrls.push(baseUrl ?? daemon.clientDefaultUrl);
      }
      async isLocalInstance(): Promise<boolean> {
        daemon.identityChecks++;
        return daemon.local;
      }
      async get<T>(p: string): Promise<{ status: number; data: T }> {
        daemon.gets.push(p);
        const reply = await daemon.respond?.(p);
        if (reply instanceof Error) throw reply;
        return (reply ?? { status: 200, data: { slices: [] } }) as { status: number; data: T };
      }
    },
  };
});

const { scopeCommand } = await import("../src/commands/scope.js");

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rig-slice-ls-queue-"));
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

const SLICES = [
  { folder: "01-stuck", id: "OPR.1.1", status: "active" },
  { folder: "02-moving", id: "OPR.1.2", status: "active" },
  { folder: "03-closed", id: "OPR.1.3", status: "placeholder" },
  { folder: "04-unlisted", id: "OPR.1.4", status: "active" },
  { folder: "05-older-daemon", id: "OPR.1.5", status: "active" },
] as const;

function seedWorkspace(): { workRoot: string; missionsRoot: string; slicePath: (folder: string) => string } {
  const workRoot = mktemp();
  const missionsRoot = path.join(workRoot, "missions");
  writeFile(path.join(missionsRoot, "alpha", "README.md"), "---\nid: OPR.1\n---\n# alpha\n");
  for (const slice of SLICES) {
    writeFile(
      path.join(missionsRoot, "alpha", "slices", slice.folder, "README.md"),
      `---\nid: ${slice.id}\nstatus: ${slice.status}\n---\n# ${slice.folder}\n`,
    );
  }
  return { workRoot, missionsRoot, slicePath: (folder) => path.join(missionsRoot, "alpha", "slices", folder) };
}

async function run(args: string[], workRoot: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  let exitCode = 0;
  process.stdout.write = ((chunk: unknown) => { stdoutBuf.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderrBuf.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__EXIT__${exitCode}`);
  }) as typeof process.exit;
  const program = new Command();
  program.addCommand(scopeCommand());
  program.exitOverride();
  try {
    await program.parseAsync(["node", "rig", "scope", "--workspace", workRoot, ...args]);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (!msg.startsWith("__EXIT__")) stderrBuf.push(msg + "\n");
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
    process.exit = origExit;
  }
  return { exitCode, stdout: stdoutBuf.join(""), stderr: stderrBuf.join("") };
}

type Row = { name: string; status: string; derivedState?: string };

describe("rig scope slice ls queue-derived state (#2729)", () => {
  let ws: ReturnType<typeof seedWorkspace>;

  beforeEach(() => {
    ws = seedWorkspace();
    daemon.status = { state: "running", healthy: true, pid: 1234, port: 7433 };
    daemon.gets.length = 0;
    daemon.clientDefaultUrl = "http://localhost:7433";
    daemon.clientUrls.length = 0;
    daemon.local = true;
    daemon.identityChecks = 0;
    daemon.respond = () => ({
      status: 200,
      data: {
        slices: [
          { name: "01-stuck", slicePath: ws.slicePath("01-stuck"), derivedState: "blocked" },
          { name: "02-moving", slicePath: ws.slicePath("02-moving"), derivedState: "in-progress" },
          { name: "03-closed", slicePath: ws.slicePath("03-closed"), derivedState: "idle" },
          // 05-older-daemon is listed without derivedState, and 04-unlisted is not listed at all.
          { name: "05-older-daemon", slicePath: ws.slicePath("05-older-daemon") },
        ],
      },
    });
  });
  afterEach(() => { fs.rmSync(ws.workRoot, { recursive: true, force: true }); });

  /** A daemon list with a state on every slice, the clean case. */
  const fullList = () => ({
    status: 200,
    data: {
      slices: [
        { slicePath: ws.slicePath("01-stuck"), derivedState: "blocked" },
        { slicePath: ws.slicePath("02-moving"), derivedState: "in-progress" },
        { slicePath: ws.slicePath("03-closed"), derivedState: "idle" },
        { slicePath: ws.slicePath("04-unlisted"), derivedState: "pending" },
        { slicePath: ws.slicePath("05-older-daemon"), derivedState: "none" },
      ],
    },
  });

  const ls = async (...args: string[]) => {
    const result = await run(["slice", "ls", "--state", "all", "--json", ...args], ws.workRoot);
    return { result, parsed: result.stdout ? JSON.parse(result.stdout) as { ok: boolean; count: number; slices: Row[]; warnings?: string[] } : null };
  };
  const derivedByName = (rows: Row[]) => Object.fromEntries(rows.map((row) => [row.name, row.derivedState]));

  it("keeps the filesystem-only listing, with no daemon read and no derived field, when no queue flag is given", async () => {
    const { result, parsed } = await ls();
    expect(result.exitCode).toBe(0);
    expect(daemon.gets).toEqual([]);
    expect(parsed!.slices).toHaveLength(SLICES.length);
    for (const row of parsed!.slices) expect(row, row.name).not.toHaveProperty("derivedState");
  });

  it("adds the daemon's derived state beside the unchanged authored status and reads the list once", async () => {
    const { result, parsed } = await ls("--with-queue");
    expect(result.exitCode).toBe(0);
    expect(daemon.gets).toEqual(["/api/slices?filter=all"]);
    expect(derivedByName(parsed!.slices)).toEqual({
      "01-stuck": "blocked",
      "02-moving": "in-progress",
      "03-closed": "idle",
      "04-unlisted": "unknown",
      "05-older-daemon": "unknown",
    });
    expect(Object.fromEntries(parsed!.slices.map((row) => [row.name, row.status]))).toEqual({
      "01-stuck": "active", "02-moving": "active", "03-closed": "placeholder", "04-unlisted": "active", "05-older-daemon": "active",
    });
    expect(parsed!.warnings, "an absent state and an unlisted slice are each explained, not silent").toHaveLength(2);
    expect(parsed!.warnings![0]).toContain("reported no queue state for 1 of 5 slices");
    expect(parsed!.warnings![1]).toContain("1 of 5 slices are not in the daemon's list");
    expect(daemon.identityChecks, "one instance-identity check before the list is trusted").toBe(1);
  });

  it("keeps the selected HTTPS daemon URL after the status probe", async () => {
    daemon.clientDefaultUrl = "https://daemon.example.test:7443";
    const { result } = await ls("--with-queue");
    expect(result.exitCode).toBe(0);
    expect(daemon.clientUrls).toEqual(["https://daemon.example.test:7443"]);
    expect(daemon.gets).toEqual(["/api/slices?filter=all"]);
  });

  it("gives no warning when the daemon lists every slice with a state", async () => {
    daemon.respond = fullList;
    const { result, parsed } = await ls("--with-queue");
    expect(result.exitCode).toBe(0);
    expect(derivedByName(parsed!.slices)).toEqual({
      "01-stuck": "blocked", "02-moving": "in-progress", "03-closed": "idle", "04-unlisted": "pending", "05-older-daemon": "none",
    });
    expect(parsed!.warnings).toBeUndefined();
  });

  it("reports unknown, not another host's state, when the daemon is not this home's own daemon (same absolute paths)", async () => {
    // A daemon on another host can serve a workspace with the very same absolute paths.
    daemon.local = false;
    daemon.respond = fullList;
    const all = await ls("--with-queue");
    expect(all.result.exitCode).toBe(0);
    expect(Object.values(derivedByName(all.parsed!.slices))).toEqual(Array(SLICES.length).fill("unknown"));
    expect(all.parsed!.warnings).toHaveLength(1);
    expect(all.parsed!.warnings![0]).toContain("Could not confirm that the daemon is this home's own daemon");
    expect(daemon.gets, "the foreign slice list is never read").toEqual([]);
    for (const state of ["blocked", "idle", "none", "pending"]) {
      expect((await ls("--derived", state)).parsed!.slices, `--derived ${state} must not match another host's rows`).toEqual([]);
    }
    expect((await ls("--derived", "unknown")).parsed!.count).toBe(SLICES.length);
  });

  it.each([
    { label: "a null entry after a valid row", slices: () => [{ slicePath: ws.slicePath("01-stuck"), derivedState: "blocked" }, null], failure: "a slice entry is malformed" },
    { label: "an entry without a path", slices: () => [{ slicePath: ws.slicePath("01-stuck"), derivedState: "blocked" }, { derivedState: "idle" }], failure: "a slice entry is malformed" },
    { label: "a slice list that is not an array", slices: () => ({ unexpected: true }), failure: "not an array" },
  ])("discards the whole list for $label, so no partial state remains", async ({ slices, failure }) => {
    daemon.respond = () => ({ status: 200, data: { slices: slices() } });
    const { result, parsed } = await ls("--with-queue");
    expect(result.exitCode).toBe(0);
    expect(Object.values(derivedByName(parsed!.slices)), "the valid first row must not survive").toEqual(Array(SLICES.length).fill("unknown"));
    expect(parsed!.warnings).toHaveLength(1);
    expect(parsed!.warnings![0]).toContain(failure);
    expect(parsed!.warnings![0]).toContain("unknown for every slice");
  });

  it.each([
    { label: "a relative path", slicePath: () => path.join("alpha", "slices", "01-stuck") },
    { label: "a dot-relative path", slicePath: () => "./alpha/slices/01-stuck" },
    { label: "an empty path", slicePath: () => "" },
  ])("rejects the whole list for $label, never resolving it against the CLI's working directory", async ({ slicePath }) => {
    // The daemon and the CLI share this home but start in different directories. The daemon's relative path named a
    // slice under ITS directory. Resolved from the CLI's directory (the missions root here) it would name the local
    // 01-stuck, and that slice would wrongly show the other workspace's state.
    daemon.respond = () => ({ status: 200, data: { slices: [{ slicePath: slicePath(), derivedState: "blocked" }, ...fullList().data.slices.slice(1)] } });
    const previous = process.cwd();
    process.chdir(ws.missionsRoot);
    try {
      const all = await ls("--with-queue");
      expect(all.result.exitCode).toBe(0);
      expect(Object.values(derivedByName(all.parsed!.slices)), "no row of a rejected list may survive").toEqual(Array(SLICES.length).fill("unknown"));
      expect(all.parsed!.warnings).toHaveLength(1);
      expect(all.parsed!.warnings![0]).toContain("empty or non-absolute path");
      expect((await ls("--derived", "blocked")).parsed!.slices, "the local slice must not match by working directory").toEqual([]);
    } finally { process.chdir(previous); }
  });

  it.each([
    { label: "an explicit unknown from the daemon", derivedState: "unknown", warning: "could not read the queue counts for 1 of 5 slices" },
    { label: "a state this CLI does not know", derivedState: "paused", warning: "a queue state this CLI does not know for 1 of 5 slices" },
  ])("warns, and still shows unknown, for $label", async ({ derivedState, warning }) => {
    daemon.respond = () => ({ status: 200, data: { slices: [{ slicePath: ws.slicePath("01-stuck"), derivedState }, ...fullList().data.slices.slice(1)] } });
    const all = await ls("--with-queue");
    expect(derivedByName(all.parsed!.slices)["01-stuck"]).toBe("unknown");
    expect(all.parsed!.warnings).toHaveLength(1);
    expect(all.parsed!.warnings![0]).toContain(warning);
    // A filter that leaves the unread slice out is explained by the same warning, not silent.
    const blocked = await ls("--derived", "blocked");
    expect(blocked.parsed!.slices).toEqual([]);
    expect(blocked.parsed!.warnings).toHaveLength(1);
  });

  it("warns only about the slices of the listing it shows, not about another mission's slices", async () => {
    // A second mission whose slices the daemon cannot read must not put a warning on a clean listing of the first.
    writeFile(path.join(ws.missionsRoot, "beta", "README.md"), "---\nid: OPR.2\n---\n# beta\n");
    writeFile(path.join(ws.missionsRoot, "beta", "slices", "01-other", "README.md"), "---\nid: OPR.2.1\nstatus: active\n---\n# other\n");
    writeFile(path.join(ws.missionsRoot, "beta", "slices", "02-other", "README.md"), "---\nid: OPR.2.2\nstatus: active\n---\n# other\n");
    daemon.respond = () => ({ status: 200, data: { slices: [
      ...fullList().data.slices,
      { slicePath: path.join(ws.missionsRoot, "beta", "slices", "01-other"), derivedState: "unknown" },
      { slicePath: path.join(ws.missionsRoot, "beta", "slices", "02-other") },
    ] } });
    const alpha = await ls("--with-queue", "--mission", "alpha");
    expect(alpha.parsed!.count).toBe(SLICES.length);
    expect(alpha.parsed!.warnings, "alpha's slices all have a known state").toBeUndefined();
    const beta = await ls("--with-queue", "--mission", "beta");
    expect(beta.parsed!.warnings).toHaveLength(2);
    expect(beta.parsed!.warnings!.join(" ")).toContain("could not read the queue counts for 1 of 2 slices");
    expect(beta.parsed!.warnings!.join(" ")).toContain("reported no queue state for 1 of 2 slices");
    // A derived filter that hides the affected slices keeps their warning.
    const hidden = await ls("--derived", "blocked", "--mission", "beta");
    expect(hidden.parsed!.slices).toEqual([]);
    expect(hidden.parsed!.warnings).toHaveLength(2);
  });

  it("resolves slice paths only when queue state is asked for", async () => {
    const spy = vi.spyOn(fs.realpathSync, "native");
    const slicePathCalls = () => spy.mock.calls.filter(([p]) => typeof p === "string" && p.includes(`${path.sep}slices${path.sep}`));
    try {
      await ls();
      expect(slicePathCalls(), "the default listing must not resolve any slice path").toEqual([]);
      spy.mockClear();
      await ls("--with-queue");
      expect(slicePathCalls().length).toBeGreaterThanOrEqual(SLICES.length);
    } finally { spy.mockRestore(); }
  });

  it("shows unknown with a warning when a local slice path has no physical identity", async () => {
    const localPath = ws.slicePath("01-stuck");
    const daemonAlias = path.join(ws.workRoot, "daemon-alias");
    fs.symlinkSync(localPath, daemonAlias, "dir");
    daemon.respond = () => ({ status: 200, data: { slices: [{ slicePath: daemonAlias, derivedState: "pending" }] } });
    const originalRealpath = fs.realpathSync.native.bind(fs.realpathSync);
    const realpath = vi.spyOn(fs.realpathSync, "native").mockImplementation(((input: fs.PathLike) => {
      if (String(input) === localPath) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return originalRealpath(input);
    }) as typeof fs.realpathSync.native);
    try {
      const { parsed } = await ls("--with-queue");
      expect(derivedByName(parsed!.slices)["01-stuck"]).toBe("unknown");
      expect(parsed!.warnings?.join(" ")).toContain("Could not establish the physical identity of 1 of 5 slices");
      expect(realpath).toHaveBeenCalledWith(localPath);
    } finally { realpath.mockRestore(); }
  });

  it("skips an unresolvable daemon list entry so other slices keep their states and the missing slice stays unknown with its warning", async () => {
    const movedPath = path.join(ws.missionsRoot, "alpha", "slices", "04-moved");
    const otherMissionSameName = path.join(ws.missionsRoot, "beta", "slices", "04-unlisted");
    daemon.respond = () => ({
      status: 200,
      data: {
        slices: [
          { slicePath: ws.slicePath("01-stuck"), derivedState: "blocked" },
          { slicePath: ws.slicePath("02-moving"), derivedState: "in-progress" },
          { slicePath: ws.slicePath("03-closed"), derivedState: "idle" },
          { slicePath: movedPath, derivedState: "blocked" },
          { slicePath: otherMissionSameName, derivedState: "pending" },
          { slicePath: ws.slicePath("05-older-daemon"), derivedState: "none" },
        ],
      },
    });

    const all = await ls("--with-queue");
    expect(all.result.exitCode).toBe(0);
    expect.soft(derivedByName(all.parsed!.slices), "unaffected slices keep their states and the missing slice is not attributed from unresolvable entries").toEqual({
      "01-stuck": "blocked",
      "02-moving": "in-progress",
      "03-closed": "idle",
      "04-unlisted": "unknown",
      "05-older-daemon": "none",
    });
    expect.soft(all.parsed!.warnings).toHaveLength(1);
    expect.soft(all.parsed!.warnings?.[0]).toContain("1 of 5 slices are not in the daemon's list");

    const blocked = await ls("--derived", "blocked");
    expect(blocked.result.exitCode).toBe(0);
    expect.soft(blocked.parsed!.slices.map((row) => row.name)).toEqual(["01-stuck"]);
    expect.soft(blocked.parsed!.warnings).toHaveLength(1);
    expect.soft(blocked.parsed!.warnings?.[0]).toContain("1 of 5 slices are not in the daemon's list");

    const pending = await ls("--derived", "pending");
    expect(pending.result.exitCode).toBe(0);
    expect.soft(pending.parsed!.slices).toEqual([]);

    const unknownOnly = await ls("--derived", "unknown");
    expect(unknownOnly.result.exitCode).toBe(0);
    expect.soft(unknownOnly.parsed!.slices.map((row) => row.name)).toEqual(["04-unlisted"]);

    // Skipping an unresolvable entry must not weaken validation of later malformed entries.
    daemon.respond = () => ({
      status: 200,
      data: {
        slices: [
          { slicePath: movedPath, derivedState: "blocked" },
          { slicePath: ws.slicePath("01-stuck"), derivedState: "blocked" },
          null,
        ],
      },
    });
    const malformed = await ls("--with-queue");
    expect(malformed.result.exitCode).toBe(0);
    expect.soft(Object.values(derivedByName(malformed.parsed!.slices))).toEqual(Array(SLICES.length).fill("unknown"));
    expect.soft(malformed.parsed!.warnings).toHaveLength(1);
    expect.soft(malformed.parsed!.warnings?.[0]).toContain("a slice entry is malformed");
  });

  it("matches the daemon's slice by physical path when it reports the path through a symlink", async () => {
    const alias = path.join(ws.workRoot, "alias");
    fs.symlinkSync(ws.missionsRoot, alias);
    daemon.respond = () => ({
      status: 200,
      data: { slices: [{ slicePath: path.join(alias, "alpha", "slices", "01-stuck"), derivedState: "pending" }] },
    });
    const { parsed } = await ls("--with-queue");
    expect(derivedByName(parsed!.slices)["01-stuck"]).toBe("pending");
  });

  it("joins native realpaths end to end with GET /api/slices when a symlinked daemon root target contains ..", async () => {
    const root = fs.realpathSync.native(ws.workRoot);
    const alphaRoot = path.join(root, "alpha-proj");
    const betaRoot = path.join(root, "beta-proj");
    for (const [id, projRoot, missionId, sliceId] of [
      ["alpha", alphaRoot, "M.ALPHA", "OPR.ALPHA"],
      ["beta", betaRoot, "M.BETA", "OPR.BETA"],
    ] as const) {
      writeFile(path.join(projRoot, "README.md"), `---\nid: ${id}\n---\n# ${id}\n`);
      writeFile(path.join(projRoot, "project.yaml"), `id: ${id}\nmissions:\n  root: missions\n`);
      writeFile(path.join(projRoot, "missions", "shipping", "README.md"), `---\nid: ${missionId}\nstatus: active\n---\n# shipping\n`);
      writeFile(path.join(projRoot, "missions", "shipping", "slices", "01-release", "README.md"), `---\nid: ${sliceId}\nstatus: active\n---\n# release\n`);
    }
    fs.mkdirSync(path.join(alphaRoot, "sub"), { recursive: true });
    fs.symlinkSync(path.join(alphaRoot, "sub"), path.join(betaRoot, "link"), "dir");
    const currentAlias = path.join(root, "current");
    fs.symlinkSync(`${betaRoot}/link/../missions`, currentAlias, "dir");
    const catalogPath = path.join(root, "workspace.yaml");
    writeFile(catalogPath, JSON.stringify({ projects: [{ id: "alpha", root: "alpha-proj" }, { id: "beta", root: "beta-proj" }] }));
    const settingsPath = path.join(root, "settings.json");
    writeFile(settingsPath, JSON.stringify({ workspace: { root, catalogPath, slicesRoot: currentAlias } }));

    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const insert = db.prepare(
        `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body, tags)
         VALUES (?, '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z', 'writer@rig', 'worker@rig', ?, 'routine', 'work', ?)`,
      );
      insert.run("beta-blocked", "blocked", JSON.stringify(["project:beta", "mission:shipping", "slice:01-release"]));
      insert.run("alpha-pending", "pending", JSON.stringify(["project:alpha", "mission:M.ALPHA", "slice:01-release"]));

      const indexer = new SliceIndexer({ db, slicesRoot: currentAlias, dogfoodEvidenceRoot: null });
      const projector = new SliceDetailProjector({ db, indexer });
      const settings = new SettingsStore(settingsPath);
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("sliceIndexer" as never, indexer);
        c.set("sliceDetailProjector" as never, projector);
        c.set("settingsStore" as never, settings);
        await next();
      });
      app.route("/api/slices", slicesRoutes());
      daemon.respond = async (reqPath) => {
        const res = await app.request(reqPath);
        return { status: res.status, data: await res.json() };
      };

      const withQueue = await run(["slice", "ls", "--state", "all", "--with-queue", "--json"], alphaRoot);
      expect(withQueue.exitCode).toBe(0);
      const parsed = JSON.parse(withQueue.stdout) as { slices: Row[]; warnings?: string[] };
      expect.soft(derivedByName(parsed.slices), "Beta's blocked item must not attach to Alpha's slice").toEqual({ "01-release": "pending" });
      expect.soft(parsed.warnings).toBeUndefined();

      const blockedOnly = await run(["slice", "ls", "--derived", "blocked", "--json"], alphaRoot);
      expect(blockedOnly.exitCode).toBe(0);
      expect.soft((JSON.parse(blockedOnly.stdout) as { slices: Row[] }).slices.map((s) => s.name)).toEqual([]);

      const pendingOnly = await run(["slice", "ls", "--derived", "pending", "--json"], alphaRoot);
      expect(pendingOnly.exitCode).toBe(0);
      expect.soft((JSON.parse(pendingOnly.stdout) as { slices: Row[] }).slices.map((s) => s.name)).toEqual(["01-release"]);
    } finally {
      db.close();
    }
  });

  it("preserves an unrelated blocked slice across the real daemon listing cache when a folder moves in a README-only mission", async () => {
    const root = fs.realpathSync.native(ws.workRoot);
    const projRoot = path.join(root, "cache-proj");
    const missionsRoot = path.join(projRoot, "missions");
    const missionDir = path.join(missionsRoot, "alpha");
    writeFile(path.join(projRoot, "README.md"), "---\nid: cache-proj\n---\n# cache-proj\n");
    writeFile(path.join(projRoot, "project.yaml"), "id: cache-proj\nmissions:\n  root: missions\n");
    writeFile(path.join(missionDir, "README.md"), "---\nid: M.ALPHA\nstatus: active\n---\n# alpha\n");
    writeFile(path.join(missionDir, "slices", "01-stuck", "README.md"), "---\nid: OPR.1\nstatus: active\n---\n# stuck\n");
    writeFile(path.join(missionDir, "slices", "02-movable", "README.md"), "---\nid: OPR.2\nstatus: active\n---\n# movable\n");
    expect(fs.existsSync(path.join(missionDir, "mission.yaml"))).toBe(false);

    const catalogPath = path.join(root, "cache-workspace.yaml");
    writeFile(catalogPath, JSON.stringify({ projects: [{ id: "cache-proj", root: "cache-proj" }] }));
    const settingsPath = path.join(root, "cache-settings.json");
    writeFile(settingsPath, JSON.stringify({ workspace: { root, catalogPath, slicesRoot: missionsRoot } }));

    const db = createDb();
    try {
      migrate(db, ALL_MIGRATIONS);
      const insert = db.prepare(
        `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body, tags)
         VALUES (?, '2026-11-18T00:00:00.000Z', '2026-11-18T00:00:00.000Z', 'writer@rig', 'worker@rig', ?, 'routine', 'work', ?)`,
      );
      insert.run("alpha-stuck", "blocked", JSON.stringify(["project:cache-proj", "mission:alpha", "slice:01-stuck"]));
      insert.run("alpha-movable", "pending", JSON.stringify(["project:cache-proj", "mission:alpha", "slice:02-movable"]));

      const indexer = new SliceIndexer({ db, slicesRoot: missionsRoot, dogfoodEvidenceRoot: null });
      const projector = new SliceDetailProjector({ db, indexer });
      const settings = new SettingsStore(settingsPath);
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("sliceIndexer" as never, indexer);
        c.set("sliceDetailProjector" as never, projector);
        c.set("settingsStore" as never, settings);
        await next();
      });
      app.route("/api/slices", slicesRoutes());
      daemon.respond = async (reqPath) => {
        const res = await app.request(reqPath);
        return { status: res.status, data: await res.json() };
      };

      const primed = await run(["slice", "ls", "--state", "all", "--with-queue", "--json"], projRoot);
      expect(primed.exitCode).toBe(0);
      const primedParsed = JSON.parse(primed.stdout) as { slices: Row[]; warnings?: string[] };
      expect(derivedByName(primedParsed.slices)).toEqual({ "01-stuck": "blocked", "02-movable": "pending" });
      expect(primedParsed.warnings).toBeUndefined();

      fs.renameSync(path.join(missionDir, "slices", "02-movable"), path.join(missionDir, "slices", "02-moved"));

      const afterMove = await run(["slice", "ls", "--state", "all", "--with-queue", "--json"], projRoot);
      expect(afterMove.exitCode).toBe(0);
      const afterParsed = JSON.parse(afterMove.stdout) as { slices: Row[]; warnings?: string[] };
      expect(derivedByName(afterParsed.slices)).toEqual({ "01-stuck": "blocked", "02-moved": "unknown" });
      expect(afterParsed.warnings).toHaveLength(1);
      expect(afterParsed.warnings?.[0]).toContain("1 of 2 slices are not in the daemon's list");

      const blockedOnly = await run(["slice", "ls", "--derived", "blocked", "--json"], projRoot);
      expect(blockedOnly.exitCode).toBe(0);
      const blockedParsed = JSON.parse(blockedOnly.stdout) as { slices: Row[]; warnings?: string[] };
      expect(blockedParsed.slices.map((s) => s.name)).toEqual(["01-stuck"]);
      expect(blockedParsed.warnings).toHaveLength(1);
      expect(blockedParsed.warnings?.[0]).toContain("1 of 2 slices are not in the daemon's list");

      const unknownOnly = await run(["slice", "ls", "--derived", "unknown", "--json"], projRoot);
      expect(unknownOnly.exitCode).toBe(0);
      expect((JSON.parse(unknownOnly.stdout) as { slices: Row[] }).slices.map((s) => s.name)).toEqual(["02-moved"]);
      expect(daemon.gets.every((reqPath) => !reqPath.includes("refresh="))).toBe(true);
    } finally {
      db.close();
    }
  });

  it.each([
    { derived: "blocked", expected: ["01-stuck"] },
    { derived: "IDLE", expected: ["03-closed"] },
    { derived: "in-progress", expected: ["02-moving"] },
    { derived: "unknown", expected: ["04-unlisted", "05-older-daemon"] },
    { derived: "none", expected: [] as string[] },
  ])("--derived $derived keeps $expected and reads the daemon without --with-queue", async ({ derived, expected }) => {
    const { result, parsed } = await ls("--derived", derived);
    expect(result.exitCode).toBe(0);
    expect(parsed!.slices.map((row) => row.name).sort()).toEqual(expected);
    expect(parsed!.count).toBe(expected.length);
    expect(daemon.gets).toHaveLength(1);
  });

  it("--derived narrows the authored --state filter", async () => {
    const { parsed } = await ls("--derived", "unknown", "--state", "active");
    expect(parsed!.slices.map((row) => row.name).sort()).toEqual(["04-unlisted", "05-older-daemon"]);
  });

  it.each([
    { label: "the daemon is stopped", arrange: () => { daemon.status = { state: "stopped", healthy: false }; }, warning: "Daemon not running." },
    { label: "the daemon answers 500", arrange: () => { daemon.respond = () => ({ status: 500, data: { error: "boom" } }); }, warning: "answered 500" },
    { label: "the request throws", arrange: () => { daemon.respond = () => new Error("socket hang up"); }, warning: "socket hang up" },
  ])("reports unknown for every slice, with a warning, when $label", async ({ arrange, warning }) => {
    arrange();
    const all = await ls("--with-queue");
    expect(all.result.exitCode).toBe(0);
    expect(Object.values(derivedByName(all.parsed!.slices))).toEqual(Array(SLICES.length).fill("unknown"));
    expect(all.parsed!.warnings).toHaveLength(1);
    expect(all.parsed!.warnings![0]).toContain(warning);
    for (const state of ["idle", "none"]) {
      const filtered = await ls("--derived", state);
      expect(filtered.parsed!.slices, `--derived ${state} must not match unread counts`).toEqual([]);
    }
    expect((await ls("--derived", "unknown")).parsed!.count).toBe(SLICES.length);
  });

  it("prints the derived state as a column and the warning on stderr in text mode", async () => {
    daemon.respond = fullList;
    const ok = await run(["slice", "ls", "--state", "all", "--with-queue"], ws.workRoot);
    expect(ok.exitCode).toBe(0);
    const line = ok.stdout.split("\n").find((l) => l.startsWith("alpha/01-stuck"))!;
    expect(line.trim().split(/\s{2,}/)).toEqual(["alpha/01-stuck", "OPR.1.1", "active", "blocked"]);
    expect(ok.stderr).toBe("");

    daemon.status = { state: "stopped", healthy: false };
    const down = await run(["slice", "ls", "--state", "all", "--with-queue"], ws.workRoot);
    expect(down.stderr).toContain("Warning: Daemon not running. Queue state is unknown for every slice.");
    expect(down.stdout.split("\n").find((l) => l.startsWith("alpha/01-stuck"))!.trim().split(/\s{2,}/).at(-1)).toBe("unknown");
  });

  it("refuses an unknown --derived value before reading anything", async () => {
    const result = await run(["slice", "ls", "--derived", "open", "--json"], ws.workRoot);
    expect(result.exitCode).toBe(1);
    const error = JSON.parse(result.stdout).error as { fact: string; consequence: string; action: string };
    expect(error.fact).toBe('Unknown --derived value "open".');
    expect(error.consequence).toBe("Command did not run.");
    expect(error.action).toBe("Pick one of: blocked, in-progress, pending, idle, none, unknown.");
    expect(daemon.gets).toEqual([]);
  });

  it("help says idle means matched items with none open, not that nobody is working on it", () => {
    const slice = scopeCommand().commands.find((c) => c.name() === "slice")!;
    const help = slice.commands.find((c) => c.name() === "ls")!.helpInformation().replace(/\s+/g, " ");
    expect(help).toContain("idle (matched items, none open; not \"nobody is working on it\")");
    expect(help).toContain("none (no matched items)");
    expect(help).toContain("unknown (counts could not be read)");
    expect(help).toContain("--derived <state>");
  });
});
