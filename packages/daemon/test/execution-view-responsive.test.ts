import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { migrate } from "../src/db/migrate.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";

it("serves health and SQL views while the real execution route waits for Git", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "execution-responsive-"));
  const db = createFullTestDb();
  migrate(db, [queueItemSummarySchema]);
  const originalPath = process.env.PATH;
  let pending: Promise<Response> | undefined;
  const release = path.join(root, "release");
  try {
    const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync(realGit, ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-qm", "candidate");
    const candidate = git("rev-parse", "HEAD");
    const missions = path.join(root, "missions");
    const slice = path.join(missions, "trial", "slices", "one");
    fs.mkdirSync(slice, { recursive: true });
    fs.writeFileSync(path.join(slice, "SPEC.md"), "---\nid: ONE\ndepends_on: []\n---\n# One\n");
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session,
      state, priority, tier, tags, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "qitem-candidate", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "lead@test", "builder@test",
      "done", "normal", "light", JSON.stringify(["mission:trial", "slice:ONE", `candidate:${candidate}`]),
      `worktree_path=${repo}\n`,
    );
    const projector = new ViewProjector(db, new EventBus(db));
    projector.setExecutionDeps({ db, slicesRoot: () => missions, rigsRoot: () => path.join(root, "no-rigs"),
      buildInfo: { semver: null, commit: candidate, dirty: null, builtAt: null } });
    const { app } = createTestApp(db, { appDeps: { viewProjector: projector } });

    // Real child-process rendezvous, no elapsed-time performance threshold.
    // On the synchronous implementation the parent cannot release this first
    // Git call until its bounded wait expires and the execution request finishes.
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const started = path.join(root, "started");
    fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
if (!fs.existsSync(${JSON.stringify(started)})) {
  fs.writeFileSync(${JSON.stringify(started)}, "started");
  const deadline = Date.now() + 2500;
  while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < deadline)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 2);
`, { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + originalPath;
    let settled = false;
    pending = Promise.resolve(app.request("/api/views/execution?mission=trial")).finally(() => { settled = true; });
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(fs.existsSync(started), settled ? await (await pending).clone().text() : "no child marker").toBe(true);
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });
    const sqlView = await app.request("/api/views/recently-active");
    expect(sqlView.status).toBe(200);
    expect(await sqlView.json()).toMatchObject({ viewName: "recently-active", rowCount: 0 });
    expect(settled, "execution must still be waiting when other requests answer").toBe(false);
    fs.writeFileSync(release, "release");
    const response = await pending;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows[0].q4_ladder[0]).toMatchObject({ folded: { value: true }, adopted: { value: true } });
  } finally {
    fs.writeFileSync(release, "release");
    await pending;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
