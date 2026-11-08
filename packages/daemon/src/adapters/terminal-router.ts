// The terminal router: the daemon's single terminal adapter, dispatching each call to the substrate of the seat it
// targets. tmux is the default and the only substrate of every seat whose node has no stored terminal_substrate, so
// a daemon with no Herdr seat sends every call to the TmuxAdapter exactly as before.
//
// Routing (design: missions/herdr-session-backend/slices/02-phase2-mvp/design.md §2):
// - Pane/session ids route by shape: Herdr `w<N>:p<N>`, tmux `%N`/`$N`/`@N`.
// - A session name routes through the DB: a node with a stored substrate whose binding session, a session row, or
//   canonical session name carries that name. Every other name is tmux (helpers, probes, discovery).
// - A stored substrate this daemon doesn't know is refused (`substrate_unknown`); it is never read as tmux.
// - A Herdr seat's call goes to the Herdr seat adapter when one is configured, and is refused otherwise.
// - Whole-server reads (listSessions, readAllPaneProcesses, readAllSessionWindows/Activity) merge tmux with the
//   Herdr seats the DB knows about (never the whole Herdr session). If a Herdr endpoint with seats can't be read, the
//   merged read fails rather than returning only the tmux half, which would read those seats as gone.
// - Other server-scoped verbs stay on tmux.
import type Database from "better-sqlite3";
import type { TmuxAdapter, TmuxResult, SessionProbe } from "./tmux.js";
import { deriveCanonicalSessionName, deriveSessionName } from "../domain/session-name.js";
import { readStoredSubstrate, type TerminalSubstrate } from "../domain/terminal-substrate.js";

export type SubstrateRoute = { kind: TerminalSubstrate } | { kind: "unknown"; value: string };

export class TerminalSubstrateError extends Error {
  constructor(readonly code: "substrate_unknown" | "herdr_unavailable" | "herdr_unsupported", message: string) {
    super(message);
    this.name = "TerminalSubstrateError";
  }
}

// Herdr ids are opaque and not always decimal (e.g. w3A:p2).
const HERDR_PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;
const TMUX_ID = /^[%$@]\d+$/;

/** Methods whose first argument is not a seat target; they always run on tmux. */
const SERVER_SCOPED = new Set<string>([
  "startServer", "closeControlClient", "getDefaultShell", "listSessions", "listClients", "setServerOption",
  "showServerOption", "readAllSessionWindows", "readAllSessionWindowActivity", "readAllPaneProcesses",
  "capturePanesContent", "swapRuntimeSwitchPanes", "adoptRuntimeSwitchStaging", "signalPid", "createProbeSession",
  "humanInput", "operation", "finishLaunchBinding",
]);

/** Methods that answer with a TmuxResult, so a refusal can be returned rather than thrown. */
const RESULT_METHODS = new Set<string>([
  "createSession", "sendText", "sendShellCommand", "sendKeys", "setWindowOption", "restoreWindowOption", "resizeWindow",
  "killSession", "respawnPane", "setRemainOnExit", "restorePaneOption", "signalPaneProcess", "cancelPaneMode",
  "startPipePane", "stopPipePane", "setSessionOption", "switchClient", "setRuntimeSwitchEnvironment",
]);

interface SubstrateRow {
  id: string; logical_id: string; rig_name: string; terminal_substrate: string; pod_namespace: string | null;
  binding_session: string | null; binding_pane: string | null;
}

/** Resolves a target to its seat's substrate. Only nodes with a stored substrate are read, so a tmux-only daemon
 *  reads an empty set. The set is cached briefly: substrates are written once at node creation. */
export class SubstrateResolver {
  private cache: { at: number; names: Map<string, SubstrateRoute>; nodes: Map<string, SubstrateRoute> } | null = null;
  private hasColumn: boolean | null = null;

  constructor(private readonly db: Database.Database, private readonly ttlMs = 500, private readonly now = () => Date.now()) {}

  invalidate(): void { this.cache = null; }

