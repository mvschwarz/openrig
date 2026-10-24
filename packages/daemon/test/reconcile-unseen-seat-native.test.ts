import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { execCommand } from "../src/adapters/tmux-exec.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { createFullTestDb } from "./helpers/test-app.js";

// The incident, with a real tmux: the seats live on a tmux server named by a socket the daemon didn't inherit (no TMUX
// in its environment), so the daemon's own tmux reaches an empty default server. Its startup reconcile must leave the
// seat as it was while the seat's process runs, also after its own identity poll saw nothing, find it again once TMUX
// names the seats' socket, and detach it once that server is really gone.

let nativeAvailable = process.platform !== "win32";
try { execFileSync("tmux", ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }

const run = promisify(execFile);
const roots: string[] = [];
const sockets: string[] = [];
afterAll(async () => {
  for (const sock of sockets) await run("tmux", ["-S", sock, "kill-server"]).catch(() => {});
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!nativeAvailable)("startup reconcile against a real tmux server it can't see", () => {
  it("leaves a running seat as it was across two blind restarts, finds it on its own server, and detaches it once that server is gone", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-unseen-"));
    roots.push(root);
    const sock = path.join(root, "seats.sock");
    sockets.push(sock);
    const empty = path.join(root, "daemon-tmux");
    fs.mkdirSync(empty);
    const seatEnv: NodeJS.ProcessEnv = { ...process.env, HOME: root, SHELL: "/bin/sh" };
    delete seatEnv.TMUX;
    const created = await run("tmux", ["-S", sock, "-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_pid}",
      "-s", "advisor-lead@demo", "sleep 600"], { env: seatEnv });
    const panePid = Number(created.stdout.trim());
    expect(panePid, created.stdout).toBeGreaterThan(0);

    // The daemon's environment: no TMUX, and a private TMUX_TMPDIR, so its default server is an empty one of its own.
    vi.stubEnv("TMUX", undefined);
    vi.stubEnv("TMUX_TMPDIR", empty);
    try {
      const db = createFullTestDb();
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const rigRepo = new RigRepository(db);
      const rig = rigRepo.createRig("demo");
      const node = rigRepo.addNode(rig.id, "advisor.lead", { role: "advisor" });
      const session = sessionRegistry.registerSession(node.id, "advisor-lead@demo");
      sessionRegistry.updateStatus(session.id, "running");
      // A second later than the pane's start, as the identity reconciler would observe it.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      new SeatIdentityStore(db).upsert({
        nodeId: node.id, verdict: "verified", evidenceSource: null, reason: null,
        evidence: { registeredPane: "%0", observedPid: panePid, observedPanePid: panePid, observedCommand: "sleep", matchedLayer: 1 },
        sessionName: "advisor-lead@demo", observedAt: new Date().toISOString(),
      });
      const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: new TmuxAdapter(execCommand) });

      const unseen = await reconciler.reconcile(rig.id);
      expect(unseen).toMatchObject({ detached: 0, unseen: [{ sessionName: "advisor-lead@demo", pid: panePid }] });
      expect(unseen.unseen[0]!.parent?.command).toContain(sock);
      expect(sessionRegistry.getSessionsForRig(rig.id)[0]!.status).toBe("running");

      // The blind daemon's own identity poll sees no sessions and honestly records no pid; a second blind restart still
      // finds the seat's last observed process running.
      await new SeatIdentityReconciler({ db, tmux: new TmuxAdapter(execCommand) }).reconcileAll();
      expect(new SeatIdentityStore(db).getForNode(node.id)!.evidence.observedPid).toBeNull();
      expect(await reconciler.reconcile(rig.id)).toMatchObject({ detached: 0, unseen: [{ pid: panePid }] });

      // Restarted with TMUX naming the seats' socket, the daemon sees the seat again.
      vi.stubEnv("TMUX", `${sock},0,0`);
      expect(await reconciler.reconcile(rig.id)).toMatchObject({ checked: 1, detached: 0, unseen: [] });
      vi.stubEnv("TMUX", undefined);

      await run("tmux", ["-S", sock, "kill-server"], { env: seatEnv });
      for (let i = 0; i < 50; i++) {
        try { process.kill(panePid, 0); } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const gone = await reconciler.reconcile(rig.id);
      expect(gone).toMatchObject({ detached: 1, unseen: [] });
      expect(sessionRegistry.getSessionsForRig(rig.id)[0]!.status).toBe("detached");
      db.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
