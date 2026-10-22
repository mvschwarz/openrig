// Wire contract shared by three parties of the native-OMP-TUI seat shape:
//
//   1. the seat runner  (packages/daemon/src/adapters/pi-runner.ts) — owns the
//      Unix socket and routes frames between the other two;
//   2. the OMP-side bridge extension (omp-tui-extension.ts) — loaded INTO OMP,
//      reports OMP's session events and applies commands to the live session;
//   3. the daemon's message writer (omp-tui-runtime-adapter.ts) — sends a Rig
//      message into that same OMP conversation.
//
// The protocol reuses OMP's RPC vocabulary (prompt/steer/follow_up/abort/
// get_state/get_entries) so the existing RPC integration is retained rather
// than replaced: the same command names, the same event names, the same
// response shape ({id, success, data}).
//
// Framing: UTF-8 JSON objects, one per line ("\n" terminated). JSON.stringify
// escapes embedded newlines, so a frame never spans lines.

import nodePath from "node:path";

/** Wire version. Bumped only for a breaking change in frame shapes. */
export const OMP_BRIDGE_PROTOCOL_VERSION = 1;

/** Maximum UTF-8 frame size, excluding the newline delimiter. */
export const MAX_BRIDGE_FRAME_BYTES = 1024 * 1024;

/** Socket file name inside the seat state root (<stateRoot>/<sessionName>/). */
export const OMP_BRIDGE_SOCKET_NAME = "omp-bridge.sock";

/** Who is speaking on a socket connection. */
export type OmpBridgeRole = "bridge" | "control";

/** First frame on every connection: who speaks, and which wire version. */
export interface OmpBridgeHandshake extends Record<string, unknown> {
  role: OmpBridgeRole;
  protocolVersion: number;
  /** OMP session id (bridge role only, when known). */
  sessionId?: string;
  /** Absolute OMP session-file path (bridge role only) — the resume token. */
  sessionFile?: string;
}
/**
 * Reply to get_entries. Truncation means not every requested entry was
 * enumerated, so the caller keeps its cursor behind omitted entries and can
 * ask again; omitted entries remain recoverable. newestId is the session's
 * newest entry id (the leaf), a position that need not appear in entries: a
 * caller advances its cursor over the enumerated entries only, because the
 * newest id is not an accounting of the entries a truncated reply left out.
 */
export interface OmpBridgeEntriesReply extends Record<string, unknown> {
  /** The enumerated entry ids, in append order. */
  entries: Array<{ id: string }>;
  /** The session's newest entry id (the leaf). Absent when unknown. */
  newestId?: string;
  /** True when the reply did not enumerate every entry the caller asked for. */
  truncated: boolean;
  /** False when the bridge cannot read the session's entries at all. */
  available: boolean;
}


/**
 * Commands the runner relays to the bridge (and the bridge applies). This list
 * is the single source of truth: the command type is derived from it, so the
 * runtime allowlist and the type cannot drift apart.
 */
export const OMP_BRIDGE_COMMAND_TYPES = [
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "get_state",
  "get_entries",
] as const;

/** Commands the runner relays to the bridge (and the bridge applies). */
export type OmpBridgeCommandType = (typeof OMP_BRIDGE_COMMAND_TYPES)[number];

export interface OmpBridgeCommand {
  type: OmpBridgeCommandType;
  /** User text for prompt/steer/follow_up. */
  message?: string;
  /** Correlation id for replies (get_state/get_entries). */
  id?: string;
  /** Catch-up cursor for get_entries. */
  since?: string;
}

const BRIDGE_COMMAND_TYPES: ReadonlySet<string> = new Set<string>(OMP_BRIDGE_COMMAND_TYPES);

/** Absolute path of the bridge socket for a seat state root. */
export function ompBridgeSocketPath(seatRoot: string): string {
  return nodePath.join(seatRoot, OMP_BRIDGE_SOCKET_NAME);
}