  private load() {
    const t = this.now();
    if (this.cache && t - this.cache.at < this.ttlMs) return this.cache;
    const names = new Map<string, SubstrateRoute>();
    const nodes = new Map<string, SubstrateRoute>();
    if (this.hasColumn === null) {
      this.hasColumn = (this.db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>).some(c => c.name === "terminal_substrate");
    }
    if (this.hasColumn) {
      const rows = this.db.prepare(`
        SELECT n.id, n.logical_id, r.name AS rig_name, n.terminal_substrate, p.namespace AS pod_namespace,
               b.tmux_session AS binding_session, b.tmux_pane AS binding_pane
        FROM nodes n JOIN rigs r ON r.id = n.rig_id
        LEFT JOIN pods p ON p.id = n.pod_id
        LEFT JOIN bindings b ON b.node_id = n.id
        WHERE n.terminal_substrate IS NOT NULL AND n.terminal_substrate <> ''
      `).all() as SubstrateRow[];
      const sessionRows = this.db.prepare(`
        SELECT s.node_id, s.session_name FROM sessions s JOIN nodes n ON n.id = s.node_id
        WHERE n.terminal_substrate IS NOT NULL AND n.terminal_substrate <> ''
      `).all() as Array<{ node_id: string; session_name: string }>;
      for (const row of rows) {
        const route = readStoredSubstrate(row.terminal_substrate) as SubstrateRoute;
        nodes.set(row.id, route);
        if (row.binding_session) names.set(row.binding_session, route);
        if (row.binding_pane) names.set(row.binding_pane, route);
        for (const name of canonicalNames(row)) names.set(name, route);
      }
      for (const s of sessionRows) {
        const route = nodes.get(s.node_id);
        if (route) names.set(s.session_name, route);
      }
    }
    this.cache = { at: t, names, nodes };
    return this.cache;
  }

  /** The substrate of the node with this id (tmux when it has none stored). A cache miss reads the node itself, so
   *  a seat created since the last load is never routed to tmux by a stale cache; finding one drops the cache so its
   *  names route from now on (F2). */
  forNode(nodeId: string | undefined | null): SubstrateRoute {
    if (!nodeId) return { kind: "tmux" };
    const cached = this.load().nodes.get(nodeId);
    if (cached) return cached;
    if (!this.hasColumn) return { kind: "tmux" };
    const row = this.db.prepare("SELECT terminal_substrate FROM nodes WHERE id = ?").get(nodeId) as { terminal_substrate: string | null } | undefined;
    const route = readStoredSubstrate(row?.terminal_substrate) as SubstrateRoute;
    if (route.kind !== "tmux") this.invalidate();
    return route;
  }

  /** The substrate a target string belongs to. */
  forTarget(target: string): SubstrateRoute {
    const bare = target.replace(/^=/, "");
    if (HERDR_PANE_ID.test(bare)) return { kind: "herdr" };
    if (TMUX_ID.test(bare)) return { kind: "tmux" };
    // `session:window[.pane]` → the session part.
    const session = bare.includes(":") ? bare.slice(0, bare.indexOf(":")) : bare;
    return this.load().names.get(session) ?? { kind: "tmux" };
  }
}

function canonicalNames(row: SubstrateRow): string[] {
  const out = [deriveSessionName(row.rig_name, row.logical_id)];
  const dot = row.logical_id.indexOf(".");
  if (dot > 0) out.push(deriveCanonicalSessionName(row.pod_namespace ?? row.logical_id.slice(0, dot), row.logical_id.slice(dot + 1), row.rig_name));
  return out;
}

export interface TerminalRouterOptions {
  resolver: SubstrateResolver;
  /** The Herdr seat adapter, when Herdr seats are configured. Absent: Herdr seats are refused. */
  herdr?: TmuxAdapter & { hasSeats?: () => boolean };
}

const MERGED_READS = new Set(["listSessions", "readAllPaneProcesses", "readAllSessionWindows", "readAllSessionWindowActivity"]);

async function mergedRead(method: string, tmuxCall: () => Promise<unknown>, herdrCall: () => Promise<unknown>): Promise<unknown> {
  const [fromTmux, fromHerdr] = await Promise.all([tmuxCall(), herdrCall()]);
  if (Array.isArray(fromTmux) || Array.isArray(fromHerdr)) return [...((fromTmux as unknown[]) ?? []), ...((fromHerdr as unknown[]) ?? [])];
  if (fromTmux === null && fromHerdr === null) return null;
  // A null tmux map means "no reading"; keep it so callers still see the tmux side as unknown.
  if (fromTmux === null) return null;
  const merged = new Map(fromTmux as Map<unknown, unknown>);
  for (const [k, v] of (fromHerdr as Map<unknown, unknown> | null) ?? new Map()) merged.set(k, v);
  void method;
  return merged;
}

