import { expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { CodexUsageWindows } from "../src/domain/provider/codex-usage-windows.js";
import { resolveCodexHome } from "../src/domain/codex-auth.js";

const home = vi.hoisted(() => ({ account: "", other: "" }));
vi.mock("node:os", async original => {
  const actual = await original<typeof import("node:os")>();
  const userInfo = () => ({ ...actual.userInfo(), homedir: home.account });
  const homedir = () => home.other;
  return { ...actual, userInfo, homedir, default: { ...actual, userInfo, homedir } };
});

it("keeps provider account projection on the auth resolver's home when HOME is empty", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-empty-home-"));
  home.account = path.join(root, "account"); home.other = path.join(root, "other");
  fs.mkdirSync(home.account); fs.mkdirSync(home.other);
  const db = createFullTestDb();
  try {
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r', 'r')").run();
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES ('p', 'r', 'dev', 'Dev')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES ('cx', 'r', 'dev.cx', 'codex', ?, 'p')").run(root);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('s', 'cx', 'cx@r', 'running', 'ready')").run();
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES ('b', 'cx', 'cx@r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES ('cl', 'r', 'dev.cl', 'claude-code', ?, 'p')").run(root);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('sc', 'cl', 'cl@r', 'running', 'ready')").run();
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES ('bc', 'cl', 'cl@r')").run();
    const read = vi.fn(async () => { throw new Error("read-only status must not probe"); });
    for (const env of [{ HOME: "" }, { HOME: "", CODEX_HOME: path.join(root, "selected") }]) {
      const service = new ProviderServiceImpl({ db, listRigs: () => [{ id: "r" }], env,
        usageWindows: { enabled: () => true, windows: new CodexUsageWindows({ read }) } });
      const model = await service.getReadModel();
      const accounts = new Map(model.seatAccounts?.map(row => [row.seatSession, row]));
      expect(accounts.get("cx@r")?.configured).toMatchObject({ source: "default_login", home: resolveCodexHome(env).codexHome });
      expect(accounts.get("cl@r")?.configured).toMatchObject({ source: "default_login", home: path.join(home.other, ".claude") });
    }
    expect(read).not.toHaveBeenCalled();
    expect(fs.readdirSync(home.account)).toEqual([]);
    expect(fs.readdirSync(home.other)).toEqual([]);
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
