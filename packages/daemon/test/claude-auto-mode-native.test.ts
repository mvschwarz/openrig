import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import type { ClaudeAutoMode } from "../src/domain/claude-auto-mode.js";

// Opt-in: OPENRIG_REAL_CLAUDE_BIN=/path/to/claude. The hermetic setup puts a stub `claude` first on PATH, so the
// real binary is named explicitly. `auto-mode config` reads settings only: no login, no model call, no verdict.
// Managed settings on the machine also apply and can add entries.
const claude = process.env["OPENRIG_REAL_CLAUDE_BIN"];
type Lists = Record<"environment" | "allow" | "soft_deny" | "hard_deny", string[]>;

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function configHome(user?: { autoMode: ClaudeAutoMode }): string {
  const home = mkdtempSync(join(tmpdir(), "claude-auto-mode-")); homes.push(home);
  if (user) writeFileSync(join(home, "settings.json"), JSON.stringify(user));
  return home;
}

function run(home: string, args: string[]): Lists {
  return JSON.parse(execFileSync(claude!, args, { env: { ...process.env, CLAUDE_CONFIG_DIR: home }, encoding: "utf8", timeout: 60_000 })) as Lists;
}

/** The classifier's lists for a seat launch composed exactly as OpenRig composes it. */
function effective(block: ClaudeAutoMode, home = configHome()): Lists {
  const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true, managedCompaction: true,
    claudePermissions: { allow: [], deny: ["Read(./private/**)"] }, claudeAutoMode: block });
  const settings = args[args.indexOf("--settings") + 1]!;
  expect(Object.keys(JSON.parse(settings))).toEqual(expect.arrayContaining(["permissions", "hooks", "idleCompaction", "autoMode"]));
  return run(home, ["--settings", settings, "auto-mode", "config"]);
}

describe.skipIf(!claude)("a seat's autoMode block reaches real Claude's classifier inputs", () => {
  const defaults = () => run(configHome(), ["auto-mode", "defaults"]);

  it("splices $defaults and adds the seat's entries", () => {
    const built = defaults();
    const lists = effective({ environment: ["$defaults", "OPENRIG-PROBE env"], soft_deny: ["$defaults", "OPENRIG-PROBE soft"] });
    expect(lists.environment).toEqual(expect.arrayContaining([...built.environment, "OPENRIG-PROBE env"]));
    expect(lists.soft_deny).toEqual(expect.arrayContaining([...built.soft_deny, "OPENRIG-PROBE soft"]));
    expect(lists.allow).toEqual(built.allow);
  }, 120_000);

  it("drops a section's built-ins when no scope keeps $defaults, and an empty list changes nothing", () => {
    const built = defaults();
    const lists = effective({ soft_deny: ["OPENRIG-PROBE only"], hard_deny: [] });
    expect(lists.soft_deny).toEqual(["OPENRIG-PROBE only"]);
    expect(lists.hard_deny).toEqual(built.hard_deny);
  }, 120_000);

  it("adds to user settings: the seat's $defaults restores built-ins a user list left out, and can't remove user entries", () => {
    const built = defaults();
    const home = configHome({ autoMode: { environment: ["OPENRIG-PROBE user env"], soft_deny: ["$defaults", "OPENRIG-PROBE user soft"] } });
    expect(run(home, ["auto-mode", "config"]).environment).toEqual(["OPENRIG-PROBE user env"]);
    const lists = effective({ environment: ["$defaults"], soft_deny: ["OPENRIG-PROBE seat soft"] }, home);
    expect(lists.environment).toEqual(expect.arrayContaining([...built.environment, "OPENRIG-PROBE user env"]));
    expect(lists.soft_deny).toEqual(expect.arrayContaining([...built.soft_deny, "OPENRIG-PROBE user soft", "OPENRIG-PROBE seat soft"]));
  }, 120_000);
});
