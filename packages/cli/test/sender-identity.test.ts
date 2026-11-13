import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { runProgram } from "../src/cli-error.js";
import { senderIdentityHeaders } from "../src/client.js";
import { bindingIsCurrent, resetSenderSession, resolveSenderSession, TMUX_IDENTITY_TIMEOUT_MS } from "../src/sender-identity.js";

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({ ...(await original<typeof import("node:child_process")>()), execFileSync }));

afterEach(() => {
  vi.unstubAllEnvs();
  execFileSync.mockReset();
  resetSenderSession();
});

function outsideASeatEnv(pane: string): void {
  vi.stubEnv("OPENRIG_SESSION_NAME", "");
  vi.stubEnv("RIGGED_SESSION_NAME", "");
  vi.stubEnv("TMUX_PANE", pane);
}

describe("managed sender identity recovery", () => {
  it("uses reconciled pane metadata when the live process missed the seat env", () => {
    outsideASeatEnv("%149");
    const metadata: Record<string, string> = { "@rigged_session_name": "producer-lead@studio", "@rigged_node_id": "node-1" };
    const read = (pane: string, option: string) => {
      expect(pane).toBe("%149");
      return metadata[option];
    };
    const bound = (nodeId: string, session: string) => nodeId === "node-1" && session === "producer-lead@studio";
    expect(resolveSenderSession(read, bound)).toBe("producer-lead@studio");
    expect(senderIdentityHeaders(undefined, undefined, read, bound)).toEqual({
      "X-OpenRig-Session": "producer-lead@studio",
    });
  });

  it("keeps the process seat env authoritative over pane metadata", () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "dev-coder@studio");
    vi.stubEnv("TMUX_PANE", "%149");
    expect(resolveSenderSession(() => "producer-lead@studio", () => true)).toBe("dev-coder@studio");
  });

  it("bounds the tmux read, and a read that times out leaves the seat unresolved", () => {
    outsideASeatEnv("%149");
    // The reader catches what the call throws, so the options are checked here, not inside the mock.
    execFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("spawnSync tmux ETIMEDOUT"), { code: "ETIMEDOUT" });
    });
    expect(resolveSenderSession()).toBeUndefined();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(execFileSync.mock.calls[0]![2]).toMatchObject({ timeout: TMUX_IDENTITY_TIMEOUT_MS });
    expect(TMUX_IDENTITY_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });

  it("stays unresolved when neither env nor managed pane metadata exists", () => {
    outsideASeatEnv("%404");
    expect(resolveSenderSession(() => undefined, () => true)).toBeUndefined();
  });

  it("reads the pane once per run: a command's preflight and its requests share it, and the next run reads again", async () => {
    outsideASeatEnv("%149");
    execFileSync.mockImplementation((_tmux: string, args: string[]) => args.at(-1) === "@rigged_session_name" ? "producer-lead@studio\n" : "node-1\n");
    const bound = () => true;
    const run = () => runProgram(new Command().action(() => {
      expect(resolveSenderSession(undefined, bound)).toBe("producer-lead@studio"); // the preflight
      expect(senderIdentityHeaders(undefined, undefined, undefined, bound)).toEqual({ "X-OpenRig-Session": "producer-lead@studio" });
      expect(senderIdentityHeaders("origin-a", undefined, undefined, bound)).toEqual({ "X-OpenRig-Session": "producer-lead@studio@origin-a" });
    }), ["node", "rig"], { exit: () => undefined });
    expect(await run()).toBe(0);
    expect(execFileSync).toHaveBeenCalledTimes(2); // the seat and its node, once
    expect(await run()).toBe(0);
    expect(execFileSync).toHaveBeenCalledTimes(4);
  });
});

describe("a pane's seat holds only while the daemon binds it", () => {
  // A real claim sets the session's metadata and the daemon's binding. A real unclaim deletes the binding in its own
  // transaction even when clearing the metadata fails, which leaves the pane naming its old seat.
  async function claimedPane() {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const setup = createTestApp(db);
    const metadata = new Map<string, string>();
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockImplementation(async (_session: string, key: string, value: string) => {
      metadata.set(key, value);
      return { ok: true as const };
    });
    const rig = setup.rigRepo.createRig("adoption-fixture");
    const node = setup.rigRepo.addNode(rig.id, "external.helper", { runtime: "terminal" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "manual-adoption", tmuxPane: "%1", cwd: "/tmp",
      activeCommand: "bash", runtimeHint: "terminal", confidence: "high",
    });
    const claim = await setup.claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: node.logicalId });
    if (!claim.ok) throw new Error(claim.error);
    const read = (_pane: string, option: string) => metadata.get(option) || undefined;
    const bound = (nodeId: string, session: string) => bindingIsCurrent(db, nodeId, session);
    return { db, setup, claim, read, bound };
  }

  it("reads a claimed session the daemon binds as its seat", async () => {
    outsideASeatEnv("%1");
    const { db, read, bound } = await claimedPane();
    expect(resolveSenderSession(read, bound)).toBe("manual-adoption");
    db.close();
  });

  it("reads a released session as unknown when clearing its metadata failed", async () => {
    outsideASeatEnv("%1");
    const { db, setup, claim, read, bound } = await claimedPane();
    vi.mocked(setup.tmuxAdapter.setSessionOption).mockImplementation(async () => { throw new Error("tmux: no server"); });
    expect((await setup.rigLifecycleService.unclaimSession(claim.sessionId)).ok).toBe(true);
    expect(read("%1", "@rigged_session_name")).toBe("manual-adoption");
    expect(resolveSenderSession(read, bound)).toBeUndefined();
    db.close();
  });
});
