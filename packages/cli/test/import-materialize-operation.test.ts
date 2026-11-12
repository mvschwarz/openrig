import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { importCommand, type ImportDeps } from "../src/commands/import.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps } from "../src/daemon-lifecycle.js";

const operationId = randomUUID();
const operation = { contract: "operation-correlation.v1", operationId, rigId: "prepared-rig", nodeIds: ["prepared-node"],
  current: { rig: { id: "prepared-rig", exists: true, archivedAt: null }, nodes: [{ id: "prepared-node", exists: true, latestSession: null }] } };
const replies = {
  fresh: { status: 201, data: { rigId: "prepared-rig", specName: "prepared", specVersion: "0.2", nodes: [{ logicalId: "core.shell", status: "materialized" }], operation } },
  replay: { status: 200, data: { replayed: true, operation } },
  conflict: { status: 409, data: { code: "operation_id_conflict" } },
  empty: { status: 200, data: { replayed: true, operation: { ...operation, rigId: null, nodeIds: [], current: { rig: null, nodes: [] } } } },
};
let freshOperation: unknown = operation;
let freshNodes = replies.fresh.data.nodes;
let replayOperation: unknown = operation;
let mode: keyof typeof replies = "fresh";
let supportsMaterialization = true;
let capabilityResponse: "json" | "not-found" | "unreadable" = "json";
const requests: Array<{ url: string | undefined; headers: http.IncomingHttpHeaders; body: string }> = [];
let server: http.Server, port: number;
let priorExit: typeof process.exitCode;
const spec = 'version: "0.2"\nname: prepared\npods: []\nedges: []\n';

function lifecycle(): LifecycleDeps {
  return {
    spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
    readFile: p => p === STATE_FILE ? JSON.stringify({ pid: 123, port, db: "fixture.sqlite", startedAt: "2026-01-01T00:00:00Z" }) : null,
    writeFile: vi.fn(), removeFile: vi.fn(), exists: p => p === STATE_FILE, mkdirp: vi.fn(), openForAppend: () => 3,
    isProcessAlive: () => true,
  };
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body });
    if (req.method === "GET" && req.url === "/api/operations/capabilities") {
      if (capabilityResponse !== "json") {
        res.writeHead(capabilityResponse === "not-found" ? 404 : 200, { "Content-Type": "text/plain" });
        res.end(capabilityResponse === "not-found" ? "Not Found" : "incomplete response");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ contract: "operation-correlation.v1", kinds: supportsMaterialization ? ["rig.materialize"] : ["rig.import"] }));
      return;
    }
    const reply = mode === "fresh" ? { ...replies.fresh, data: { ...replies.fresh.data, nodes: freshNodes, operation: freshOperation } }
      : mode === "replay" ? { ...replies.replay, data: { replayed: true, operation: replayOperation } } : replies[mode];
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
  port = address.port;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
afterEach(() => {
  process.exitCode = priorExit; vi.restoreAllMocks(); requests.length = 0;
  supportsMaterialization = true; capabilityResponse = "json"; freshOperation = operation; replayOperation = operation;
  freshNodes = replies.fresh.data.nodes;
});

async function run(flags: string[]) {
  priorExit = process.exitCode;
  process.exitCode = undefined;
  const output: string[] = [], errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => output.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => errors.push(args.join(" ")));
  const deps: ImportDeps = { lifecycleDeps: lifecycle(), clientFactory: () => new DaemonClient(`http://127.0.0.1:${port}`), readFile: () => spec };
  const command = new Command().exitOverride();
  command.addCommand(importCommand(deps));
  await command.parseAsync(["node", "rig", "import", "team.yaml", ...flags]);
  return { output, errors, exitCode: process.exitCode };
}

