import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { CodexUsageWindows } from "../src/domain/provider/codex-usage-windows.js";
import { claudeConfigRootFor } from "../src/domain/seat-runtime-home.js";

describe.runIf(process.platform === "win32")("native provider account home consumers", () => {
  it("keeps status and Claude readers on the selected copied environment homes without probing providers", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "native-account-homes-"));
    const db = createFullTestDb();
    try {
      db.prepare("INSERT INTO rigs (id, name) VALUES ('r', 'r')").run();
      db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES ('p', 'r', 'dev', 'Dev')").run();
      for (const [id, runtime] of [["cx", "codex"], ["cl", "claude-code"]]) {
        db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES (?, 'r', ?, ?, ?, 'p')").run(id, `dev.${id}`, runtime, home);
        db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, 'running', 'ready')").run(`s-${id}`, id, `${id}@r`);
        db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)").run(`b-${id}`, id, `${id}@r`);
      }
      const codexHome = path.join(home, "selected-codex");
      const claudeHome = path.join(home, "selected-claude");
      const env = { home, codex_home: codexHome, claude_config_dir: claudeHome };
      const windows = new CodexUsageWindows({ read: async () => { throw new Error("status must never start a provider"); } });
      const svc = new ProviderServiceImpl({ db, listRigs: () => [{ id: "r" }], env, usageWindows: { enabled: () => true, windows } });
      const model = await svc.getReadModel();
      const accounts = new Map(model.seatAccounts!.map(row => [row.seatSession, row]));
      expect(accounts.get("cx@r")!.configured).toMatchObject({ source: "default_login", home: codexHome });
      expect(accounts.get("cl@r")!.configured).toMatchObject({ source: "default_login", home: claudeHome });
      expect(claudeConfigRootFor(db, "cl", env, home)).toBe(claudeHome);
      expect(fs.readdirSync(home)).toEqual([]);
    } finally {
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
