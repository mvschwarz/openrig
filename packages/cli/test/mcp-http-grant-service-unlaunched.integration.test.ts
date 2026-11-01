// An external caller's seat created the way an operator creates one without a launch (`rig import --materialize-only`),
// served by the built `rig mcp serve --http --grant-service` on a real private daemon: initialize, tools/list and a
// create/show round trip as that seat, recorded with the grant's principal. The seat check only reads: no session, no
// occupant.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prepareHermeticEnv } from "../../daemon/test/helpers/hermetic-env.js";
import { findFreePort, runRig, spawnScenarioDaemon } from "../../daemon/test/helpers/scenario-daemon.js";

const rigBin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin-wrapper.js");
const KEY = `${"8977f2dc0000aaaa1111bbbb"}.cus_VVMAexample01.${"ab".repeat(24)}`;
const RIG = "cust-team";
const CALLER = `cus-vvmaexample01-caller@${RIG}`;
const LEAD = `workshop-lead@${RIG}`;
const INITIALIZE = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
});

it("serves a materialized, never-launched caller seat over a grant service on a real daemon, and the check starts nothing", async () => {
  const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
  const daemon = await spawnScenarioDaemon(scaffold, { rigBin });
  closers.push(() => daemon.stop());
  const dbPath = path.join(scaffold.stateDir, "scenario.db");

  const spec = path.join(scaffold.root, `${RIG}.yaml`);
  const member = (id: string) => [`      - id: ${id}`, '        agent_ref: "builtin:terminal"', "        profile: none", "        runtime: terminal", `        cwd: ${scaffold.root}`];
  fs.writeFileSync(spec, [`version: "0.2"`, `name: ${RIG}`, "pods:",
    "  - id: cus-vvmaexample01", "    label: Caller", "    members:", ...member("caller"), "    edges: []",
    "  - id: workshop", "    label: Workshop", "    members:", ...member("lead"), "    edges: []", "edges: []", ""].join("\n"));
  const imported = await runRig(["import", spec, "--materialize-only"], daemon.readEnv, rigBin);
  expect(imported.code, imported.stdout + imported.stderr).toBe(0);
  const census = () => {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return {
        nodes: (db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n,
        sessions: (db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n,
      };
    } finally { db.close(); }
  };
  const before = census();
  expect(before).toEqual({ nodes: 2, sessions: 0 });

  // A grant authority answering for this daemon's own instance id.
  const instance = ((await (await fetch(`${daemon.baseUrl}/healthz`)).json()) as { selfHostId: string }).selfHostId;
  let seat = CALLER;
  const service = http.createServer((req, res) => {
    req.resume().on("end", () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      schema: "openrig.grant/v1", status: "active",
      principal: { id: "cus_VVMAexample01", kind: "external_caller" },
      grant: { id: "8977f2dc0000aaaa1111bbbb", version: 6, expires_at: null, revocation: "per_request" },
      environment: { id: RIG, core_instance: instance, lead: LEAD },
      seat, rigs: [RIG], artifact_roots: [], access_class: "work", objects: { queue: ["create", "show", "list"] },
    })));
  });
  await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => service.close(() => resolve())));

  // The built server, as an operator starts it, beside this daemon (its database proves the daemon is this host's).
  const port = await findFreePort();
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...daemon.readEnv, OPENRIG_DB: dbPath })) if (value !== undefined) env[name] = value;
  let log = "";
  const server: ChildProcess = spawn(process.execPath, [rigBin, "mcp", "serve", "--http", "--bind", `127.0.0.1:${port}`,
    "--grant-service", `http://127.0.0.1:${(service.address() as AddressInfo).port}/api/connector/v1/grant`], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout?.on("data", (chunk) => { log += chunk; });
  server.stderr?.on("data", (chunk) => { log += chunk; });
  closers.push(async () => { server.kill("SIGTERM"); });
  const url = `http://127.0.0.1:${port}/mcp`;
  const initialize = () => fetch(url, { method: "POST", body: JSON.stringify(INITIALIZE),
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${KEY}` } });
  let first: Response | undefined;
  for (const deadline = Date.now() + 30_000; !first && Date.now() < deadline;) {
    first = await initialize().catch(() => undefined);
    if (!first) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(first, log).toBeDefined();
  expect([first!.status, first!.status === 200 ? "served" : await first!.text()], log).toEqual([200, "served"]);

  const client = new Client({ name: "grant-service-caller", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
  closers.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as Record<string, any>;
  };
  // The tools the grant's objects name.
  expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["rig_queue_create", "rig_queue_list", "rig_queue_show"]);
  const created = await call("rig_queue_create", { destination: LEAD, body: "please build it" });
  const shown = await call("rig_queue_show", { qitemId: created.qitemId });
  expect(shown.item).toMatchObject({ qitemId: created.qitemId, sourceSession: CALLER, destinationSession: LEAD });

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    expect(db.prepare("SELECT source_session AS source, destination_session AS destination FROM queue_items WHERE qitem_id = ?").get(created.qitemId))
      .toEqual({ source: CALLER, destination: LEAD });
    expect(db.prepare("SELECT identity_provenance AS p, identity_principal AS who FROM queue_transitions WHERE qitem_id = ?").get(created.qitemId))
      .toEqual({ p: "principal:v1", who: JSON.stringify({ source: "grant-service", id: "cus_VVMAexample01", grant: "8977f2dc0000aaaa1111bbbb", version: 6 }) });
  } finally { db.close(); }
  // Read only: still the two created nodes, and no session for either.
  expect(census()).toEqual(before);
  const listed = await runRig(["ps", "--nodes", "--rig", RIG, "--json"], daemon.readEnv, rigBin);
  expect(listed.code, listed.stdout + listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout).map((node: { logicalId: string; canonicalSessionName: string | null }) => [node.logicalId, node.canonicalSessionName ?? null]).sort())
    .toEqual([["cus-vvmaexample01.caller", null], ["workshop.lead", null]]);

  // A seat this daemon doesn't have is still not here.
  seat = `cus-nobody01-caller@${RIG}`;
  const missing = await initialize();
  expect([missing.status, ((await missing.json()) as { error: string }).error]).toEqual([503, "seat_unavailable"]);
}, 120_000);
