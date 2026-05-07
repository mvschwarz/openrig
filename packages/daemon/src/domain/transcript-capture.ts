import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import {
  startTranscriptRotation,
  getTranscriptRotationOptionsFromEnv,
} from "./transcript-rotation.js";

export async function startTmuxTranscriptCapture(
  tmuxAdapter: TmuxAdapter | null | undefined,
  transcriptStore: TranscriptStore | null | undefined,
  rigName: string,
  sessionName: string,
): Promise<{ started: boolean; reason?: string }> {
  if (!tmuxAdapter || !transcriptStore?.enabled) {
    return { started: false, reason: "transcript_capture_unavailable" };
  }

  if (!transcriptStore.ensureTranscriptDir(rigName)) {
    return { started: false, reason: "transcript_dir_unavailable" };
  }

  const transcriptPath = transcriptStore.getTranscriptPath(rigName, sessionName);
  // V1 pre-release CLI/daemon Item 1: bounded-trail rotation replaces
  // the pipe-pane infinite-growth file. Defaults from env vars + 1000
  // line / 2s baseline; failure inside rotation is best-effort silent
  // and never blocks launch (the prior pipe-pane site treated failure
  // as launch-warning, not launch-blocker, so behavior stays).
  startTranscriptRotation(
    tmuxAdapter,
    sessionName,
    transcriptPath,
    getTranscriptRotationOptionsFromEnv(),
  );
  return { started: true };
}
