/**
 * Slice 51-02 (L2 test-system) — the shipped-surface READERS.
 *
 * For an `expect` step, the runner reads the named surface via the SHIPPED `rig`
 * invocation (or the TUI control socket) and returns the observable to assert on.
 * Reads only — never a direct DB poke (the honesty guarantee). Shape traps handled
 * per the verify-at-source record (ps/queue/stream are BARE ARRAYS; queue uses
 * --full so `body` is not blanked; tui_socket is a unix socket, send exactly
 * `state`; policy provenance is `policy effective`).
 *
 * FLAG-1 FAIL-CLOSED FLOOR (PM ruling, binding 51-02 v1): the `proof` surface has
 * NO shipped read binding — it VALIDATES (locked name) but the runner FAILS LOUD
 * here with a named UnboundSurfaceError, never fabricating a read from scope-audit
 * or anywhere else. Unbound is not silently-skipped (fallbacks need explicit
 * success signals). The real binding decision rides 51-03 by amendment.
 */

import net from "node:net";
import { runRig } from "./scenario-daemon.js";
import type { ExpectSurface } from "./scenario-schema.js";

export interface SurfaceContext {
  rigBin: string;
  readEnv: Record<string, string | undefined>;
  baseUrl: string;
}

export interface ReadSurfaceOptions {
  /** The seat a surface read is scoped to (pane/transcript). */
  seat?: string;
  /** Timeout for a socket/CLI read (ms). */
  timeoutMs?: number;
}

/** Thrown when an `expect` names a locked-but-unbound surface (FLAG-1 floor). */
export class UnboundSurfaceError extends Error {
  readonly surface: string;
  constructor(surface: string) {
    super(
      `expect surface "${surface}" is UNBOUND in v1: it is a locked-format surface with no ` +
        `shipped read binding, so the runner FAILS LOUD here rather than fabricating a read ` +
        `(the binding decision rides 51-03 by amendment). This is not a silently-skipped assertion.`,
    );
    this.name = "UnboundSurfaceError";
    this.surface = surface;
  }
}

/** Read a shipped surface and return its parsed observable. */
export async function readSurface(
  surface: ExpectSurface,
  ctx: SurfaceContext,
  opts: ReadSurfaceOptions = {},
): Promise<unknown> {
  switch (surface) {
    case "ps":
      return jsonRig(["ps", "--json"], ctx);
    case "queue":
      // --full so compact-list does not blank body/summary/evidenceRef.
      return jsonRig(["queue", "list", "--json", "--full"], ctx);
    case "stream":
      return jsonRig(["stream", "list", "--json"], ctx);
    case "scope":
      return jsonRig(["scope", "audit", "--json"], ctx);
    case "pane":
      return jsonRig(["capture", requireSeat(surface, opts), "--json"], ctx);
    case "transcript":
      return jsonRig(["transcript", requireSeat(surface, opts), "--tail", "--json"], ctx);
    case "policy_provenance":
      return jsonRig(["policy", "effective", "--json"], ctx);
    case "tui_socket":
      return readTuiSocket(ctx, opts);
    case "proof":
      // FLAG-1 floor — no shipped read; fail loud, never fabricate.
      throw new UnboundSurfaceError("proof");
    default:
      throw new Error(`unknown expect surface: ${JSON.stringify(surface)}`);
  }
}

function requireSeat(surface: string, opts: ReadSurfaceOptions): string {
  if (!opts.seat) throw new Error(`expect surface "${surface}" requires a seat (expect.seat)`);
  return opts.seat;
}

async function jsonRig(args: string[], ctx: SurfaceContext): Promise<unknown> {
  const r = await runRig(args, ctx.readEnv, ctx.rigBin);
  if (r.code !== 0) {
    throw new Error(`\`rig ${args.join(" ")}\` failed (exit ${r.code}): ${r.stderr || r.stdout}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`\`rig ${args.join(" ")}\` did not return valid JSON: ${r.stdout.slice(0, 200)}`);
  }
}

/**
 * Query the TUI control socket's OBSERVE verb: connect, send exactly `state`, and
 * parse the one-line JSON reply. Sending any other line is a MUTATION — the reader
 * sends only `state`. Path from OPENRIG_TUI_SOCKET (the scenario helper sets it
 * when a TUI is up).
 */
function readTuiSocket(ctx: SurfaceContext, opts: ReadSurfaceOptions): Promise<unknown> {
  const sockPath = ctx.readEnv.OPENRIG_TUI_SOCKET;
  if (!sockPath) {
    return Promise.reject(
      new Error("tui_socket read requires OPENRIG_TUI_SOCKET (the TUI control socket path)"),
    );
  }
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sockPath);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("tui_socket `state` query timed out"));
    }, timeoutMs);
    conn.on("connect", () => conn.write("state\n"));
    conn.on("data", (b) => {
      buf += b.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      const line = buf.slice(0, nl);
      conn.end();
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`tui_socket reply was not JSON: ${line.slice(0, 120)}`));
      }
    });
    conn.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
