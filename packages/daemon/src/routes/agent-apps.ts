// Community agent apps: the installed presets, usable or not, so a person or an agent can see which apps can run in a
// seat, who maintains each, and what each declares it can't do.
//   GET /api/agent-apps — every preset under $OPENRIG_HOME/agent-apps
import { basename } from "node:path";
import { Hono } from "hono";
import { agentAppsDir, listAgentAppPresets } from "../domain/agent-app-presets.js";

export function agentAppsRoutes(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json({
    dir: agentAppsDir(),
    apps: listAgentAppPresets().map(found => found.ok
      ? { name: found.preset.name, usable: true, community: true, testedByOpenRig: false, maintainer: found.preset.maintainer,
        limits: found.preset.limits, command: found.preset.command, path: found.preset.path }
      : { name: basename(found.path, ".yaml"), usable: false, path: found.path, problem: found.message }),
  }));
  return app;
}
