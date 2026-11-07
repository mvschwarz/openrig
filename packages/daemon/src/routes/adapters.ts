import { Hono } from "hono";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { CmuxAdapter } from "../adapters/cmux.js";
import { daemonTmuxControlStatus } from "../adapters/tmux-server.js";

export const adaptersRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
    cmuxAdapter: c.get("cmuxAdapter" as never) as CmuxAdapter,
  };
}

// GET /api/adapters/tmux/sessions
adaptersRoutes.get("/tmux/sessions", async (c) => {
  const { tmuxAdapter } = getDeps(c);
  const sessions = await tmuxAdapter.listSessions();
  return c.json(sessions);
});

// GET /api/adapters/tmux/control — whether OPENRIG_TMUX_CONTROL=1 asked for control mode, and what the daemon's tmux
// server's version allows: read from memory, no tmux call (`rig doctor`)
adaptersRoutes.get("/tmux/control", (c) => c.json(daemonTmuxControlStatus()));

// GET /api/adapters/cmux/status — live control probe on every request
adaptersRoutes.get("/cmux/status", async (c) => {
  const { cmuxAdapter } = getDeps(c);
  await cmuxAdapter.connect();
  return c.json(cmuxAdapter.getStatus());
});
