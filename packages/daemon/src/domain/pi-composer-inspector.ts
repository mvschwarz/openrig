import { randomUUID } from "node:crypto";
import type { PiRunnerState } from "../adapters/pi-runner-protocol.js";
import type { TmuxAdapter } from "../adapters/tmux.js";

export type PiComposerInput = {
  readonly sessionName: string;
  readonly target: string;
  readonly expected: string;
};
export type PiComposerInspection = "empty" | "matched" | "busy" | "unknown";
export type PiComposerInspector = (input: PiComposerInput) => Promise<PiComposerInspection>;

export function createPiComposerInspector(deps: {
  readonly readSidecar: (session: string) => PiRunnerState | null;
  readonly tmux: Pick<TmuxAdapter, "sendText">;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): PiComposerInspector {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  return async input => {
    const prior = deps.readSidecar(input.sessionName);
    if (prior?.inputInspection?.protocol !== 1 || !prior.ready || prior.exited) return "unknown";
    const probeId = randomUUID();
    const sentAt = now();
    const deadline = sentAt + 400;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"unknown">(resolve => {
      timer = setTimeout(() => { expired = true; resolve("unknown"); }, 400);
    });
    const inspect = async (): Promise<PiComposerInspection> => {
      // The Pi editor consumes this framed query without inserting it or pressing Enter.
      const sent = await deps.tmux.sendText(input.target,
        `/openrig-inspect ${probeId} ${Buffer.from(input.expected).toString("base64url")}`);
      if (!sent.ok) return "unknown";
      while (!expired && now() < deadline) {
        const state = deps.readSidecar(input.sessionName);
        if (state?.launchId !== prior.launchId || !state?.ready || state.exited) return "unknown";
        const result = state.inputInspection;
        if (result?.probeId === probeId && result.protocol === 1
          && Date.parse(result.updatedAt) >= sentAt && Date.parse(result.updatedAt) <= deadline) {
          switch (result.state) {
            case "empty": case "matched": case "busy": return result.state;
            default: return "unknown";
          }
        }
        await sleep(Math.min(10, deadline - now()));
      }
      return "unknown";
    };
    try {
      return await Promise.race([inspect(), timeout]);
    } finally {
      expired = true;
      clearTimeout(timer);
    }
  };
}
