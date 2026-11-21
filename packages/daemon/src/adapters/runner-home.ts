import { homedir } from "node:os";
import { join } from "node:path";
import { readPlatformEnv } from "../domain/platform-env.js";

/** Standalone runners cannot assume the POSIX HOME variable is present. */
export function resolveRunnerHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const configured = readPlatformEnv(env, "OPENRIG_HOME", platform)?.trim();
  if (configured) return configured;
  const home = readPlatformEnv(env, "HOME", platform)?.trim()
    || (platform === "win32" ? readPlatformEnv(env, "USERPROFILE", platform)?.trim() : undefined)
    || homedir();
  return join(home, ".openrig");
}
