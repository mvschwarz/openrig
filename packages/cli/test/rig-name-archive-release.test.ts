// `rig archive`, `rig unarchive` and `rig release` take a rig name as well as an id, like the other rig
// lifecycle commands. The daemon answers these routes by exact rig id, so a name used to come back not found.
// `rig unarchive` targets an archived rig, so its names match among archived rigs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { archiveCommand } from "../src/commands/archive.js";
import { unarchiveCommand } from "../src/commands/unarchive.js";
import { releaseCommand } from "../src/commands/release.js";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

const LIVE_ID = "01M5F0YZQXETQ4YVH3MJVQPQXQ";
const ARCHIVED_ID = "01M5F0ARCHIVEDRIGIDXXXXXXX";
const OTHER_ID = "01M5F0OTHERRIGIDXXXXXXXXXX";

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

type Rig = { id: string; name: string; archivedAt: string | null };

/** A daemon that answers archive, unarchive and release only for an exact rig id. */
function fakeDaemon(rigs: Rig[]) {
  const requests: string[] = [];
  const known = new Set(rigs.map((r) => r.id));
  const client = {
    get: vi.fn(async (path: string) => {
      requests.push(`GET ${path}`);
      if (path.startsWith("/api/rigs/summary")) return { status: 200, data: rigs };
      return { status: 404, data: { error: "not found" } };
    }),
    post: vi.fn(async (path: string) => {
      requests.push(`POST ${path}`);
      const m = /^\/api\/rigs\/([^/]+)\/(archive|unarchive|release)$/.exec(path);
      if (!m || !known.has(m[1]!)) return { status: 404, data: { error: "Rig not found" } };
      if (m[2] === "archive") return { status: 200, data: { ok: true, rigId: m[1], archived: true } };
      if (m[2] === "unarchive") return { status: 200, data: { ok: true, rigId: m[1], unarchived: true } };
      return { status: 200, data: { ok: true, status: "ok", released: [], failed: [] } };
    }),
  };
  const deps: StatusDeps = { lifecycleDeps: lifecycleDeps(), clientFactory: () => client as unknown as DaemonClient };
  return { requests, deps };
}

async function run(command: Command, argv: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { lines.push(String(chunk)); return true; });
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
    write.mockRestore();
  }
}

afterEach(() => { process.exitCode = undefined; });

const rigs: Rig[] = [
  { id: LIVE_ID, name: "demo", archivedAt: null },
  { id: ARCHIVED_ID, name: "old-demo", archivedAt: "2026-10-20T00:00:00Z" },
];

describe("rig archive", () => {
  it("archives the rig named on the command line, and the unarchive hint names its id", async () => {
    const d = fakeDaemon(rigs);
    const { out, exitCode } = await run(archiveCommand(d.deps), ["archive", "demo"]);
    expect(d.requests).toContain(`POST /api/rigs/${LIVE_ID}/archive`);
    expect(out).toContain(`Bring it back: rig unarchive ${LIVE_ID}`);
    expect(exitCode).toBeUndefined();
  });

  it("stops on a name two active rigs share, with rig_ambiguous under --json", async () => {
    const d = fakeDaemon([{ id: LIVE_ID, name: "twin", archivedAt: null }, { id: OTHER_ID, name: "twin", archivedAt: null }]);
    const { out, exitCode } = await run(archiveCommand(d.deps), ["archive", "twin", "--json"]);
    expect(JSON.parse(out)).toMatchObject({ ok: false, code: "rig_ambiguous", candidates: [LIVE_ID, OTHER_ID] });
    expect(d.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    expect(exitCode).toBe(1);
  });
});

describe("rig unarchive", () => {
  it("unarchives an archived rig by its name", async () => {
    const d = fakeDaemon(rigs);
    const { out, exitCode } = await run(unarchiveCommand(d.deps), ["unarchive", "old-demo"]);
    expect(d.requests).toContain(`POST /api/rigs/${ARCHIVED_ID}/unarchive`);
    expect(out).toContain("unarchived");
    expect(exitCode).toBeUndefined();
  });

  it("matches names among archived rigs only, and still takes an id", async () => {
    // "demo" is an active rig's name: unarchive sends it as given, and the daemon answers not found.
    const byActiveName = fakeDaemon(rigs);
    const active = await run(unarchiveCommand(byActiveName.deps), ["unarchive", "demo"]);
    expect(byActiveName.requests).toContain("POST /api/rigs/demo/unarchive");
    expect(active.exitCode).toBe(1);

    const byId = fakeDaemon(rigs);
    await run(unarchiveCommand(byId.deps), ["unarchive", ARCHIVED_ID]);
    expect(byId.requests).toContain(`POST /api/rigs/${ARCHIVED_ID}/unarchive`);
  });

  it("stops on a name two archived rigs share", async () => {
    const d = fakeDaemon([{ id: ARCHIVED_ID, name: "gone", archivedAt: "2026-10-20T00:00:00Z" }, { id: OTHER_ID, name: "gone", archivedAt: "2026-10-19T00:00:00Z" }]);
    const { out, exitCode } = await run(unarchiveCommand(d.deps), ["unarchive", "gone"]);
    expect(out).toContain("'gone' matches 2 archived rigs");
    expect(d.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    expect(exitCode).toBe(1);
  });
});

describe("rig release", () => {
  it("releases claimed sessions from the rig named on the command line", async () => {
    const d = fakeDaemon(rigs);
    const { exitCode } = await run(releaseCommand(d.deps), ["release", "demo"]);
    expect(d.requests).toContain(`POST /api/rigs/${LIVE_ID}/release`);
    expect(exitCode).toBeUndefined();
  });

  it("stops on a name two active rigs share", async () => {
    const d = fakeDaemon([{ id: LIVE_ID, name: "twin", archivedAt: null }, { id: OTHER_ID, name: "twin", archivedAt: null }]);
    const { out, exitCode } = await run(releaseCommand(d.deps), ["release", "twin"]);
    expect(out).toContain("'twin' matches 2 active rigs");
    expect(d.requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    expect(exitCode).toBe(1);
  });
});
