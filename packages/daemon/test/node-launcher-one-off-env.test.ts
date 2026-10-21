import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

// A one-off `rig up --env` value goes onto the first pane's command line and into the tmux session
// environment (that is how `new-session -e` works). A pane respawned in that session, such as a
// handover successor, inherits the session environment, so the launch takes the one-off back out of
// the session right after the first pane exists. The first pane keeps what it was started with.

describe("NodeLauncher: a one-off --env stays with the first pane", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let calls: string[];
  let created: Record<string, string> | undefined;
  let failOn: ((call: string) => boolean) | undefined;
  let killSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    calls = [];
    created = undefined;
    failOn = undefined;
    killSession = vi.fn(async () => ({ ok: true as const }));
  });
  afterEach(() => db.close());

  function launcher(sessionEnv: Record<string, string> = { OPENRIG_HOME: "/home", HOME: "/openrig-home" }) {
    const tmux = {
      createSession: async (_name: string, _cwd?: string, env?: Record<string, string>) => { created = env; calls.push("create"); return { ok: true as const }; },
      setSessionEnv: async (_s: string, key: string, value: string) => {
        const call = `set ${key}=${value}`;
        if (failOn?.(call)) throw new Error(`tmux set-environment failed for ${key} with ${value}`);
        calls.push(call);
      },
      unsetSessionEnv: async (_s: string, key: string) => {
        const call = `unset ${key}`;
        if (failOn?.(call)) throw new Error(`tmux set-environment failed for ${key}`);
        calls.push(call);
      },
      killSession, listPanes: async () => [], listSessions: async () => [], hasSession: async () => false,
    } as unknown as TmuxAdapter;
    return new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter: tmux, sessionEnv });
  }

  function seed() {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "dev1-impl", { role: "worker", runtime: "codex", env: { SHARED: "from-spec", MEMBER_ONLY: "m" } });
    rigRepo.setRigEnv(rig.id, { RIG_ONLY: "r" });
    return { rig, node };
  }

  it("starts the first pane with the one-off and takes it back out of the session afterwards", async () => {
    const { rig } = seed();
    const result = await launcher().launchNode(rig.id, "dev1-impl", { env: { ONLY_THIS_LAUNCH: "debug", SHARED: "one-off-wins" } });
    expect(result.ok).toBe(true);
    expect(created).toMatchObject({ ONLY_THIS_LAUNCH: "debug", SHARED: "one-off-wins", MEMBER_ONLY: "m", RIG_ONLY: "r" });
    expect(created!["OPENRIG_SEAT_ENV_KEYS"]!.split(",").sort()).toEqual(["MEMBER_ONLY", "ONLY_THIS_LAUNCH", "RIG_ONLY", "SHARED"]);
    expect(calls).toEqual(["create", "unset ONLY_THIS_LAUNCH", "set SHARED=from-spec"]);
  });

  it("puts back the value OpenRig itself set for a name the one-off overrode (HOME), not the server's", async () => {
    const { rig } = seed();
    const result = await launcher().launchNode(rig.id, "dev1-impl", { env: { HOME: "/somewhere-else" } });
    expect(result.ok).toBe(true);
    expect(created).toMatchObject({ HOME: "/somewhere-else" });
    expect(calls).toEqual(["create", "set HOME=/openrig-home"]);
  });

  it("leaves the names tmux sets for itself alone", async () => {
    const { rig } = seed();
    const result = await launcher().launchNode(rig.id, "dev1-impl", { env: { TMUX: "x", TMUX_PANE: "%9", KEEP: "1" } });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["create", "unset KEEP"]);
  });

  it("a launch with no one-off touches no session environment: main's launch", async () => {
    const { rig } = seed();
    expect((await launcher().launchNode(rig.id, "dev1-impl")).ok).toBe(true);
    expect(calls).toEqual(["create"]);
  });

  it("a seat that was launched without a one-off still launches with its spec env", async () => {
    const { rig } = seed();
    expect((await launcher().launchNode(rig.id, "dev1-impl", { env: {} })).ok).toBe(true);
    expect(created).toMatchObject({ SHARED: "from-spec", MEMBER_ONLY: "m", RIG_ONLY: "r" });
    expect(calls).toEqual(["create"]);
  });

  it("when a one-off can't be taken out of the session, the seat keeps running and a warning names it, never its value", async () => {
    const { rig } = seed();
    failOn = (call) => call.startsWith("set SHARED=");
    const result = await launcher().launchNode(rig.id, "dev1-impl", { env: { SHARED: "one-off-secret", ONLY_THIS_LAUNCH: "debug-secret" } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the launch to stand");
    expect(killSession).not.toHaveBeenCalled();
    expect(calls).toContain("unset ONLY_THIS_LAUNCH");
    const warnings = (result.warnings ?? []).filter((w) => w.includes("--env setting"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("SHARED");
    expect(warnings[0]).toMatch(/handover successor/);
    expect(warnings[0]).toContain("-u SHARED");
    for (const value of ["one-off-secret", "debug-secret", "from-spec", "tmux set-environment failed"]) expect(warnings[0]).not.toContain(value);
    expect(new SessionRegistry(db).getSessionsForRig(rig.id)).toHaveLength(1);
    expect(rigRepo.getRig(rig.id)!.nodes[0]!.binding).not.toBeNull();
  });

  it("tries every one-off name and warns once for each that stays", async () => {
    const { rig } = seed();
    failOn = (call) => call.startsWith("set SHARED=") || call === "unset ONLY_THIS_LAUNCH";
    const result = await launcher().launchNode(rig.id, "dev1-impl", { env: { SHARED: "one-off-secret", ONLY_THIS_LAUNCH: "debug-secret" } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the launch to stand");
    const warnings = (result.warnings ?? []).filter((w) => w.includes("--env setting"));
    expect(warnings.map((w) => w.match(/--env setting (\S+)/)![1]).sort()).toEqual(["ONLY_THIS_LAUNCH", "SHARED"]);
    expect(killSession).not.toHaveBeenCalled();
  });

  it("a launch whose session could not be created removes nothing", async () => {
    const { rig } = seed();
    const tmux = { createSession: async () => ({ ok: false as const, code: "duplicate_session", message: "exists" }), killSession } as unknown as TmuxAdapter;
    const result = await new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter: tmux, sessionEnv: { OPENRIG_HOME: "/home" } })
      .launchNode(rig.id, "dev1-impl", { env: { ONLY_THIS_LAUNCH: "x" } });
    expect(result).toMatchObject({ ok: false, code: "duplicate_session" });
    expect(killSession).not.toHaveBeenCalled();
  });
});
