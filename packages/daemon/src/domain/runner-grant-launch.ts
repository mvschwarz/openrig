import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { shellQuote } from "../adapters/shell-quote.js";
import type { NodeBinding } from "./runtime-adapter.js";
import { ActivityGrantStore } from "./activity-grants.js";
import { SessionRegistry } from "./session-registry.js";
import { prepareWindowsLaunch, powershellQuote } from "../adapters/windows-launch.js";
import { daemonTmuxAttachCommand, daemonTmuxServerArgs } from "../adapters/tmux-server.js";
import { bindNativeSessionName } from "./terminal/native-session-name.js";

export interface RunnerGrantLaunch {
  readonly grantId: string;
  readonly generation: string;
  wrap(command: string): string;
  dispatched(): void;
  finish(ok: boolean): Promise<void>;
}
export type RunnerGrantIssuer = (binding: NodeBinding, runtime: string, runId: string, runner: number) => Promise<RunnerGrantLaunch>;

/** Shared by actual Pi/community launch owners. The token crosses only tmux's private environment channel;
 * the typed command carries an unpredictable environment KEY, never its value. The runner's shell consumes and
 * removes that key before exec. Neither a failed await nor a later readiness result may revoke a successor. */
export function runnerGrantIssuer(db: Database.Database, tmux: Pick<TmuxAdapter, "getPanePid" | "setSessionEnv" | "unsetSessionEnv">,
  options: { platform?: NodeJS.Platform; terminalCommand?: readonly string[]; serverArgs?: readonly string[] } = {}): RunnerGrantIssuer {
  return async (binding, runtime, runId, runner) => {
    const session = binding.tmuxSession, pane = binding.tmuxPane;
    if (!session || !pane) throw new Error("Runner authority needs a concrete launch pane.");
    // sendShellCommand stages the payload through /bin/sh for non-POSIX pane shells too.
    // The private bootstrap itself names /bin/sh; it must not narrow the existing parent-shell support.
    const panePid = await tmux.getPanePid(pane);
    if (!panePid) throw new Error("Runner authority needs a concrete launch process.");
    const registry = new SessionRegistry(db), grants = new ActivityGrantStore(db);
    const predecessorGeneration = registry.currentOccupantTenure(binding.nodeId)?.generationUuid;
    const generation = binding.launchGeneration ?? predecessorGeneration;
    if (!generation) throw new Error("Runner authority needs the reserved launch generation.");
    const row = db.prepare("SELECT id FROM sessions WHERE node_id=? AND session_name=? ORDER BY id DESC LIMIT 1")
      .get(binding.nodeId, session) as { id: string } | undefined;
    // An explicitly staged successor has no managed row until cutover.
    const grant = grants.issue({ nodeId: binding.nodeId, generation, issuedBy: "runner-launch",
      run: { runId, ...(registry.currentOccupantTenure(binding.nodeId)?.generationUuid === generation && row ? { sessionId: row.id } : {}),
        binding: { runtime, runner, pane, panePid } } });
    const key = `OPENRIG_RUN_GRANT_${grant.grantId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
    try { await tmux.setSessionEnv(session, key, grant.token); }
    catch {
      try { grants.revoke({ grantId: grant.grantId }, "credential_distribution_failed"); }
      finally {
        try { await tmux.unsetSessionEnv(session, key); } catch { /* private write may have succeeded before failing */ }
      }
      throw new Error("Runner credential distribution failed; no runner started.");
    }
    return {
      grantId: grant.grantId,
      generation: grant.generation,
      wrap(command) {
        if ((options.platform ?? process.platform) === "win32") {
          const physical = bindNativeSessionName(session).physical;
          const terminal = [...(options.terminalCommand ?? daemonTmuxAttachCommand()), ...(options.serverArgs ?? daemonTmuxServerArgs()), "-t", "=" + physical];
          const invoke = (args: string[]) => "& " + [...terminal, ...args].map(powershellQuote).join(" ");
          const read = invoke(["show-environment", "-t", "=" + physical + ":", key]);
          const remove = invoke(["set-environment", "-t", "=" + physical + ":", "-r", key]);
          // Only the private environment KEY appears in the command; the token
          // stays in psmux's selected session and the child's environment block.
          const step = `$openrigStart.EnvironmentVariables.Remove('OPENRIG_RUN_ID')\n`
            + `$openrigGrant=@(${read} 2>$null)\n$openrigGrantRead=$LASTEXITCODE\n`
            + `${remove} 2>$null\n$openrigGrantRemoved=$LASTEXITCODE\n`
            + `if($openrigGrantRead -eq 0 -and $openrigGrantRemoved -eq 0 -and $openrigGrant.Count -eq 1 -and ([string]$openrigGrant[0]).StartsWith(${powershellQuote(key + "=oag_")})){\n`
            + `$openrigStart.EnvironmentVariables['OPENRIG_ACTIVITY_HOOK_TOKEN']=([string]$openrigGrant[0]).Substring(${key.length + 1})\n`
            + `$openrigStart.EnvironmentVariables['OPENRIG_RUN_ID']=${powershellQuote(runId)}\n`
            + `$openrigStart.EnvironmentVariables['OPENRIG_OCCUPANT_GENERATION']=${powershellQuote(grant.generation)}\n`
            + `}else{[Console]::Error.WriteLine('Run-bound reporting unavailable; using existing install-token reporting.')}\nRemove-Variable openrigGrant\n`;
          return prepareWindowsLaunch(command, step);
        }
        const target = shellQuote(`=${session}`);
        // No eval: token text is treated only as data. Disable tracing before reading the private value.
        const script = `set +x; unset OPENRIG_RUN_ID; if _openrig_grant=$(tmux show-environment -t ${target} ${key} 2>/dev/null) && `
          + `case "$_openrig_grant" in ${key}=oag_*) true;; *) false;; esac && tmux set-environment -t ${target} -r ${key} 2>/dev/null; then `
          + `OPENRIG_ACTIVITY_HOOK_TOKEN=\${_openrig_grant#*=}; OPENRIG_RUN_ID=${shellQuote(runId)}; OPENRIG_OCCUPANT_GENERATION=${shellQuote(grant.generation)}; `
          + `export OPENRIG_ACTIVITY_HOOK_TOKEN OPENRIG_RUN_ID OPENRIG_OCCUPANT_GENERATION; `
          + `else tmux set-environment -t ${target} -r ${key} 2>/dev/null || :; printf '%s\\n' 'Run-bound reporting unavailable; using existing install-token reporting.' >&2; fi; `
          + `unset _openrig_grant; exec ${command}`;
        return `/bin/sh -c ${shellQuote(script)}`;
      },
      dispatched() {
        const currentGeneration = registry.currentOccupantTenure(binding.nodeId)?.generationUuid;
        if (currentGeneration !== predecessorGeneration && currentGeneration !== generation) {
          throw new Error("Runner launch selection changed during dispatch; authority was refused.");
        }
        if (!grants.activate(grant.grantId) && registry.isOccupantGenerationRegistered(binding.nodeId, generation)) {
          throw new Error("Runner launch binding changed during dispatch; authority was refused.");
        }
      },
      async finish(ok) {
        // A staged readiness result can arrive after another cutover. It owns only this issued grant.
        try {
          const currentGeneration = ok ? registry.currentOccupantTenure(binding.nodeId)?.generationUuid : undefined;
          if (!ok || (currentGeneration !== predecessorGeneration && currentGeneration !== generation)) {
            grants.revoke({ grantId: grant.grantId }, "launch_failed_or_uncertain");
          }
        } finally {
          // Also retry cleanup when the launch shell continued without the private value.
          try { await tmux.unsetSessionEnv(session, key); } catch { /* optional cleanup cannot undo dispatch */ }
        }
      },
    };
  };
}
