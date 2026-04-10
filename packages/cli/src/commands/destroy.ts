import { Command } from "commander";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../config-store.js";
import { realDeps } from "./daemon.js";
import { getDefaultOpenRigPath, getPreferredOpenRigHome, readOpenRigEnv } from "../openrig-compat.js";
import {
  DESTROY_CONFIRM_TOKEN,
  buildDestroyPlan,
  executeDestroy,
  findListeningPidWithLsof,
  killTmuxSessionWithCli,
  listManagedTmuxSessionsFromDb,
  type DestroyDeps,
  type ListenerInspection,
  type DestroyRuntimeConfig,
  type DestroyScope,
} from "../destroy-helpers.js";
import { stopDaemon } from "../daemon-lifecycle.js";

export interface DestroyCommandDeps {
  configStore: Pick<ConfigStore, "resolve">;
  destroyDeps: DestroyDeps;
}

interface ResolvedDestroyRuntime {
  runtimeConfig: DestroyRuntimeConfig;
  warnings: string[];
}

function resolveRuntimeConfig(configStore: Pick<ConfigStore, "resolve">): ResolvedDestroyRuntime {
  const warnings: string[] = [];
  const stateRoot = getPreferredOpenRigHome();
  const defaultDbPath = getDefaultOpenRigPath("openrig.sqlite");
  const defaultTranscriptsPath = getDefaultOpenRigPath("transcripts");
  const effectiveDefaultDbPath = join(stateRoot, "openrig.sqlite");
  const effectiveDefaultTranscriptsPath = join(stateRoot, "transcripts");
  const overrideUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL")?.trim();
  if (overrideUrl) {
    warnings.push(`Ignoring ${overrideUrl} from OPENRIG_URL/RIGGED_URL because rig destroy only operates on local state.`);
  }

  try {
    const config = configStore.resolve();
    return {
      runtimeConfig: {
        stateRoot,
        dbPath: config.db.path === defaultDbPath ? effectiveDefaultDbPath : config.db.path,
        transcriptsPath: config.transcripts.path === defaultTranscriptsPath ? effectiveDefaultTranscriptsPath : config.transcripts.path,
        daemonHost: config.daemon.host,
        daemonPort: config.daemon.port,
      },
      warnings,
    };
  } catch (err) {
    warnings.push(`Failed to read config; using compatibility defaults instead: ${err instanceof Error ? err.message : String(err)}`);
    return {
      runtimeConfig: {
        stateRoot,
        dbPath: effectiveDefaultDbPath,
        transcriptsPath: effectiveDefaultTranscriptsPath,
        daemonHost: "127.0.0.1",
        daemonPort: 7433,
      },
      warnings,
    };
  }
}

function realDestroyDeps(): DestroyDeps {
  const lifecycleDeps = realDeps();
  return {
    stopDaemon: async () => stopDaemon(lifecycleDeps),
    inspectListener: async (host: string, port: number): Promise<ListenerInspection> => {
      try {
        const res = await fetch(`http://${host}:${port}/healthz`);
        if (!res.ok) {
          return {
            kind: "other_http",
            healthy: false,
            detail: `HTTP ${res.status}`,
          };
        }

        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          return {
            kind: "other_http",
            healthy: false,
            detail: "Response body was not valid OpenRig health JSON.",
          };
        }

        if (body && typeof body === "object" && (body as Record<string, unknown>).status === "ok") {
          return { kind: "openrig", healthy: true };
        }

        return {
          kind: "other_http",
          healthy: false,
          detail: "Response body did not match the OpenRig health contract.",
        };
      } catch {
        return { kind: "unreachable" };
      }
    },
    findListeningPid: findListeningPidWithLsof,
    killProcess: (pid: number) => {
      process.kill(pid, "SIGTERM");
    },
    exists: existsSync,
    renamePath: (from: string, to: string) => renameSync(from, to),
    removePath: (targetPath: string) => rmSync(targetPath, { recursive: true, force: true }),
    mkdirp: (targetPath: string) => mkdirSync(targetPath, { recursive: true }),
    listManagedTmuxSessions: listManagedTmuxSessionsFromDb,
    killTmuxSession: killTmuxSessionWithCli,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  };
}

