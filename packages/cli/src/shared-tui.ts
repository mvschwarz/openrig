import { DaemonClient } from "./client.js";
import { assertLocalTmux, attachTmux, readTmuxServerArgs, type TmuxAttachment } from "./tmux-attachment.js";

interface SharedTuiClient {
  readonly baseUrl?: string;
  isLocalInstance(): Promise<boolean>;
  get<T>(path: string): Promise<{ status: number; data: T }>;
}

/** Resolve the terminal on the selected instance, not a remembered tmux name. */
export async function sharedTuiTarget(client: SharedTuiClient = new DaemonClient()): Promise<TmuxAttachment> {
  await assertLocalTmux(client, "Shared attachment uses local tmux. The selected daemon's instance identity could not be confirmed locally; run rig tui --shared on that daemon's machine. Standalone rig tui can use this remote connection.");
  const rigs = await client.get<Array<{ rigId: string; rigName?: string; name?: string }>>("/api/ps");
  if (rigs.status >= 400) throw new Error(`Cannot read rigs (HTTP ${rigs.status}); run rig status.`);
  const kernels = rigs.data.filter((r) => (r.rigName ?? r.name) === "kernel");
  if (kernels.length > 1) throw new Error("Multiple kernels are registered. Inspect rig ps and reconcile the intended binding before shared attachment.");
  const kernel = kernels[0];
  if (!kernel) throw new Error("No kernel is registered on this instance. Run rig status; complete runtime authentication before starting the daemon. Standalone: rig tui.");
  const nodes = await client.get<Array<{
    logicalId: string; runtime: string | null;
    canonicalSessionName: string | null; tmuxAttachCommand: string | null;
    tmuxServerArgs?: string[];
  }>>(`/api/rigs/${encodeURIComponent(kernel.rigId)}/nodes`);
  if (nodes.status >= 400) throw new Error(`Cannot read kernel terminals (HTTP ${nodes.status}); run rig status.`);
  const terminal = nodes.data.find((n) => n.logicalId === "operator.human" && n.runtime === "terminal");
  if (!terminal?.canonicalSessionName || !terminal.tmuxAttachCommand) {
    throw new Error("The kernel has no bound shared terminal. Inspect rig ps --nodes --rig kernel; restore the existing terminal rather than launching another kernel. Standalone: rig tui.");
  }
  return { session: terminal.canonicalSessionName, serverArgs: readTmuxServerArgs(terminal.tmuxServerArgs) };
}

export async function attachSharedTui(target: TmuxAttachment): Promise<number> {
  return attachTmux(target);
}
