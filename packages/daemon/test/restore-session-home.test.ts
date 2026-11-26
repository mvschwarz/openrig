import { expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { SessionTransport } from "../src/domain/session-transport.js";
import { createFullTestDb } from "./helpers/test-app.js";

it.each(["owned-survivor", "dev-worker@renamed-rig"])("reads restore home from the current physical session for %s", async address => {
  const db = createFullTestDb();
  const selectedHome = path.join(os.tmpdir(), "owned-session-home-witness");
  try {
    db.prepare("INSERT INTO rigs (id, name) VALUES ('r', 'renamed-rig')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('n', 'r', 'dev.worker', 'claude-code', ?)").run(os.tmpdir());
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES ('s', 'n', 'owned-survivor', 'running', 'ready')").run();
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES ('b', 'n', 'owned-survivor')").run();
    const getSessionEnv = vi.fn(async (session: string) => session === "owned-survivor" ? selectedHome : undefined);
    type Deps = ConstructorParameters<typeof SessionTransport>[0];
    const transport = new SessionTransport({ db, rigRepo: {} as Deps["rigRepo"], sessionRegistry: {} as Deps["sessionRegistry"],
      tmuxAdapter: { getSessionEnv } as unknown as Deps["tmuxAdapter"] });
    expect(await transport.restoreUserHome(address)).toBe(selectedHome);
    expect(getSessionEnv.mock.calls).toEqual([["owned-survivor", process.platform === "win32" ? "USERPROFILE" : "HOME"]]);
  } finally { db.close(); }
});
