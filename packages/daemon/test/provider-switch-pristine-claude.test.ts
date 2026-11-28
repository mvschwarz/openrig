import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";
import { providerRoutes } from "../src/routes/provider.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { readClaudeSeatTokenRef } from "../src/domain/claude-seat-token.js";
import { createFullTestDb } from "./helpers/test-app.js";

// A materialized Claude seat that has never launched gets its own subscription token through `rig provider switch`, by the
// daemon's real route, provider service and credential checks, and its first launch's own command gives Claude that token.

const exec = promisify(execFile);
const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });
const SYNTHETIC = "synthetic-fixture-value-not-a-credential";

it.skipIf(process.platform === "win32")("a never-launched seat's saved reference reaches its first launch's Claude, and nothing else about the seat changes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pristine-claude-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), home = path.join(root, "home"), work = path.join(root, "work");
  for (const dir of [bin, home, work]) mkdirSync(dir);
  writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nif [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; exit 0; fi\nprintf '{"TOKEN":"%s"}' "\${CLAUDE_CODE_OAUTH_TOKEN-absent}"\n`);
  chmodSync(path.join(bin, "claude"), 0o700);
  const tokenFile = path.join(root, "work.token");
  writeFileSync(tokenFile, `${SYNTHETIC}\n`, { mode: 0o600 });

  const db = createFullTestDb(); cleanup.push(() => db.close());
  const repo = new RigRepository(db), eventBus = new EventBus(db);
  const rig = repo.createRig("fixture-rig");
  const node = repo.addNode(rig.id, "dev.a", { runtime: "claude-code", cwd: work, model: "claude-opus-5-5" });
  const other = repo.addNode(rig.id, "dev.b", { runtime: "claude-code", cwd: work });
  repo.addEdge(rig.id, other.id, node.id, "delegates_to");
  const before = { node: db.prepare("SELECT * FROM nodes WHERE id = ?").get(node.id) as Record<string, unknown>,
    other: db.prepare("SELECT * FROM nodes WHERE id = ?").get(other.id), edges: db.prepare("SELECT * FROM edges").all() };
  const managed = new ClaudeManagedLaunch(db, { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, {}, async () => undefined);
  const service = new ProviderServiceImpl({ db, listRigs: () => [], claudePrecedence: (nodeId, opts) => managed.credentialPrecedence(nodeId, opts) });
  const app = new Hono();
  app.use("*", async (c, next) => {
    for (const [key, value] of Object.entries({ rigRepo: repo, eventBus, providerService: service })) c.set(key as never, value as never);
    await next();
  });
  app.route("/api/provider", providerRoutes());

  const response = await app.request("/api/provider/switch", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seat: "dev-a@fixture-rig", toAccount: "work", tokenFile }) });
  const body = await response.json() as { outcome: string; message: string; seat: { next: string } };
  expect({ status: response.status, body }, JSON.stringify(body)).toMatchObject({ status: 200, body: { outcome: "succeeded",
    message: `dev-a@fixture-rig has never launched, so nothing was relaunched. Its first launch uses its token reference "work": rig launch fixture-rig dev.a.` } });
  expect(readClaudeSeatTokenRef(db, node.id)).toEqual({ label: "work", tokenFile });
  expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });

  // Only the reference changed: the seat's other settings, the other seat and the edges are as they were.
  const after = db.prepare("SELECT * FROM nodes WHERE id = ?").get(node.id) as Record<string, unknown>;
  expect({ ...after, claude_token_ref: null }).toEqual({ ...before.node, claude_token_ref: null });
  expect(db.prepare("SELECT * FROM nodes WHERE id = ?").get(other.id)).toEqual(before.other);
  expect(db.prepare("SELECT * FROM edges").all()).toEqual(before.edges);
  const recorded = db.prepare("SELECT payload FROM events WHERE type = 'node.claude_token_ref_changed'").all() as Array<{ payload: string }>;
  expect(recorded.map((r) => JSON.parse(r.payload))).toEqual([expect.objectContaining({ nodeId: node.id, from: null, to: "work", tokenFile, credential: "subscription_token", effect: "first_launch" })]);

  // The first launch's managed command reads the file as Claude starts: the token reaches Claude, never the command text.
  const launch = await managed.prepare({ nodeId: node.id }, "auto");
  const command = launch.command(["--permission-mode", "auto"]);
  expect(command).toContain(tokenFile);
  expect(command).not.toContain(SYNTHETIC);
  expect(launch.warnings).toEqual([]);
  const ran = await exec("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin" }, timeout: 5000 });
  expect(JSON.parse(ran.stdout)).toEqual({ TOKEN: SYNTHETIC });
});
