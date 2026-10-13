import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec as execCallback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";

const exec = promisify(execCallback);
const quote = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";
let nativeAvailable = false;
try {
  execFileSync("tmux", ["-V"], { stdio: "ignore" });
  execFileSync("bash", ["--version"], { stdio: "ignore" });
  nativeAvailable = process.platform !== "win32";
} catch { /* Native shell verification requires tmux and Bash. */ }

// Private server and in-memory registry: no agent runtime, credentials or live daemon.
describe.skipIf(!nativeAvailable)("terminal send verification through native Bash", () => {
  it("confirms a command at a glyph prompt before a later prompt appears", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-verify-"));
    const socket = path.join(root, "tmux.sock");
    const sessionName = "infra-ui@term-rig";
    const rc = path.join(root, "bashrc");
    fs.writeFileSync(rc, "PS1='❯ '; unset PROMPT_COMMAND; bind 'set enable-bracketed-paste on'\n");
    const run = async (command: string) => (await exec(command.replace(/^tmux /,
      `tmux -S ${quote(socket)} `))).stdout;
    const db = createFullTestDb();
    try {
      await run(`tmux new-session -d -s ${quote(sessionName)} -x 160 -y 40 ${quote(`bash --noprofile --rcfile ${quote(rc)} -i`)}`);
      const tmux = new TmuxAdapter(run);
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if ((await tmux.capturePaneContent(sessionName, 30))?.includes("❯")) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(ready).toBe(true);
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const rig = rigRepo.createRig("term-rig");
      const node = rigRepo.addNode(rig.id, "infra.ui", { role: "ui", runtime: "terminal" });
      const session = sessionRegistry.registerSession(node.id, sessionName);
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName });
      const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
      // Hold the command in flight so there is exactly one (historical) shell prompt.
      const result = await transport.send(sessionName, "printf 'SHELL_VERIFY_RECEIPT\\n'; sleep 15", { verify: true });
      const capture = await tmux.capturePaneContent(sessionName, 30);
      expect(capture).toContain("\nSHELL_VERIFY_RECEIPT\n");
      expect(capture?.match(/❯/g)).toHaveLength(1);
      expect(result).toMatchObject({ ok: true, verified: true, outcome: "delivered" });
    } finally {
      await run("tmux kill-server").catch(() => undefined);
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