/** Serialize one frame. The trailing newline is the frame delimiter. */
export function encodeBridgeFrame(frame: Record<string, unknown>): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Parse one line into a frame. Non-object / malformed lines are dropped. */
export function parseBridgeFrame(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Incremental newline-delimited frame decoder. Malformed or oversized frames
 * fail closed; onError lets socket owners destroy the offending connection.
 */
export function createBridgeFrameDecoder(
  onFrame: (frame: Record<string, unknown>) => void,
  onError: (error: Error) => void = () => {},
): { push(chunk: string): void } {
  let buffer = "";
  let failed = false;
  return {
    push(chunk: string): void {
      if (failed) return;
      let remaining = chunk;
      while (true) {
        const index = remaining.indexOf("\n");
        if (index === -1) {
          if (Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(remaining, "utf8") > MAX_BRIDGE_FRAME_BYTES) {
            failed = true;
            buffer = "";
            onError(new Error(`bridge frame exceeds ${MAX_BRIDGE_FRAME_BYTES} bytes`));
            return;
          }
          buffer += remaining;
          return;
        }
        const part = remaining.slice(0, index);
        if (Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(part, "utf8") > MAX_BRIDGE_FRAME_BYTES) {
          failed = true;
          buffer = "";
          onError(new Error(`bridge frame exceeds ${MAX_BRIDGE_FRAME_BYTES} bytes`));
          return;
        }
        const line = buffer + part;
        buffer = "";
        const frame = parseBridgeFrame(line);
        if (line.trim() && !frame) {
          failed = true;
          onError(new Error("malformed bridge frame"));
          return;
        }
        if (frame) onFrame(frame);
        remaining = remaining.slice(index + 1);
      }
    },
  };
}

/** Whether a frame is a well-formed handshake for a known role. */
export function isBridgeHandshake(frame: Record<string, unknown>): frame is OmpBridgeHandshake {
  const role = frame.role;
  if (role !== "bridge" && role !== "control") return false;
  if (frame.protocolVersion !== OMP_BRIDGE_PROTOCOL_VERSION) return false;
  return true;
}

/** Parse a command frame. Unknown types are not commands. */
export function parseBridgeCommand(frame: Record<string, unknown>): OmpBridgeCommand | null {
  const type = frame.type;
  if (typeof type !== "string" || !BRIDGE_COMMAND_TYPES.has(type)) return null;
  const command: OmpBridgeCommand = { type: type as OmpBridgeCommandType };
  if (typeof frame.message === "string") command.message = frame.message;
  if (typeof frame.id === "string") command.id = frame.id;
  if (typeof frame.since === "string") command.since = frame.since;
  return command;
}

/**
 * How a command maps onto OMP's user-message delivery. "prompt" keeps OMP's
 * own rule (idle starts a turn, streaming queues it) and therefore carries no
 * explicit delivery mode.
 */
export function bridgeCommandDeliversAs(
  type: OmpBridgeCommandType,
): "steer" | "followUp" | undefined {
  if (type === "steer") return "steer";
  if (type === "follow_up") return "followUp";
  return undefined;
}

/**
 * Reconciliation key for one OMP event. OMP update events carry no per-update
 * identity, so an identity-only key drops every update after the first.
 */
export function bridgeEventDedupeKey(event: Record<string, unknown>): string | null {
  const type = typeof event.type === "string" ? event.type : "";
  if (!type || type.endsWith("_update")) return null;
  if (type === "tool_execution_start" || type === "tool_execution_end") {
    const toolCallId = event.toolCallId;
    return typeof toolCallId === "string" && toolCallId ? `${type}:${toolCallId}` : null;
  }
  if (type === "message_start" || type === "message_end") {
    const messageId = event.messageId ?? event.id;
    return typeof messageId === "string" && messageId ? `${type}:${messageId}` : null;
  }
  return null;
}
