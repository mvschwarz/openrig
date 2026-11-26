// Community harnesses: the installed presets, usable or not, so a person or an agent can see which apps can run in a
// seat, who maintains each, and what each declares it can't do.
//   GET /api/community-harnesses — every preset under $OPENRIG_HOME/community-harnesses
import { statSync } from "node:fs";
import { basename, win32 } from "node:path";
import { Hono } from "hono";
import { communityHarnessesDir, listCommunityHarnessPresets } from "../domain/community-harness-presets.js";
import { parseLiteralLaunchWords } from "../adapters/windows-launch.js";
import { readPlatformEnv } from "../domain/platform-env.js";
import { windowsCommunityCommand } from "../domain/windows-community-command.js";

export function communityHarnessesRoutes(): Hono {
  const app = new Hono();
  app.get("/", (c) => {
    const nativePreflight = c.req.query("preflight") === "true" && process.platform === "win32";
    return c.json({
      dir: communityHarnessesDir(),
      harnesses: listCommunityHarnessPresets().map(found => {
        if (!found.ok) return { name: basename(found.path, ".yaml"), usable: false, path: found.path, problem: found.message };
        const { name, maintainer, limits, command, path } = found.preset;
        const details = { name, community: true, testedByOpenRig: false, maintainer, limits, command, path };
        if (!nativePreflight) return { ...details, usable: true };
        try {
          const [executable] = windowsCommunityCommand(parseLiteralLaunchWords(command),
            readPlatformEnv(process.env, "PATH") ?? "", readPlatformEnv(process.env, "PATHEXT"), process.cwd());
          if (!executable || !win32.isAbsolute(executable) || !statSync(executable, { throwIfNoEntry: false })?.isFile()) {
            return { ...details, usable: false, problem: "Executable could not be resolved in the daemon's Windows launch environment." };
          }
          return { ...details, usable: true, executable };
        } catch (error) {
          return { ...details, usable: false, problem: error instanceof Error ? error.message : String(error) };
        }
      }),
    });
  });
  return app;
}
