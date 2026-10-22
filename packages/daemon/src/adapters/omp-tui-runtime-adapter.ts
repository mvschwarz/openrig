import net from "node:net";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { OMP_BRIDGE_PROTOCOL_VERSION, createBridgeFrameDecoder, ompBridgeSocketPath } from "./omp-bridge-protocol.js";
import { OmpRuntimeAdapter } from "./omp-runtime-adapter.js";
import type { RunnerUiMode } from "./pi-runner-protocol.js";

/** How long a proxied delivery waits for the runner's bridge acknowledgement. */
const BRIDGE_DELIVERY_TIMEOUT_MS = 3_000;

/** OMP's native TUI runs in the seat pane; OMP answers approvals in its own
 *  TUI, with no OpenRig auto-cancel. */
export class OmpTuiRuntimeAdapter extends OmpRuntimeAdapter {
  override readonly runtime = "omp-tui" as const;

  protected override get childRuntime(): "omp" { return "omp"; }
  protected override get uiMode(): RunnerUiMode { return "native"; }

  /** Deliver a Rig message into OMP's own conversation over the runner's
   *  bridge socket. The pane is OMP's TUI, so a message must never be typed
   *  into the pane. */
  async deliverMessage(sessionName: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const socketPath = ompBridgeSocketPath(nodePath.join(this.stateRoot, sessionName));
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "nothing to deliver" };
    // The pane-path convention survives: a "/followup <text>" prefix queues
    // after the running turn instead of steering it.
    const followUp = trimmed.startsWith("/followup ") ? trimmed.slice("/followup ".length).trim() : "";
    const id = randomUUID();
    const command = followUp
      ? { type: "follow_up", id, message: followUp }
      : { type: "prompt", id, message: trimmed };
    return await new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const socket = net.connect({ path: socketPath });
      const finish = (result: { ok: boolean; error?: string }): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        socket.end();
        resolve(result);
      };
      const decoder = createBridgeFrameDecoder((frame) => {
        if (frame.type !== "command_ack" || frame.id !== id) return;
        if (frame.success === true) finish({ ok: true });
        else finish({ ok: false, error: typeof frame.error === "string" ? frame.error : "bridge rejected command" });
      }, (error) => finish({ ok: false, error: error.message }));
      timer = setTimeout(() => finish({
        ok: false,
        error: `bridge did not acknowledge delivery within ${BRIDGE_DELIVERY_TIMEOUT_MS} ms`,
      }), BRIDGE_DELIVERY_TIMEOUT_MS);
      socket.once("connect", () => {
        socket.write(`${JSON.stringify({ role: "control", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION })}\n`);
        socket.write(`${JSON.stringify(command)}\n`);
      });
      socket.on("data", (chunk: Buffer) => decoder.push(chunk.toString("utf8")));
      socket.once("end", () => finish({ ok: false, error: "bridge control connection closed before acknowledgement" }));
      socket.once("close", () => {
        if (!settled) finish({ ok: false, error: "bridge control connection closed before acknowledgement" });
      });
      socket.once("error", (error: Error) => finish({ ok: false, error: error.message }));
    });
  }
}