function printPlan(
  scope: DestroyScope,
  backup: boolean,
  runtimeConfig: DestroyRuntimeConfig,
  managedTmuxSessions: string[],
  warnings: string[]
): void {
  console.log("DESTROY PLAN");
  console.log(`  scope: ${scope}`);
  console.log(`  state root: ${runtimeConfig.stateRoot}`);
  console.log(`  daemon: http://${runtimeConfig.daemonHost}:${runtimeConfig.daemonPort}`);
  console.log(`  backup: ${backup ? "enabled" : "disabled"}`);
  console.log(`  tmux cleanup: ${scope === "all" ? `enabled (${managedTmuxSessions.length} managed session${managedTmuxSessions.length === 1 ? "" : "s"})` : "disabled"}`);
  for (const warning of warnings) {
    console.log(`  warning: ${warning}`);
  }
  console.log("");
}

function printResult(result: Awaited<ReturnType<typeof executeDestroy>>): void {
  console.log("DESTROY RESULT");
  console.log(`  daemon: ${result.daemonStopped ? "stopped" : "still responding"}`);
  console.log(`  port: ${result.portCleared ? "cleared" : "still occupied"}`);
  if (result.scope === "all") {
    console.log(`  tmux sessions removed: ${result.tmuxKilled}`);
    if (result.tmuxMissing > 0) {
      console.log(`  tmux sessions missing/already gone: ${result.tmuxMissing}`);
    }
  }
  if (result.backupPaths.length > 0) {
    for (const backupPath of result.backupPaths) {
      console.log(`  backup: ${backupPath}`);
    }
  } else if (result.backup) {
    console.log("  backup: nothing to move");
  }
  console.log(result.stateRecreated ? `  fresh state root: ${result.stateRoot}` : "  fresh state root: not created (state left untouched)");
  for (const warning of result.warnings) {
    console.log(`  warning: ${warning}`);
  }
}

export function destroyCommand(depsOverride?: DestroyCommandDeps): Command {
  const cmd = new Command("destroy").description("Destroy OpenRig local state for recovery");

  cmd
    .option("--state", "Destroy OpenRig state and recreate an empty state root")
    .option("--all", "Destroy OpenRig state and remove managed tmux sessions")
    .option("--backup", "Move state aside instead of deleting it")
    .option("--yes", "Confirm the destructive operation")
    .option("--confirm <token>", `Exact confirmation token: ${DESTROY_CONFIRM_TOKEN}`)
    .action(async (opts: { state?: boolean; all?: boolean; backup?: boolean; yes?: boolean; confirm?: string }) => {
      const selectedScopes = [opts.state ? "state" : null, opts.all ? "all" : null].filter(Boolean) as DestroyScope[];
      if (selectedScopes.length !== 1) {
        console.error("Specify exactly one destroy scope: --state or --all");
        process.exitCode = 1;
        return;
      }
      if (!opts.yes) {
        console.error("Destroy requires --yes");
        process.exitCode = 1;
        return;
      }
      if (opts.confirm !== DESTROY_CONFIRM_TOKEN) {
        console.error(`Destroy requires: --confirm ${DESTROY_CONFIRM_TOKEN}`);
        process.exitCode = 1;
        return;
      }

      const deps = depsOverride ?? {
        configStore: new ConfigStore(),
        destroyDeps: realDestroyDeps(),
      };

      const { runtimeConfig, warnings } = resolveRuntimeConfig(deps.configStore);
      const plan = buildDestroyPlan(selectedScopes[0]!, Boolean(opts.backup), runtimeConfig, deps.destroyDeps);
      printPlan(plan.scope, plan.backup, runtimeConfig, plan.managedTmuxSessions, [...warnings, ...plan.warnings]);
      plan.warnings = [...warnings, ...plan.warnings];
      const result = await executeDestroy(plan, deps.destroyDeps);
      printResult(result);
      if (!result.portCleared) {
        process.exitCode = 1;
      }
    });

  return cmd;
}
