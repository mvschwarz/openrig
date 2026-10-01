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
import { randomUUID } from "node:crypto";
import { parseCommand } from "./grammar.js";
import { serializeCommands } from "./commands/registry.js";
import type { ViewState, ViewStateStore } from "./types.js";

/** macOS sun_path caps unix-socket paths at ~104 bytes; guard with margin. */
export const MAX_SOCKET_PATH_BYTES = 100;

export function describeState(state: ViewState) {
  const named = new Map(state.drill.map((item) => [item.kind, item.name]));
  const mission = state.scopesSelected?.mission ?? state.scopesMission ?? undefined;
  const slice = state.scopesSelected?.slice
    ?? (state.executionOpen?.startsWith("slice:") ? state.executionOpen.slice("slice:".length) : undefined);
  const parts = [
    `instance:${state.instanceId}`,
    `section:${state.section}`,
    ...state.drill.map((item) => `${item.kind}:${item.name}`),
    ...(mission ? [`mission:${mission}`] : []),
    ...(slice ? [`slice:${slice}`] : []),
  ];
  return {
    ok: !state.lastError,
    screen: state.section,
    drill: state.drill.map((d) => `${d.kind}:${d.name}`),
    filter: state.filter || undefined,
    viewTab: state.viewTab,
    timeZone: state.timeZone,
    timeZoneWarning: state.timeZoneWarning,
    timeZoneHelp: state.timeZoneHelp,
    recentEvent: state.recentOpen ?? undefined,
    address: {
      instance: state.instanceId,
      section: state.section,
      ...(named.get("host") ? { host: named.get("host") } : {}),
      ...(named.get("rig") ? { rig: named.get("rig") } : {}),
      ...(named.get("pod") ? { pod: named.get("pod") } : {}),
      ...(named.get("agent") ? { agent: named.get("agent") } : {}),
      ...(named.get("spec") ? { spec: named.get("spec") } : {}),
      ...(mission ? { mission } : {}),
      ...(slice ? { slice } : {}),
      path: parts.join("/"),
    },
    copyMode: state.copyMode,
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

interface ControlSocketOptions {
  socketPath: string;
  view: ViewStateStore;
  onMutation?: () => void;
  /** I5 — live command context supplier (from the C3 detector); default standard. */
  currentContext?: () => string;
  /** Standalone terminals can use an independent endpoint on a collision. */
  fallbackOnCollision?: boolean;
}

export async function createControlSocket(options: ControlSocketOptions): Promise<ControlSocket> {
  try {
    return await createReservedControlSocket(options);
  } catch (error) {
    if (!options.fallbackOnCollision || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    const directory = path.dirname(options.socketPath);
    const suffix = `-${process.pid}-${randomUUID().slice(0, 8)}.sock`;
    const budget = MAX_SOCKET_PATH_BYTES - Buffer.byteLength(directory + path.sep + suffix);
    if (budget < 0) {
      throw new Error(`socket runtime directory is too long for an independent control endpoint: ${directory} — use a shorter $OPENRIG_HOME/run or --socket path`);
    }
    const stem = Array.from(path.basename(options.socketPath, ".sock"));
    while (Buffer.byteLength(stem.join("")) > budget) stem.pop();
    const alternate = path.join(directory, stem.join("") + suffix);
    // Use ordinary exclusive bind/recovery checks for the new path as well.
    return createReservedControlSocket({ ...options, socketPath: alternate });
  }
}

async function createReservedControlSocket(options: ControlSocketOptions): Promise<ControlSocket> {
  const { socketPath, view, onMutation } = options;
  const currentContext = options.currentContext ?? (() => "standard");
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `socket path too long (${bytes} bytes; unix sun_path caps ~104): ${socketPath} — use a short runtime dir (default: $OPENRIG_HOME/run)`,
    );
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

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

  const listen = () => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  try {
    await listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    // All supported recoverers reserve this path before probing/unlinking.
    // Never steal an abandoned reservation: a crash can occur after replacement bind.
    const reservation = `${socketPath}.recovery.lock`;
    let fd: number;
    try {
      fd = fs.openSync(reservation, "wx", 0o600);
    } catch (lockError) {
      if ((lockError as NodeJS.ErrnoException).code === "EEXIST") {
        throw Object.assign(new Error(`Control socket recovery reservation exists: ${reservation}. Confirm no launcher is recovering this socket before removing that file.`), { code: "EADDRINUSE" });
      }
      throw lockError;
    }
    try {
      // An existing path may belong to another running TUI. Only a refused
      // connection to an unchanged, owned socket proves a stale launcher.
      const before = fs.lstatSync(socketPath);
      if (!before.isSocket() || (process.getuid && before.uid !== process.getuid())) throw error;
      const stale = await new Promise<boolean>((resolve) => {
        const probe = net.createConnection(socketPath);
        probe.setTimeout(1000);
        const finish = (value: boolean) => { probe.destroy(); resolve(value); };
        probe.once("connect", () => finish(false));
        probe.once("timeout", () => finish(false));
        probe.once("error", (cause: NodeJS.ErrnoException) => finish(cause.code === "ECONNREFUSED"));
      });
      const after = fs.lstatSync(socketPath);
      if (!stale || before.dev !== after.dev || before.ino !== after.ino) throw error;
      fs.unlinkSync(socketPath);
      await listen();
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(reservation);
    }
  }
  return {
    path: socketPath,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
