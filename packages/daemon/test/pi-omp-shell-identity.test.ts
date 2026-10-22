// A Pi or OMP seat runs its agent behind the OpenRig runner, so its pane's foreground is `node` while the agent
// runs. A bare shell in that pane means the agent exited: it must read as an identity mismatch, not verified,
// through both identity writers (the periodic reconciler and the fresh re-check used by restore, fresh launch
// and clear-attention). Terminal seats deliberately run a shell and stay verified.

import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SeatIdentityReconciler, classifyPaneRuntimeMatch } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

type Pane = { pid: number | null; command: string | null };

/** One running, tmux-bound seat of `runtime`, its pane reporting `pane`. */
function seat(runtime: string, pane: Pane) {
  const db = createFullTestDb(); databases.push(db);
  const repo = new RigRepository(db), registry = new SessionRegistry(db);
  const rig = repo.createRig("shellid"), name = `${runtime}-seat@shellid`, paneId = "%7";
  const node = repo.addNode(rig.id, "worker", { role: "worker", runtime });
  const session = registry.registerSession(node.id, name);
  registry.updateStatus(session.id, "running");
  registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: paneId });
  const tmux = {
    listSessions: vi.fn(async () => [{ name }] as never),
    listPanes: vi.fn(async () => [{ id: paneId }] as never),
    getPanePid: vi.fn(async () => pane.pid),
    getPaneCommand: vi.fn(async () => pane.command),
  };
  const listProcesses = vi.fn(async () => []);
  const poll = async () => {
    await new SeatIdentityReconciler({ db, tmux, listProcesses }).reconcileAll();
    return new SeatIdentityStore(db).getForNode(node.id);
  };
  const recheck = () => rebindAndVerifyPaneIdentity({ db, sessionRegistry: registry, tmux, nodeId: node.id,
    sessionName: name, runtime, listProcesses });
  return { poll, recheck };
}

const running: Pane = { pid: 4242, command: "node" }; // the runner, typed into the shell or exec'd from a staged script

describe("Pi and OMP at a bare shell", () => {
  for (const runtime of ["pi", "omp"]) {
    for (const shell of ["bash", "-zsh", "sh"]) {
      it(`${runtime} at ${shell}: the reconciler records a mismatch and the re-check fails`, async () => {
        expect((await seat(runtime, { pid: 4242, command: shell }).poll())?.verdict).toBe("mismatch");
        expect((await seat(runtime, { pid: 4242, command: shell }).poll())?.reason).toBe("process_identity_mismatch");
        expect((await seat(runtime, { pid: 4242, command: shell }).recheck()).ok).toBe(false);
      });
    }

    it(`${runtime} with its runner in the foreground stays verified, and the re-check passes`, async () => {
      expect((await seat(runtime, running).poll())?.verdict).toBe("verified");
      expect((await seat(runtime, running).recheck()).ok).toBe(true);
    });

    for (const [label, pane] of [["an ambiguous process", { pid: 4242, command: "python" }], ["an unreadable command", { pid: 4242, command: null }]] as const) {
      it(`${runtime} with ${label} is unchanged: verified, and the re-check passes`, async () => {
        expect((await seat(runtime, pane).poll())?.verdict).toBe("verified");
        expect((await seat(runtime, pane).recheck()).ok).toBe(true);
      });
    }

    it(`${runtime} with no pane process is unchanged: pane missing`, async () => {
      expect((await seat(runtime, { pid: null, command: null }).poll())?.verdict).toBe("pane_missing");
    });
  }
});

describe("controls", () => {
  it("a terminal seat at a shell stays verified: it is meant to run one", async () => {
    for (const shell of ["bash", "-zsh"]) {
      expect((await seat("terminal", { pid: 4242, command: shell }).poll())?.verdict).toBe("verified");
      expect((await seat("terminal", { pid: 4242, command: shell }).recheck()).ok).toBe(true);
    }
  });

  it("Claude and Codex at a shell are unchanged: a mismatch", async () => {
    for (const runtime of ["claude-code", "codex"]) {
      expect((await seat(runtime, { pid: 4242, command: "bash" }).poll())?.verdict).toBe("mismatch");
    }
  });

  it("the classifier: Pi and OMP now expect an agent; terminal and unknown runtimes don't", () => {
    for (const runtime of ["pi", "omp", "claude-code", "codex"]) expect(classifyPaneRuntimeMatch("bash", runtime)).toBe("mismatch");
    for (const runtime of ["terminal", "some-preset", null]) expect(classifyPaneRuntimeMatch("bash", runtime)).toBe("match");
    for (const runtime of ["pi", "omp"]) {
      expect(classifyPaneRuntimeMatch("node", runtime)).toBe("match");
      expect(classifyPaneRuntimeMatch("python", runtime)).toBe("match");
      expect(classifyPaneRuntimeMatch(null, runtime)).toBe("match");
    }
  });
});
