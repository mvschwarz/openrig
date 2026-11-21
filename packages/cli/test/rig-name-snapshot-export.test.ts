// `rig snapshot`, `rig snapshot list`, `rig export` and `rig restore --rig` take a rig name as well as an id,
// the way `rig down`, `rig grow` and `rig remove` already do. The daemon answers these routes by exact rig id,
// and lists [] for an id it has no snapshots for, so a name used to read as "No snapshots".
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { snapshotCommand } from "../src/commands/snapshot.js";
import { exportCommand, type ExportDeps } from "../src/commands/export.js";
import { restoreCommand } from "../src/commands/restore.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
import { psCommand } from "../src/commands/ps.js";

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
function fakeDaemon(rigs: Array<{ id: string; name: string; archivedAt?: string | null }> = [{ id: RIG_ID, name: "solo" }]) {
  const requests: string[] = [];
  const client = {
    get: vi.fn(async (path: string) => {
      requests.push(`GET ${path}`);
      if (path.startsWith("/api/rigs/summary")) return { status: 200, data: rigs.map((r) => ({ archivedAt: null, ...r })) };
      const m = /^\/api\/rigs\/([^/]+)\/snapshots$/.exec(path);
      if (m) return { status: 200, data: SNAPSHOTS[decodeURIComponent(m[1]!)] ?? [] };
      const snapshot = /^\/api\/rigs\/([^/]+)\/snapshots\/([^/]+)$/.exec(path);
      if (snapshot && snapshot[1] === RIG_ID && snapshot[2] === "snap-1") {
        return { status: 200, data: { id: "snap-1", rigId: RIG_ID } };
      }
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

  it("lists snapshots across identities when two rigs share a name", async () => {
    const d = fakeDaemon([{ id: RIG_ID, name: "twin" }, { id: "01M5F0OTHERRIGIDXXXXXXXXXX", name: "twin" }]);
    const { out, exitCode } = await run(snapshotCommand(d.deps), ["snapshot", "list", "twin"]);
    expect(out).toContain("snap-1");
    expect(d.requests).toContain(`GET /api/rigs/${RIG_ID}/snapshots`);
    expect(d.requests).toContain("GET /api/rigs/01M5F0OTHERRIGIDXXXXXXXXXX/snapshots");
    expect(exitCode).toBeUndefined();
  });

  it("lists archived and current identities newest-first, including auto-pre-down", async () => {
    const d = fakeDaemon([
      { id: REMOVED_RIG_ID, name: "solo", archivedAt: "2026-10-21 00:00:00" },
      { id: RIG_ID, name: "solo" },
    ]);
    const { out, exitCode } = await run(snapshotCommand(d.deps), ["snapshot", "list", "solo"]);
    expect(out).toContain("auto-pre-down");
    expect(out.indexOf("snap-1")).toBeLessThan(out.indexOf("snap-old"));
    expect(exitCode).toBeUndefined();
  });

  it("keeps an exact id scoped to that identity even when another rig uses it as a name", async () => {
    const d = fakeDaemon([{ id: RIG_ID, name: "solo" }, { id: REMOVED_RIG_ID, name: RIG_ID }]);
    const { out } = await run(snapshotCommand(d.deps), ["snapshot", "list", RIG_ID]);
    expect(out).toContain("snap-1");
    expect(out).not.toContain("snap-old");
  });

  it.each(["success-first", "error-first", "thrown"])("keeps usable history and marks %s reads incomplete", async (order) => {
    const rigs = [{ id: RIG_ID, name: "solo" }, { id: REMOVED_RIG_ID, name: "solo" }];
    const d = fakeDaemon(order === "success-first" ? rigs : rigs.reverse());
    const get = vi.mocked(d.deps.clientFactory("").get).getMockImplementation();
    if (!get) throw new Error("Missing fixture GET implementation");
    vi.spyOn(d.deps.clientFactory(""), "get").mockImplementation(async (url) => {
      if (url === `/api/rigs/${REMOVED_RIG_ID}/snapshots`) {
        if (order === "thrown") throw new Error("socket hang up");
        return { status: 503, data: { error: "unavailable" } };
      }
      return get(url);
    });
    const { out, exitCode } = await run(snapshotCommand(d.deps), ["snapshot", "list", "solo"]);
    expect(out).toContain(REMOVED_RIG_ID);
    expect(out).toContain(order === "thrown" ? "socket hang up" : "unavailable");
    expect(out).toContain("INCOMPLETE");
    expect(out).toContain("snap-1");
    expect(out).not.toContain("No snapshots");
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

  it("#3253: an export leaving out a seat's unreadable process_limits writes the file and prints the not-carried line", async () => {
    const d = fakeDaemon();
    const yaml = "# Not carried: dev.impl's process_limits, because the saved value can't be read; it stays stored as it is.\nname: solo\n";
    const client = d.deps.clientFactory("") as unknown as { getText: ReturnType<typeof vi.fn> };
    client.getText.mockResolvedValueOnce({ status: 200, data: yaml });
    const writeFile = vi.fn();
    const { out, exitCode } = await run(exportCommand({ ...d.deps, writeFile } as ExportDeps), ["export", "solo", "-o", "out.yaml"]);
    expect(writeFile).toHaveBeenCalledWith("out.yaml", yaml);
    expect(out).toContain("Exported to out.yaml");
    expect(out).toContain("Not carried: dev.impl's process_limits, because the saved value can't be read; it stays stored as it is.");
    expect(exitCode).toBeUndefined();
  });

  it("#3253: a refused export prints the daemon's error, not its raw JSON, and writes nothing", async () => {
    const d = fakeDaemon();
    const error = "Cannot export seat 'dev.impl': Seat n1 process_limits: stored value is not valid JSON. Fix it by re-applying the spec " +
      "with process_limits: { tasks_max: <N> }, or clear it with process_limits: {}; then export again.";
    const client = d.deps.clientFactory("") as unknown as { getText: ReturnType<typeof vi.fn> };
    client.getText.mockResolvedValueOnce({ status: 409, data: JSON.stringify({ error, code: "export_refused" }) });
    const writeFile = vi.fn();
    const { out, exitCode } = await run(exportCommand({ ...d.deps, writeFile } as ExportDeps), ["export", "solo", "-o", "out.yaml"]);
    expect(out).toContain(`Export failed: ${error}`);
    expect(out).not.toContain("export_refused");
    expect(exitCode).toBe(1);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("restore posts to the named rig's id", async () => {
    const d = fakeDaemon();
    await run(restoreCommand(d.deps), ["restore", "snap-1", "--rig", "solo"]);
    expect(d.requests).toContain(`POST /api/rigs/${RIG_ID}/restore/snap-1`);
  });

  it("restores the snapshot's archived identity instead of the current same-name rig", async () => {
    const d = fakeDaemon([
      { id: REMOVED_RIG_ID, name: "solo" },
      { id: RIG_ID, name: "solo", archivedAt: "2026-10-21 00:00:00" },
    ]);
    const { out, exitCode } = await run(restoreCommand(d.deps), ["restore", "snap-1", "--rig", "solo"]);
    expect(d.requests).toContain(`POST /api/rigs/${RIG_ID}/restore/snap-1`);
    expect(d.requests).not.toContain(`POST /api/rigs/${REMOVED_RIG_ID}/restore/snap-1`);
    expect(out).toContain("Restore complete");
    expect(exitCode).toBeUndefined();
  });

  it("does not restore another identity when the snapshot is absent", async () => {
    const d = fakeDaemon([{ id: RIG_ID, name: "solo" }, { id: REMOVED_RIG_ID, name: "solo" }]);
    const { out, exitCode } = await run(restoreCommand(d.deps), ["restore", "missing", "--rig", "solo"]);
    expect(out).toContain('Snapshot "missing" or rig "solo" not found');
    expect(d.requests.filter((request) => request.startsWith("POST"))).toEqual([]);
    expect(exitCode).toBe(1);
  });

  it.each(["owner", "absent", "thrown-owner", "thrown-absent"])("continues owner search after a failed candidate: %s", async (outcome) => {
    const d = fakeDaemon([{ id: REMOVED_RIG_ID, name: "solo" }, { id: RIG_ID, name: "solo" }]);
    const get = vi.mocked(d.deps.clientFactory("").get).getMockImplementation();
    if (!get) throw new Error("Missing fixture GET implementation");
    vi.spyOn(d.deps.clientFactory(""), "get").mockImplementation(async (url) => {
      if (url.startsWith(`/api/rigs/${REMOVED_RIG_ID}/snapshots/`)) {
        if (outcome.startsWith("thrown")) throw new Error("socket hang up");
        return { status: 503, data: { error: "unavailable" } };
      }
      return get(url);
    });
    const owns = outcome.endsWith("owner");
    const { out, exitCode } = await run(restoreCommand(d.deps), ["restore", owns ? "snap-1" : "missing", "--rig", "solo"]);
    expect(out).toContain(REMOVED_RIG_ID);
    expect(out).toContain(outcome.startsWith("thrown") ? "socket hang up" : "HTTP 503");
    expect(d.requests.filter((request) => request.startsWith("POST"))).toEqual(owns ? [`POST /api/rigs/${RIG_ID}/restore/snap-1`] : []);
    if (owns) {
      expect(out).toContain(`Selected rig identity: ${RIG_ID}`);
      expect(exitCode).toBeUndefined();
    } else {
      expect(out).toMatch(/resolution is incomplete/i);
      expect(out).toContain("no restore was submitted");
      expect(out).not.toContain("not found");
      expect(exitCode).toBe(1);
    }
  });

  it.each(["rig_not_stopped", "restore_in_progress"])("gives selected-identity advice for %s", async (code) => {
    const d = fakeDaemon([{ id: REMOVED_RIG_ID, name: "solo" }, { id: RIG_ID, name: "solo", archivedAt: "2026-10-21" }]);
    const post = vi.spyOn(d.deps.clientFactory(""), "post").mockResolvedValue({ status: 409, data: { code, error: "conflict" } });
    const { out } = await run(restoreCommand(d.deps), ["restore", "snap-1", "--rig", "solo"]);
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[0]).toBe(`/api/rigs/${RIG_ID}/restore/snap-1`);
    expect(out).toContain(`Selected rig identity: ${RIG_ID}`);
    if (code === "rig_not_stopped") expect(out).toContain(`rig down ${RIG_ID}`);
    else {
      expect(out).toContain("existing restore attempt is already running");
      // `ps --rig` selects by NAME: a pointer at `--rig <id>` would filter the
      // selected identity out. The advice names the existing all-rigs view and
      // says what it really covers.
      expect(out).toContain("rig ps --nodes -A --include-archived (all rigs, not specific to this restore)");
      expect(out).not.toContain(`--nodes --rig ${RIG_ID}`);
      expect(out).not.toContain("rig down");
    }
    expect(out).not.toContain("rig down solo");
  });

  it("the in-progress advice's command is accepted by its consumer and never filters by the id", async () => {
    // ID-different-from-name control: id RIG_ID, name "solo". `ps --rig`
    // selects by NAME, so pointing it at the id would hide the selected rig;
    // the advice must name a command the ps consumer accepts and that does
    // not pass the id as a rig selector.
    const d = fakeDaemon([{ id: REMOVED_RIG_ID, name: "solo" }, { id: RIG_ID, name: "solo", archivedAt: "2026-10-21" }]);
    vi.spyOn(d.deps.clientFactory(""), "post").mockResolvedValue({ status: 409, data: { code: "restore_in_progress", error: "conflict" } });
    const { out } = await run(restoreCommand(d.deps), ["restore", "snap-1", "--rig", "solo"]);
    const advised = out.match(/rig (ps --nodes -A --include-archived)/)?.[0];
    expect(advised).toBe("rig ps --nodes -A --include-archived");
    expect(out).not.toContain(`--rig ${RIG_ID}`);
    // Consumer check: the real ps command accepts exactly those flags
    // (parseOptions validates without executing the action).
    const ps = psCommand({} as never);
    expect(() => ps.parseOptions(["--nodes", "-A", "--include-archived"])).not.toThrow();
    expect(ps.opts()).toMatchObject({ nodes: true, allRigs: true, includeArchived: true });
    // And the consumer's own contract says --rig selects by name, not id.
    const rigOption = ps.options.find((option) => option.long === "--rig");
    expect(rigOption?.description).toContain("named rig");
  });

  it.each([".", ".."])("lists and restores the name %s through normalized fetch URLs", async (name) => {
    const requests: string[] = [];
    const client = new DaemonClient("http://fixture", {
      sessionName: "",
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
        if (url.pathname === "/api/rigs/summary") return Response.json([{ id: RIG_ID, name }]);
        if (url.pathname === `/api/rigs/${RIG_ID}/snapshots`) return Response.json(SNAPSHOTS[RIG_ID]);
        if (url.pathname === `/api/rigs/${RIG_ID}/restore/snap-1`) return Response.json({ attemptId: 7, status: "started" }, { status: 202 });
        return Response.json({ error: "unexpected normalized route" }, { status: 404 });
      },
    });
    client.remoteTarget = true;
    const deps = { lifecycleDeps: lifecycleDeps(), clientFactory: () => client };
    const listed = await run(snapshotCommand(deps), ["snapshot", "list", name]);
    const restored = await run(restoreCommand(deps), ["restore", "snap-1", "--rig", name]);
    expect(listed.out).toContain("snap-1");
    expect(listed.exitCode).toBeUndefined();
    expect(restored.exitCode).toBeUndefined();
    expect(requests).toEqual([
      "GET /api/rigs/summary?includeArchived=true",
      `GET /api/rigs/${RIG_ID}/snapshots`,
      "GET /api/rigs/summary?includeArchived=true",
      `POST /api/rigs/${RIG_ID}/restore/snap-1`,
    ]);
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
