import { shellQuote } from "./shell-quote.js";

// #1077 — set only on the command OpenRig itself sends to resume a Claude seat, so the
// SessionStart hook of that process can say it is the launch the daemon armed. It is a
// command-scoped assignment, never exported into the pane shell: a Claude started by hand in
// the same pane does not carry it.
export const CLAUDE_RESUME_LAUNCH_ENV = "OPENRIG_RESUME_LAUNCH";

export function claudeResumeLaunchEnv(token: string): Record<string, string> {
  return { [CLAUDE_RESUME_LAUNCH_ENV]: token };
}

export function claudeResumeLaunchPrefix(token: string): string {
  return `${CLAUDE_RESUME_LAUNCH_ENV}=${shellQuote(token)} `;
}
