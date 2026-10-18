import type { SessionProbe, TmuxAdapter, TmuxResult } from "../adapters/tmux.js";
import type { ForkSource, HarnessLaunchResult, NodeBinding, ReadinessResult, RuntimeAdapter } from "./runtime-adapter.js";
import type { SeatCreateRequest, SeatCreateResult, SeatHost, SeatRef } from "./seat-kinds.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";
import type { TranscriptStore } from "./transcript-store.js";
import { observeSolePane } from "./pane-binding-observation.js";
import { getTranscriptRotationOptionsFromEnv, startTranscriptRotation } from "./transcript-rotation.js";

/** The tmux seat host: a seat is a tmux session with one pane, and the runtime adapter starts
 *  the agent by typing into that pane. */
export class TmuxSeatHost implements SeatHost {
  constructor(private readonly deps: {
    tmuxAdapter: TmuxAdapter;
    transcriptStore?: TranscriptStore | null;
    tmuxOptionDefaults?: TmuxOptionDefaultsApplier | null;
  }) {}

  async create(req: SeatCreateRequest): Promise<SeatCreateResult> {
    const { tmuxAdapter, transcriptStore, tmuxOptionDefaults } = this.deps;
    const { sessionName } = req;
    const tmuxResult = await tmuxAdapter.createSession(sessionName, req.cwd, req.env);
    if (!tmuxResult.ok) {
      return { ok: false, code: tmuxResult.code, message: tmuxResult.message };
    }

    // A one-off `rig up --env` value is on the first pane's command line and, because that is how
    // `new-session -e` works, in the session environment, which a respawned pane (a handover
    // successor) inherits. The first pane has already started with it, so take it back out of the
    // session: the spec's or OpenRig's own value for a name they set, no value for the rest.
    if (req.oneOffEnv && req.oneOffEnv.names.length > 0) {
      const failed = await this.dropOneOffFromSession(sessionName, req.oneOffEnv.names, req.oneOffEnv.baseline);
      if (failed) {
        // The first pane has already started with the one-off, so this is a stopped launch, not an
        // undone one. Say whether the new session (the one this launch just created) is gone, and
        // never include tmux's text or a value.
        let removed = false;
        try { removed = (await tmuxAdapter.killSession(sessionName)).ok; } catch { /* not confirmed */ }
        return {
          ok: false,
          code: "seat_env_cleanup_failed",
          message: removed
            ? `Could not take the --env setting ${failed} out of the new session "${sessionName}" environment, so the launch was stopped and the session was removed. Run it again.`
            : `Could not take the --env setting ${failed} out of the new session "${sessionName}" environment, so the launch was stopped, and the session could not be confirmed removed. It may still hold the --env values in its terminal and environment and nothing is bound to it: check it and remove it before running this again.`,
        };
      }
    }

    // The session's own non-fatal warnings (#771: the parent-session identity cleanup).
    const warnings: string[] = [...(tmuxResult.warnings ?? [])];

    // Observe the pane before the DB transaction. A concrete pane is committed
    // with session+binding; an unresolved pane gets a durable named verdict in
    // that same transaction rather than carrying an unexplained NULL forward.
    const paneObservation = await observeSolePane(tmuxAdapter, sessionName);

    // OPR.0.4.6.02 S1 — apply the daemon's tmux option defaults to the
    // JUST-CREATED session via the shared applier (mouse/status session-scope
    // + set-clipboard/copy-command server-scope). Touches only this new
    // session, never an existing one (BR-1 never-retro). Option-set failures
    // come back as non-fatal launch warnings.
    if (tmuxOptionDefaults) {
      warnings.push(...(await tmuxOptionDefaults.applyToFreshSession(sessionName)));
    }

    // Start transcript rotation (V1 pre-release CLI/daemon Item 1:
    // bounded capture-pane overwrite replaces the unbounded pipe-pane
    // mechanism). Failures inside individual rotation ticks are silent
    // (best-effort); only the transcript directory not being writable
    // surfaces a launch warning.
    if (transcriptStore?.enabled) {
      const dirOk = transcriptStore.ensureTranscriptDir(req.rigName);
      if (dirOk) {
        const transcriptPath = transcriptStore.getTranscriptPath(req.rigName, sessionName);
        startTranscriptRotation(
          tmuxAdapter,
          sessionName,
          transcriptPath,
          getTranscriptRotationOptionsFromEnv(),
          getTranscriptRotationOptionsFromEnv,
        );
      } else {
        warnings.push(`Transcript directory creation failed for rig ${req.rigName}`);
      }
    }

    return {
      ok: true,
      binding: { tmuxSession: sessionName, ...(paneObservation.ok ? { tmuxPane: paneObservation.pane } : {}) },
      paneObservation,
      warnings,
    };
  }

  launch(binding: NodeBinding, adapter: RuntimeAdapter,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource }): Promise<HarnessLaunchResult> {
    return adapter.launchHarness(binding, opts);
  }

  checkReady(binding: NodeBinding, adapter: RuntimeAdapter): Promise<ReadinessResult> {
    return adapter.checkReady(binding);
  }

  probe(ref: SeatRef): Promise<SessionProbe> {
    return this.deps.tmuxAdapter.probeSession(ref.sessionName);
  }

  stop(ref: SeatRef): Promise<TmuxResult> {
    return this.deps.tmuxAdapter.killSession(ref.sessionName);
  }

  /**
   * Put each one-off name back to what the session would have had without it: `baseline` has the
   * value the spec or OpenRig set for it, and a name with none is unset (the server's own value, if
   * it has one, is what a later pane gets). `TMUX` and `TMUX_PANE` belong to tmux and are left alone.
   * Returns the name that could not be restored, or undefined when all were. The message built from
   * it carries no value: tmux errors repeat the command line.
   */
  private async dropOneOffFromSession(session: string, names: string[], baseline: Record<string, string>): Promise<string | undefined> {
    for (const name of names) {
      if (name === "TMUX" || name === "TMUX_PANE") continue;
      try {
        const value = baseline[name];
        if (value !== undefined) await this.deps.tmuxAdapter.setSessionEnv(session, name, value);
        else await this.deps.tmuxAdapter.unsetSessionEnv(session, name);
      } catch {
        return name;
      }
    }
    return undefined;
  }
}
