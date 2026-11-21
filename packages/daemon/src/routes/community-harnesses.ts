// Community harnesses: the installed presets, usable or not, so a person or an agent can see which apps can run in a
// seat, who maintains each, and what each declares it can't do.
//   GET /api/community-harnesses — every preset under $OPENRIG_HOME/community-harnesses
import { basename } from "node:path";
import { Hono } from "hono";
import { communityHarnessesDir, listCommunityHarnessPresets } from "../domain/community-harness-presets.js";
import { launchExecutable } from "../domain/seat-launch-environment.js";

/** Only resolve literal executable words. Expansion and a seat's cwd belong to its shell. */
function executablePreflight(command: string): { executable?: string; executableProblem?: string } {
  const match = /^(?:'([^']+)'|"([^"\\$`]+)"|([^\s'"\\$`~]+))(?=\s|$)/.exec(command.trim());
  const program = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!program || (program.includes("/") && !program.startsWith("/"))) {
    return { executableProblem: "Executable depends on the seat's shell or working directory." };
  }
  try {
    return { executable: launchExecutable(program, process.env.PATH ?? "", process.cwd()) };
  } catch {
    return { executableProblem: "Executable was not found in the daemon's PATH." };
  }
}

export function communityHarnessesRoutes(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.json({
    dir: communityHarnessesDir(),
    harnesses: listCommunityHarnessPresets().map(found => found.ok
      ? { name: found.preset.name, usable: true, community: true, testedByOpenRig: false, maintainer: found.preset.maintainer,
        limits: found.preset.limits, command: found.preset.command, path: found.preset.path,
        ...(c.req.query("preflight") === "true" ? executablePreflight(found.preset.command) : {}) }
      : { name: basename(found.path, ".yaml"), usable: false, path: found.path, problem: found.message }),
  }));
  return app;
}
