// `rig shrink` and `rig expand` take a rig name as well as an id, as `rig grow` and `rig remove` do (#1407).
// The daemon answers these routes by exact rig id, so a name used to come back as not found.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shrinkCommand } from "../src/commands/shrink.js";
import { expandCommand } from "../src/commands/expand.js";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

const RIG_ID = "01M5F0YZQXETQ4YVH3MJVQPQXQ";
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

/** A daemon that answers shrink and expand only for an exact rig id. */
function fakeDaemon(rigs: Array<{ id: string; name: string }>) {
  const requests: string[] = [];
  const client = {
    get: vi.fn(async (path: string) => {
      requests.push(`GET ${path}`);
      if (path.startsWith("/api/rigs/summary")) return { status: 200, data: rigs.map((r) => ({ ...r, archivedAt: null })) };
      return { status: 404, data: { error: "not found" } };
    }),
    delete: vi.fn(async (path: string) => {
      requests.push(`DELETE ${path}`);
      if (path.startsWith(`/api/rigs/${RIG_ID}/pods/infra`)) {
        return { status: 200, data: { ok: true, status: "ok", rigId: RIG_ID, namespace: "infra", removedLogicalIds: ["infra.server"], sessionsKilled: 1, nodes: [] } };
      }
      return { status: 404, data: { error: "Rig not found" } };
    }),
    post: vi.fn(async (path: string) => {
      requests.push(`POST ${path}`);
      if (path === `/api/rigs/${RIG_ID}/expand`) {
        return { status: 201, data: { ok: true, status: "ok", podId: "pod-1", podNamespace: "infra", nodes: [], warnings: [], retryTargets: [] } };
      }
      return { status: 404, data: { ok: false, error: "Rig not found" } };
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

let dir: string;
let fragment: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rig-expand-name-"));
  fragment = join(dir, "pod.yaml");
  writeFileSync(fragment, "pod:\n  id: infra\n  label: Infra\n  members:\n    - id: server\n      runtime: terminal\n      agent_ref: builtin:terminal\n      profile: none\n      cwd: .\n  edges: []\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => { process.exitCode = undefined; });

describe("rig shrink", () => {
  it("removes a pod from the rig named on the command line", async () => {
    const d = fakeDaemon([{ id: RIG_ID, name: "demo" }]);
    const { out, exitCode } = await run(shrinkCommand(d.deps), ["shrink", "demo", "infra"]);
    expect(d.requests).toContain(`DELETE /api/rigs/${RIG_ID}/pods/infra`);
    expect(out).toContain("Removed pod infra");
    expect(exitCode).toBeUndefined();
  });

  it("refuses a name two active rigs share, before any request that changes a rig", async () => {
    const d = fakeDaemon([{ id: RIG_ID, name: "twin" }, { id: OTHER_ID, name: "twin" }]);
    const { out, exitCode } = await run(shrinkCommand(d.deps), ["shrink", "twin", "infra"]);
    expect(out).toContain("'twin' matches 2 rigs");
    expect(d.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
    expect(exitCode).toBe(1);
  });

  it("an id, or a handle no rig matches, goes to the daemon as given", async () => {
    const byId = fakeDaemon([{ id: RIG_ID, name: "demo" }]);
    await run(shrinkCommand(byId.deps), ["shrink", RIG_ID, "infra"]);
    expect(byId.requests).toContain(`DELETE /api/rigs/${RIG_ID}/pods/infra`);

    const unknown = fakeDaemon([{ id: RIG_ID, name: "demo" }]);
    const { exitCode } = await run(shrinkCommand(unknown.deps), ["shrink", "nope", "infra"]);
    expect(unknown.requests).toContain("DELETE /api/rigs/nope/pods/infra");
    expect(exitCode).toBe(1);
  });
});

describe("rig expand", () => {
  it("adds the pod to the rig named on the command line", async () => {
    const d = fakeDaemon([{ id: RIG_ID, name: "demo" }]);
    const { exitCode } = await run(expandCommand(d.deps), ["expand", "demo", fragment]);
    expect(d.requests).toContain(`POST /api/rigs/${RIG_ID}/expand`);
    expect(exitCode).toBeUndefined();
  });

  it("refuses a name two active rigs share, before any request that changes a rig", async () => {
    const d = fakeDaemon([{ id: RIG_ID, name: "twin" }, { id: OTHER_ID, name: "twin" }]);
    const { out, exitCode } = await run(expandCommand(d.deps), ["expand", "twin", fragment, "--json"]);
    expect(JSON.parse(out)).toMatchObject({ ok: false, code: "rig_ambiguous", candidates: [RIG_ID, OTHER_ID] });
    expect(d.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
    expect(exitCode).toBe(1);
  });
});
