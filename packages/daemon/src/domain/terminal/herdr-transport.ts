// OPR.0.4.6.02 FB4 — the herdr SOCKET transport (arm's-length AGPL boundary).
//
// herdr is an AGPL terminal multiplexer. OpenRig integrates it at ARM'S LENGTH:
// we talk to its local unix-domain CONTROL SOCKET (a runtime IPC endpoint the
// operator's installed herdr exposes) exactly the way we shell out to tmux/cmux
// — a local IPC client, NEVER importing, linking, embedding, or vendoring herdr
// code. This file only frames JSON on a socket the operator's herdr owns.
//
// Why a socket, not the CLI (the FB4 correction): herdr 0.7.1 has NO `layout`
// CLI command — the prior CLI transport (`herdr layout apply …`) could never
// tile a view (the VM proof at e373f741 hit `herdr_layout_unsupported`). herdr
// 0.7.1's layout mechanism is the socket JSON-RPC `layout.apply`, which the
// slice research validated over the raw socket. The wire protocol here is
// grounded in the VERBATIM captures preserved at
// research/herdr-socket-captures/herdr-phase3-*.json:
//   - socket: ~/.config/herdr/herdr.sock (HERDR_SOCKET_PATH / HERDR_SESSION overrides)
//   - framing: newline-delimited JSON (one object per line)
//   - envelope: request {id,method,params} → success {id,result:{type,…}}
//     (NOT JSON-RPC 2.0 — there is no `jsonrpc` field; some methods, e.g. ping,
//      may answer with a bare {type,…})
// The error-response envelope, the exact socket lifecycle, and workspace.create
// were not captured verbatim; they are handled DEFENSIVELY here and are the
// first-run-empirical items the fresh VM re-proof must confirm (unproven until
// that proof artifact lands).

import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";

/** A herdr socket result body — always carries a `type` discriminator. */
export interface HerdrResult {
  type: string;
  [k: string]: unknown;
}

export interface HerdrProbeResult {
  /** Is the herdr control socket reachable + answering `ping`? */
  alive: boolean;
  version: string | null;
  protocol: number | null;
}

/** One socket round-trip: send {id,method,params}, resolve the matching response body. */
export type HerdrSocketRpc = (req: { id: string; method: string; params: unknown }) => Promise<HerdrResult>;

export interface HerdrTransport {
  /** Liveness + version/protocol via the socket `ping` (not the absent CLI). */
  probe(): Promise<HerdrProbeResult>;
  /** Send a socket request; resolve the `result` body, reject on error / no result / unreachable. */
  request(method: string, params: unknown): Promise<HerdrResult>;
}

export type HerdrTransportFactory = () => HerdrTransport;

/** Resolve the herdr control socket path: env override → per-session → default. */
export function resolveHerdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env["HERDR_SOCKET_PATH"]) return env["HERDR_SOCKET_PATH"] as string;
  const base = path.join(homedir(), ".config", "herdr");
  const session = env["HERDR_SESSION"];
  return session ? path.join(base, "sessions", session, "herdr.sock") : path.join(base, "herdr.sock");
}

/** Extract a version token (e.g. from a ping result's `version`, or `herdr --version`). */
export function parseHerdrVersion(out: unknown): string | null {
  if (typeof out !== "string") return null;
  const m = out.match(/(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)/);
  return m?.[1] ?? null;
}

/**
 * Normalize a parsed response line to its result body. Accepts BOTH the wrapped
 * `{id,result:{type,…}}` (layout.apply/workspace.create) and a bare `{type,…}`
 * (ping) shape, and treats an `{…,error:…}` (uncaptured shape, handled
 * defensively) or a shapeless line as an error.
 */
export function unwrapHerdrResponse(raw: unknown): HerdrResult {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj["error"] != null) {
      const e = obj["error"];
      throw new Error(`herdr error: ${typeof e === "string" ? e : JSON.stringify(e)}`);
    }
    const result = obj["result"];
    if (result && typeof result === "object") return result as HerdrResult;
    if (typeof obj["type"] === "string") return obj as HerdrResult; // bare {type,…} (e.g. pong)
  }
  throw new Error(`herdr: unrecognized socket response ${JSON.stringify(raw)}`);
}

/**
 * The REAL unix-socket RPC (node:net). One-shot per request: connect, send one
 * newline-delimited JSON line, read lines until the one whose `id` matches (or a
 * bare typed response), then close. Rejects on ENOENT (herdr not running),
 * timeout, connection error, socket close before a response, or a herdr error.
 * Injectable so the adapter/tests never open a real socket.
 */
export function createHerdrSocketRpc(
  socketPath: string = resolveHerdrSocketPath(),
  timeoutMs = 5000,
): HerdrSocketRpc {
  return (req) =>
    new Promise<HerdrResult>((resolve, reject) => {
      const conn = net.createConnection({ path: socketPath });
      let buf = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`herdr socket timeout after ${timeoutMs}ms (${socketPath})`))),
        timeoutMs,
      );
      conn.on("connect", () => conn.write(`${JSON.stringify(req)}\n`));
      conn.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // a partial/foreign line — keep reading
          }
          const id = (parsed as { id?: unknown })?.id;
          if (id != null && id !== req.id) continue; // a subscription/other message, not our reply
          try {
            const body = unwrapHerdrResponse(parsed);
            finish(() => resolve(body));
          } catch (err) {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          }
          return;
        }
      });
      conn.on("error", (err) => finish(() => reject(err)));
      conn.on("end", () => finish(() => reject(new Error("herdr socket closed before a response"))));
    });
}

/**
 * The socket transport. `request` sends through the injected RPC with a fresh
 * id; `probe` sends `ping` and reads `{type:"pong",version,protocol}`
 * (unreachable / non-pong → alive:false, the honest answer).
 */
export function createHerdrSocketTransport(rpc: HerdrSocketRpc): HerdrTransportFactory {
  return (): HerdrTransport => {
    let counter = 0;
    const nextId = () => `openrig-${(counter += 1)}`;
    return {
      async probe(): Promise<HerdrProbeResult> {
        try {
          const pong = await rpc({ id: nextId(), method: "ping", params: {} });
          const version = parseHerdrVersion(pong["version"]);
          const protocol = typeof pong["protocol"] === "number" ? (pong["protocol"] as number) : null;
          return { alive: pong["type"] === "pong" || version != null || protocol != null, version, protocol };
        } catch {
          return { alive: false, version: null, protocol: null };
        }
      },
      request(method: string, params: unknown): Promise<HerdrResult> {
        return rpc({ id: nextId(), method, params });
      },
    };
  };
}
