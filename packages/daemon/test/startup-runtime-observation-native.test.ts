import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TerminalAdapter } from "../src/adapters/terminal-adapter.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { EventBus } from "../src/domain/event-bus.js";

const run = promisify(execFile);

// Real tmux and SQLite, no daemon, provider binary, account or model. Every tmux command names this test's socket.
describe.skipIf(process.platform === "win32")("native startup completion (#3578)", () => {
  it.each([false, true])("reports a terminal removed after readiness, removed=%s", async removed => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-observation-"));
    const socket = path.join(root, "owned.sock");
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_TMPDIR;
    const tmux = async (args: string[]) => (await run("tmux", ["-S", socket, ...args], { env })).stdout;
    const db = createFullTestDb();
    try {
      const repo = new RigRepository(db);
      const registry = new SessionRegistry(db);
      const rig = repo.createRig("native-completion");
      const node = repo.addNode(rig.id, "dev.control", { runtime: "terminal" });
      const name = "dev-control@native-completion";
      await tmux(["-f", "/dev/null", "new-session", "-d", "-s", name, "/bin/bash", "--noprofile", "--norc"]);
      const adapter = new TmuxAdapter(async cmd => {
        expect(cmd).toMatch(/^tmux /);
        return (await run("/bin/sh", ["-c", `tmux -S ${shellQuote(socket)} ${cmd.slice(5)}`], { env })).stdout;
      });
      const [pane] = await adapter.listPanes(name);
      if (!pane) throw new Error("Fixture terminal did not start");
      const session = registry.registerSession(node.id, name);
      registry.updateStatus(session.id, "running");
      registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: pane.id });
      const binding = registry.getBindingForNode(node.id);
      if (!binding) throw new Error("Fixture binding did not persist");
      const store = new SeatIdentityStore(db);
      store.upsert({ nodeId: node.id, verdict: "verified", evidenceSource: "pane_process", reason: null,
        sessionName: name, observedAt: "2000-01-01T00:00:00.000Z",
        evidence: { registeredPane: pane.id, observedPid: await adapter.getPanePid(pane.id), observedCommand: "bash", matchedLayer: 1 } });
      const runtime = Object.assign(new TerminalAdapter(), { checkReady: async () => {
        if (removed) await tmux(["kill-session", "-t", name]);
        return { ready: true };
      } });
      const result = await new StartupOrchestrator({ db, sessionRegistry: registry, eventBus: new EventBus(db), tmuxAdapter: adapter })
        .startNode({ rigId: rig.id, nodeId: node.id, sessionId: session.id, binding, adapter: runtime,
          plan: { runtime: "terminal", cwd: root, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
          resolvedStartupFiles: [], startupActions: [], isRestore: false });
      expect(result).toMatchObject(removed ? { ok: false, startupStatus: "attention_required" } : { ok: true, startupStatus: "ready" });
      expect(store.getForNode(node.id)?.verdict === "verified").toBe(!removed);
      expect(Date.parse(store.getForNode(node.id)?.observedAt ?? "")).toBeGreaterThan(Date.parse("2000-01-01T00:00:00.000Z"));
    } finally {
      await tmux(["kill-server"]).catch(() => undefined);
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