/** Wrap the daemon's TmuxAdapter so each call reaches the target seat's substrate. The result is typed as the
 *  TmuxAdapter every consumer already takes. */
export function createTerminalRouter(tmux: TmuxAdapter, opts: TerminalRouterOptions): TmuxAdapter {
  const { resolver } = opts;
  const refuse = (method: string, error: TerminalSubstrateError): unknown => {
    if (RESULT_METHODS.has(method)) return Promise.resolve({ ok: false, code: error.code, message: error.message } satisfies TmuxResult);
    if (method === "probeSession") return Promise.resolve({ state: "transport_unavailable", cause: error.message } satisfies SessionProbe);
    return Promise.reject(error);
  };
  const routeFor = (method: string, args: unknown[]): SubstrateRoute => {
    if (method === "createSession") {
      const env = args[2] as Record<string, string> | undefined;
      const byNode = resolver.forNode(env?.["OPENRIG_NODE_ID"]);
      return byNode.kind !== "tmux" ? byNode : resolver.forTarget(String(args[0]));
    }
    if (method === "switchClient") return resolver.forTarget(String(args[1]));
    return typeof args[0] === "string" ? resolver.forTarget(args[0]) : { kind: "tmux" };
  };

  return new Proxy(tmux, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // The adapter's own fields (exec functions, maps) are state, not verbs: return them as they are.
      if (Object.prototype.hasOwnProperty.call(target, prop)) return value;
      if (typeof prop === "string" && typeof value === "function" && MERGED_READS.has(prop) && opts.herdr?.hasSeats?.()) {
        const herdr = opts.herdr;
        return (...args: unknown[]) => mergedRead(prop,
          () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args),
          () => (Reflect.get(herdr, prop, herdr) as (...a: unknown[]) => Promise<unknown>).apply(herdr, args));
      }
      if (prop === "capturePanesContent" && typeof value === "function") {
        // Batched capture is tmux's; any non-tmux target sends callers to their per-pane fallback, which routes.
        return (targets: string[], ...rest: unknown[]) => targets.some(t => resolver.forTarget(t).kind !== "tmux")
          ? Promise.resolve(null) : (value as (...a: unknown[]) => unknown).apply(target, [targets, ...rest]);
      }
      if (typeof prop !== "string" || typeof value !== "function" || SERVER_SCOPED.has(prop) || prop === "constructor") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const route = routeFor(prop, args);
        if (route.kind === "tmux") return (value as (...a: unknown[]) => unknown).apply(target, args);
        if (route.kind === "unknown") {
          return refuse(prop, new TerminalSubstrateError("substrate_unknown",
            `This seat's terminal substrate "${route.value}" is not known to this daemon; nothing was done. It is never treated as tmux.`));
        }
        const herdr = opts.herdr;
        const fn = herdr ? Reflect.get(herdr, prop, herdr) : undefined;
        if (!herdr || typeof fn !== "function") {
          return refuse(prop, new TerminalSubstrateError("herdr_unavailable",
            `This seat runs on Herdr, but the daemon has no Herdr seat adapter configured; nothing was done.`));
        }
        return (fn as (...a: unknown[]) => unknown).apply(herdr, args);
      };
    },
    set(target, prop, value, receiver) {
      // The delivery guard and launch environment are shared, so leases and composer checks stay single-sourced.
      // Order matters: the guard keeps ONE input-inspection callback, attached by the adapter whose setter runs last.
      // The tmux setter runs last with `receiver` = this router, so its inspection calls (composer snapshot, probe,
      // listPanes, isPaneDead) route to each target seat's own substrate.
      if (opts.herdr && (prop === "deliveryGuard" || prop === "launchEnvironment")) Reflect.set(opts.herdr, prop, value);
      return Reflect.set(target, prop, value, receiver);
    },
  });
}