describe("rig import --materialize-only operation receipts", () => {
  it.each(["fresh", "replay"] as const)("prints a usable %s JSON receipt and forwards the same operation id", async response => {
    mode = response;
    const result = await run(["--materialize-only", "--operation-id", operationId, "--json", "--rig-root", "/fixture/team"]);
    expect(result.exitCode).not.toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.output).toHaveLength(1);
    expect(JSON.parse(result.output[0]!)).toEqual(replies[response].data);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe("/api/operations/capabilities");
    expect(requests[1]).toMatchObject({ url: "/api/rigs/import/materialize", body: spec,
      headers: { "x-openrig-operation-id": operationId, "x-rig-root": "/fixture/team" } });
  });

  it("renders a replay in text without assuming fresh-result fields exist", async () => {
    mode = "replay";
    const result = await run(["--materialize-only", "--operation-id", operationId]);
    expect(result.exitCode).not.toBe(1);
    expect(result.output.join("\n")).toContain("prepared-rig");
    expect(result.output.join("\n")).toContain("prepared-node");
    expect(result.errors).toEqual([]);
  });

  it.each([
    { response: "fresh", target: false }, { response: "replay", target: false },
    { response: "fresh", target: true }, { response: "replay", target: true },
  ] as const)("confirms an empty-pod $response receipt (target: $target)", async ({ response, target }) => {
    mode = response;
    const emptyPodOperation = { ...operation, nodeIds: [], current: { ...operation.current, nodes: [] } };
    freshOperation = emptyPodOperation;
    replayOperation = emptyPodOperation;
    freshNodes = [];
    const result = await run(["--materialize-only", "--operation-id", operationId,
      ...(target ? ["--target-rig", "prepared-rig"] : [])]);
    expect(result.exitCode).not.toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.output).toEqual([response === "fresh"
      ? "Rig materialized: prepared (prepared-rig)" : "Materialization replay: prepared-rig"]);
    expect(requests[1]?.headers["x-target-rig-id"]).toBe(target ? "prepared-rig" : undefined);
  });

  it.each([
    { name: "archived rig", current: { ...operation.current, rig: { ...operation.current.rig, archivedAt: "2026-01-02T00:00:00Z" } } },
    { name: "deleted rig", current: { ...operation.current, rig: { ...operation.current.rig, exists: false } } },
    { name: "deleted node", current: { ...operation.current, nodes: [{ id: "prepared-node", exists: false }] } },
  ])("recovers recorded IDs with a warning for a $name", async ({ current }) => {
    mode = "replay";
    replayOperation = { ...operation, current };
    const result = await run(["--materialize-only", "--operation-id", operationId]);
    expect(result.exitCode).toBe(1);
    expect(result.output.join("\n")).toContain("Materialization replay: prepared-rig");
    expect(result.output.join("\n")).toContain("Node: prepared-node");
    expect(result.errors.join("\n")).toMatch(/warning.*archived|warning.*missing/i);
    expect(result.errors.join("\n")).not.toContain("not confirmed");
    expect(requests).toHaveLength(2);
  });

  it("retains the native JSON receipt and nonzero exit for an unavailable replay", async () => {
    mode = "replay";
    replayOperation = { ...operation, current: { ...operation.current, nodes: [{ id: "prepared-node", exists: false }] } };
    const result = await run(["--materialize-only", "--operation-id", operationId, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output[0]!)).toEqual({ replayed: true, operation: replayOperation });
  });

  it.each(["conflict", "empty"] as const)("prints %s JSON but does not report successful materialization", async response => {
    mode = response;
    const result = await run(["--materialize-only", "--operation-id", operationId, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toHaveLength(1);
    expect(JSON.parse(result.output[0]!)).toEqual(replies[response].data);
  });

  it("explains how to resolve an operation conflict in text mode", async () => {
    mode = "conflict";
    const result = await run(["--materialize-only", "--operation-id", operationId]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toEqual([]);
    const message = result.errors.join("\n");
    expect(message).toContain("operation_id_conflict");
    expect(message).toContain("exact original request and options");
    expect(message).toContain("new operation ID");
    expect(message).toContain("deliberately start a new operation");
    expect(message).not.toContain("update your spec or target rig and retry");
  });

  it.each(["not-a-uuid", ""])("rejects a malformed operation id %j before any HTTP write", async id => {
    mode = "fresh";
    const result = await run(["--materialize-only", "--operation-id", id]);
    expect(result.exitCode).toBe(1);
    expect(requests).toEqual([]);
    expect(result.errors.join("\n")).toMatch(/UUID/i);
  });

  it("rejects an empty operation id outside materialize-only", async () => {
    const result = await run(["--operation-id", ""]);
    expect(result.exitCode).toBe(1);
    expect(requests).toEqual([]);
    expect(result.errors.join("\n")).toContain("--materialize-only");
  });

  it("preserves ordinary materialization when the operation id is omitted", async () => {
    mode = "fresh";
    const result = await run(["--materialize-only"]);
    expect(result.exitCode).not.toBe(1);
    expect(requests.map(request => request.url)).toEqual(["/api/rigs/import/materialize"]);
    expect(requests[0]?.headers["x-openrig-operation-id"]).toBeUndefined();
  });

  it.each(["--operation-id", "--json"])("requires materialize-only for the scoped %s option", async flag => {
    const result = await run(flag === "--json" ? [flag] : [flag, operationId]);
    expect(result.exitCode).toBe(1);
    expect(requests).toEqual([]);
    expect(result.errors.join("\n")).toContain("--materialize-only");
  });

  it.each(["--instantiate", "--workspace-only", "--preflight"])("rejects scoped operation options combined with %s", async flag => {
    const result = await run(["--materialize-only", "--operation-id", operationId, flag]);
    expect(result.exitCode).toBe(1);
    expect(requests).toEqual([]);
  });

  it("checks native capability support before a write to an older daemon", async () => {
    supportsMaterialization = false;
    const result = await run(["--materialize-only", "--operation-id", operationId]);
    expect(result.exitCode).toBe(1);
    expect(requests.map(request => request.url)).toEqual(["/api/operations/capabilities"]);
    expect(result.errors.join("\n")).toContain("Nothing was materialized");
  });

  it.each(["not-found", "unreadable"] as const)("explains an unreadable %s capability response before any write", async response => {
    capabilityResponse = response;
    const result = await run(["--materialize-only", "--operation-id", operationId]);
    expect(result.exitCode).toBe(1);
    expect(requests.map(request => request.url)).toEqual(["/api/operations/capabilities"]);
    expect(result.output).toEqual([]);
    expect(result.errors.join("\n")).toContain("Nothing was materialized");
    expect(result.errors.join("\n")).toContain("upgrade the daemon");
  });

  it.each([
    { name: "null rig", value: { ...operation, rigId: null } },
    { name: "different rig", value: { ...operation, rigId: "another-rig" } },
    { name: "empty node ids", value: { ...operation, nodeIds: [] } },
    { name: "extra node ids", value: { ...operation, nodeIds: ["prepared-node", "another-node"] } },
    { name: "unmatched node ids", value: { ...operation, nodeIds: ["another-node"] } },
    { name: "missing current state", value: { ...operation, current: undefined } },
  ])("rejects a contradictory fresh receipt: $name", async ({ value }) => {
    mode = "fresh";
    freshOperation = value;
    const result = await run(["--materialize-only", "--operation-id", operationId, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output[0]!)).toMatchObject({ rigId: "prepared-rig" });
  });
});
