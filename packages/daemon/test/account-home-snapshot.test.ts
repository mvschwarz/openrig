import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";

it.skipIf(process.platform === "win32").each(["plan", "api-key"] as const)("down with a snapshot and existing-rig up retain the isolated home and Claude %s credential", async kind => {
  const root = mkdtempSync(path.join(tmpdir(), "account-home-snapshot-"));
  const db = createFullTestDb();
  try {
    const { app, rigRepo, sessionRegistry, snapshotRepo } = createTestApp(db);
    const home = path.join(root, "selected-plan"), bin = path.join(root, "bin");
    mkdirSync(home); mkdirSync(bin);
    const tokenFile = path.join(root, "selected-token");
    writeFileSync(tokenFile, "synthetic-selected-plan", { mode: 0o600 });
    writeFileSync(path.join(bin, "claude"), `#!/bin/sh
if [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; exit 0; fi
if [ "$${kind === "api-key" ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"}" = synthetic-selected-plan ]; then token=selected; else token=wrong; fi
printf '%s|%s' "$CLAUDE_CONFIG_DIR" "$token"
`, { mode: 0o700 });
    const rig = rigRepo.createRig("account-home-snapshot");
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", cwd: root });
    const ref = { label: "selected-plan", tokenFile, ...(kind === "api-key" ? { kind } : {}) };
    db.prepare("UPDATE nodes SET account_home = ?, claude_token_ref = ? WHERE id = ?").run(home, JSON.stringify(ref), node.id);
    const session = sessionRegistry.registerSession(node.id, "worker@account-home-snapshot");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("UPDATE sessions SET restore_policy = 'relaunch_fresh' WHERE id = ?").run(session.id);

    const down = await app.request("/api/down", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, snapshot: true, force: true }) });
    expect(down.status).toBe(200);
    const stopped = await down.json();
    expect(stopped.errors).toEqual([]);
    expect(snapshotRepo.getSnapshot(stopped.snapshotId)!.data.nodes[0]).toMatchObject({ accountHome: home, claudeTokenRef: ref });

    const up = await app.request("/api/up", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: rig.name, existing: true }) });
    expect(up.status).toBe(200);
    expect((await up.json()).status).toBe("restored");
    const status = await (await app.request("/api/seat/status/worker%40account-home-snapshot")).json();
    expect(status.runtime_home).toMatchObject({ home, source: "account-switch" });
    expect(status.claude_token).toMatchObject({ label: ref.label, token_file: tokenFile, file: "readable" });

    const launch = new ClaudeManagedLaunch(db, { PATH: `${bin}:/usr/bin:/bin`, HOME: root,
      CLAUDE_CODE_OAUTH_TOKEN: "synthetic-wrong-inherited-account" }, {}, async () => undefined);
    const command = (await launch.prepare({ nodeId: node.id }, "auto")).command(["--permission-mode", "auto"]);
    expect(command).not.toContain("synthetic-selected-plan");
    const { stdout } = await promisify(execFile)("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin" }, timeout: 5000 });
    expect(stdout).toBe(`${home}|selected`);
  } finally {
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});
