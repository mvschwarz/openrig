import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { buildQueueTransfer } from "../../daemon/src/domain/queue-transfer-export.js";
import { parseQueueTransfer } from "../../daemon/src/domain/queue-transfer-parse.js";
import { AUTHORIZATION_KIND, RECEIPT_KIND } from "../../daemon/src/domain/queue-transfer-records.js";

const bin = fileURLToPath(new URL("../dist/bin-wrapper.js", import.meta.url));
const digest = "a".repeat(64);
let home: string;
let endpoint: string;
let response: { status: number; body: object };
let requests: { method?: string; path: string; bearer?: string; body: unknown }[];
const server = createServer(async (req, res) => {
  const path = req.url ?? "";
  res.setHeader("content-type", "application/json");
  if (!path.startsWith("/api/queue-transfer/")) {
    res.end(JSON.stringify({ status: "ok", home, pid: process.pid, hostId: "local-host" }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  requests.push({ method: req.method, path, bearer: req.headers.authorization, body: text ? JSON.parse(text) : null });
  res.writeHead(response.status).end(JSON.stringify(response.body));
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "queue-transfer-cli-"));
  requests = [];
  response = { status: 200, body: { recorded: true } };
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  endpoint = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(home, { recursive: true, force: true });
});

function run(...args: string[]) {
  return new Promise<{ status: number | string | null | undefined; stdout: string; stderr: string }>(resolve => {
    const { OPENRIG_SESSION_NAME: _seat, RIGGED_SESSION_NAME: _legacy, TMUX: _tmux, ...env } = process.env;
    execFile(process.execPath, [bin, "queue", "transfer", ...args], { timeout: 5000, env: {
      ...env, OPENRIG_HOME: home, OPENRIG_URL: endpoint, OPENRIG_AUTH_BEARER_TOKEN: "test-local", TEST_TRANSFER_TOKEN: "test-remote",
    } }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }));
  });
}

function file(name: string, content: object | string) {
  const path = join(home, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

it("authorize reads the staged digest and writes a private, non-overwriting record", async () => {
  response.body = { stage: { digest, origin: { hostId: "source", mintedAt: "then" } }, destinationHostId: "destination" };
  const out = join(home, "auth.json");
  const args = ["authorize", "import-one", "--map", "a@source=b@dest", "--intervention-kind", "online-handshake",
    "--actor", "operator", "--intervention", "Paused source work", "--out", out];
  const result = await run(...args);
  expect(result.status, result.stderr).toBe(0);
  expect(requests).toEqual([{ method: "GET", path: "/api/queue-transfer/staging/import-one", bearer: "Bearer test-local", body: null }]);
  const bytes = readFileSync(out, "utf8");
  expect(JSON.parse(bytes)).toMatchObject({ kind: AUTHORIZATION_KIND, archiveDigest: digest,
    destination: { hostId: "destination", seatMapping: [{ from: "a@source", to: "b@dest" }] } });
  expect(statSync(out).mode & 0o777).toBe(0o600);
  expect((await run(...args)).status).toBe(1);
  expect(readFileSync(out, "utf8")).toBe(bytes);
});

it("attest writes an isolation receipt without contacting a daemon", async () => {
  const db = new Database(":memory:");
  const archive = (() => {
    try {
      migrate(db, ALL_MIGRATIONS);
      db.exec("INSERT INTO self_host_identity VALUES (1, 'source', 'then', 'reconciled'); INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('qitem-a', '1', '1', 'a@source', 'b@dest', 'pending', 'body')");
      return buildQueueTransfer(db, { kind: "host" });
    } finally { db.close(); }
  })();
  const parsed = parseQueueTransfer(archive.archive);
  const metadata = { digest: parsed.digest, origin: parsed.origin };
  const out = join(home, "receipt.json");
  const auth = file("auth.json", { kind: AUTHORIZATION_KIND, operationId: "op", archiveDigest: metadata.digest,
    origin: metadata.origin, destination: { hostId: "dest", authorizedAt: "then", seatMapping: [] },
    intervention: { kind: "operator-attestation", actor: "operator", recordedAt: "then", limits: "no remote access" } });
  const result = await run("attest", "--archive", file("archive.json", archive.archive), "--authorization", auth,
    "--actor", "operator", "--intervention", "Powered down source", "--limits", "no remote access", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(requests).toEqual([]);
  expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ kind: RECEIPT_KIND, sourceState: "isolated", method: "operator-attestation", workflowState: [] });
});

it("relinquish uses the registered bearer and saves the unwrapped receipt", async () => {
  file("hosts.yaml", { hosts: [{ id: "source", transport: "http", url: endpoint, bearer_env: "TEST_TRANSFER_TOKEN" }] });
  response.body = { receipt: { transferId: "one" }, fenced: ["qitem-a"] };
  const out = join(home, "receipt.json");
  const result = await run("relinquish", "--host", "source", "--archive", file("archive.json", "archive bytes"),
    "--authorization", file("auth.json", { operationId: "op" }), "--actor", "operator", "--intervention", "paused", "--out", out);
  expect(result.status, result.stderr).toBe(0);
  expect(requests).toEqual([{ method: "POST", path: "/api/queue-transfer/relinquish", bearer: "Bearer test-remote",
    body: { archiveText: "archive bytes", authorization: { operationId: "op" }, actor: "operator", intervention: "paused" } }]);
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({ transferId: "one" });
});

it.each(["activate", "reconcile", "replay", "status"])("%s forwards its input and renders the daemon reply", async verb => {
  const record = file("record.json", { record: 1 });
  const archive = file("archive.json", "archive bytes");
  const calls: Record<string, { args: string[]; body: unknown }> = {
    activate: { args: ["import-one", "--authorization", record, "--receipt", record, "--dry-run", "--json"],
      body: { importId: "import-one", authorization: { record: 1 }, receipt: { record: 1 }, dryRun: true } },
    reconcile: { args: ["--archive", archive, "--receipt", record], body: { archiveText: "archive bytes", result: { record: 1 } } },
    replay: { args: [record], body: { record: { record: 1 } } },
    status: { args: ["--json"], body: null },
  };
  const call = calls[verb];
  if (!call) throw new Error(`Missing fixture for ${verb}`);
  const result = await run(verb, ...call.args);
  expect(result.status, result.stderr).toBe(0);
  expect(requests).toEqual([{ method: verb === "status" ? "GET" : "POST", path: `/api/queue-transfer/${verb}`,
    bearer: "Bearer test-local", body: call.body }]);
  expect(JSON.parse(result.stdout)).toEqual(response.body);
});

it("activate rejects --host before a request", async () => {
  const result = await run("activate", "import-one", "--host", "remote", "--authorization", "auth", "--receipt", "receipt");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("unknown option '--host'");
  expect(requests).toEqual([]);
});

it("prints the refusal JSON, exits 2 and writes no record", async () => {
  response = { status: 409, body: { error: "mapping_incomplete", qitemIds: ["qitem-a"] } };
  const record = file("record.json", {});
  const out = join(home, "result.json");
  const result = await run("activate", "import-one", "--authorization", record, "--receipt", record, "--out", out);
  expect(result.status, result.stderr).toBe(2);
  expect(JSON.parse(result.stdout)).toEqual(response.body);
  expect(statSync(out, { throwIfNoEntry: false })).toBeUndefined();
});
