// Control-socket adapter — the "addressable-screen API" adopted by the Phase-0
// spike verdict. One command per line; every line gets a one-line JSON reply.
//
// STANDING ARCH CONSTRAINT (arch-lead post-spike-review; same class as the
// BR-9 ACTIONS guard — the socket is a NAMED boundary-erosion point):
//   1. Every socket command goes through the ONE resolver/mutation path
//      (parseCommand → dispatch). No programmatic shortcut may mutate state
//      outside it, ever.
//   2. Socket verbs stay OBSERVE / NAVIGATE / DRIVE-STRUCTURE only. No
//      ACT/PRODUCE verb lands here because the socket is an API. Any extension
//      crossing either line routes to arch-lead BEFORE building.
// The only non-grammar verb is "state" — a read-only state query (OBSERVE).
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseCommand } from "./grammar.js";
import { serializeCommands } from "./commands/registry.js";
import type { ViewState, ViewStateStore } from "./types.js";

/** macOS sun_path caps unix-socket paths at ~104 bytes; guard with margin. */
export const MAX_SOCKET_PATH_BYTES = 100;

export function describeState(state: ViewState) {
  return {
    ok: !state.lastError,
    screen: state.section,
    drill: state.drill.map((d) => `${d.kind}:${d.name}`),
    filter: state.filter || undefined,
    viewTab: state.viewTab,
    error: state.lastError ?? undefined,
  };
}

/** Default socket home follows the shipped OPENRIG_HOME convention
 * (openrig-compat: ~/.openrig), herdr-style env override on top. */
export function defaultSocketPath(instanceId: string): string {
  const override = process.env["OPENRIG_TUI_SOCKET"];
  if (override) return override;
  const home = process.env["OPENRIG_HOME"] ?? path.join(os.homedir(), ".openrig");
  return path.join(home, "run", `tui-${instanceId}.sock`);
}

export interface ControlSocket {
  path: string;
  close(): Promise<void>;
}

export async function createControlSocket(options: {
  socketPath: string;
  view: ViewStateStore;
  onMutation?: () => void;
  /** I5 — live command context supplier (from the C3 detector); default standard. */
  currentContext?: () => string;
}): Promise<ControlSocket> {
  const { socketPath, view, onMutation } = options;
  const currentContext = options.currentContext ?? (() => "standard");
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `socket path too long (${bytes} bytes; unix sun_path caps ~104): ${socketPath} — use a short runtime dir (default: $OPENRIG_HOME/run)`,
    );
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);

  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (d) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // REGISTRY I4 — the second OBSERVE verb: the registry projection with LIVE
        // per-session availability (one serializer, PM pin 2; context pin 3). Read-only —
        // stays inside the arch constraint's OBSERVE class beside "state".
        if (line === "commands") {
          conn.write(
            JSON.stringify({ ok: true, instanceId: view.instanceId, commands: serializeCommands(currentContext()) }) + "\n",
          );
          continue;
        }
        if (line === "state") {
          conn.write(
            JSON.stringify({ ok: true, instanceId: view.instanceId, state: describeState(view.get()) }) + "\n",
          );
          continue;
        }
        // The one mutation path: grammar → dispatch. Nothing else.
        const next = view.dispatch(parseCommand(line, view.get().sections));
        conn.write(JSON.stringify(describeState(next)) + "\n");
        onMutation?.();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve({
        path: socketPath,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => {
              if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
              res();
            });
          }),
      });
    });
  });
}
