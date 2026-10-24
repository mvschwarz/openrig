import type {
  ComposedPane,
  ComposedView,
  DegradedSeat,
  OpenViewResult,
  ProviderLiveness,
  ProviderStatus,
  TerminalProvider,
} from "./terminal-provider.js";
import { RexError, type RexProbeResult, type RexTransport } from "./rex-transport.js";
import { buildRexGrid, REX_LABEL_LIMIT, rexLabel } from "./rex-layout.js";
import { planTileLabels } from "./tile-layout.js";

/** Sentinel host for a seat Rex itself failed to show. */
const REX_SURFACE_HOST = "rex";

export const REX_PANES_PER_PAGE = 16;
/** The wait before the one check of the opened tiles: each block's login shell starts before its command runs. */
export const REX_TILE_SETTLE_MS = 2_000;
const CHECK_BATCH = 16;
const PROBE_REUSE_MS = 1_000;
type ProbeEntry = { result: Promise<RexProbeResult>; settledAt?: number };
export const REX_TILE_CLOSED_REASON = "the tile had already closed when OpenRig checked it after opening";
export const REX_TILES_UNCONFIRMED_NOTE = "Rex couldn't confirm the tiles after opening, so those seats are listed as opened without that check.";

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const outcomeUnknown = (err: unknown): boolean => err instanceof RexError && err.kind === "unknown";

/** A seat's tile and the block id Rex gave it, if any. */
export interface RexTile { pane: ComposedPane; blockId: unknown }

/**
 * One read of the opened tiles: a tile whose block is gone, or whose command already exited (a failed attach stays
 * open showing its error), gets a reason. It fails safe: anything Rex can't confirm keeps the seat opened, with a
 * note. Reasons line up with `tiles`.
 */
export async function exitedTiles(transport: RexTransport, sessionId: string, tiles: RexTile[], notes: string[]): Promise<Array<string | null>> {
  const reasons: Array<string | null> = tiles.map(() => null);
  const unconfirmed = () => { if (!notes.includes(REX_TILES_UNCONFIRMED_NOTE)) notes.push(REX_TILES_UNCONFIRMED_NOTE); };
  let listed: unknown;
  try {
    listed = (await transport.request("session.list_blocks", { session_id: sessionId }))["blocks"];
  } catch {
    listed = null;
  }
  if (!Array.isArray(listed)) {
    unconfirmed();
    return reasons;
  }
  const live = new Set(listed.map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>)["block_id"] : null)));
  const check = async ({ blockId }: RexTile, index: number) => {
    if (typeof blockId !== "string" || !blockId) return unconfirmed();
    if (!live.has(blockId)) {
      reasons[index] = REX_TILE_CLOSED_REASON;
      return;
    }
    try {
      const exit = (await transport.request("com.superlogical.terminal.process", { session_id: sessionId, block_id: blockId, args: {} }))["last_exit"];
      if (exit && typeof exit === "object") {
        const { exit_code: code, error } = exit as { exit_code?: unknown; error?: unknown };
        reasons[index] = `the tile's command exited${typeof code === "number" ? ` with code ${code}` : ""} soon after Rex opened it${typeof error === "string" && error ? ` (${error})` : ""}`;
      }
    } catch (err) {
      if ((err as { code?: unknown }).code === "not_found") reasons[index] = REX_TILE_CLOSED_REASON;
      else unconfirmed();
    }
  };
  for (let i = 0; i < tiles.length; i += CHECK_BATCH) {
    await Promise.all(tiles.slice(i, i + CHECK_BATCH).map((tile, j) => check(tile, i + j)));
  }
  return reasons;
}

export class RexAdapter implements TerminalProvider {
  readonly name = "rex";
  readonly panesPerPage = REX_PANES_PER_PAGE;
  private readonly transport: RexTransport;
  private readonly newLaunchToken: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private launchCounter = 0;
  private lastProbe: ProbeEntry | null = null;

  constructor(deps: { transport: RexTransport; newLaunchToken?: () => string; sleep?: (ms: number) => Promise<void>; now?: () => number }) {
    this.transport = deps.transport;
    this.newLaunchToken = deps.newLaunchToken ?? (() => `l${(this.launchCounter += 1)}`);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  /** A status report asks for status() then liveness(); one probe answers both. */
  private probe(): Promise<RexProbeResult> {
    const last = this.lastProbe;
    if (last && (last.settledAt === undefined || this.now() - last.settledAt < PROBE_REUSE_MS)) return last.result;
    const entry: ProbeEntry = { result: this.transport.probe() };
    const settle = () => { entry.settledAt = this.now(); };
    entry.result.then(settle, settle);
    this.lastProbe = entry;
    return entry.result;
  }

  async status(): Promise<ProviderStatus> {
    try {
      const probe = await this.probe();
      return {
        provider: this.name,
        available: probe.alive,
        ...(probe.version ? { version: probe.version } : {}),
        capabilities: { cli: probe.alive, "session.create": probe.alive, "session.new_window": probe.alive },
        ...(probe.instanceId ? { server: { instanceId: probe.instanceId } } : {}),
      };
    } catch {
      return { provider: this.name, available: false, capabilities: {} };
    }
  }

  async liveness(): Promise<ProviderLiveness> {
    try {
      const probe = await this.probe();
      return probe.alive ? { alive: true } : { alive: false, detail: probe.detail ?? "the Rex server is not answering" };
    } catch (err) {
      return { alive: false, detail: describe(err) };
    }
  }

  /** The plain label, or the next free numbered one when a view by that name is already open. */
  private async freeSessionLabel(plain: string): Promise<string> {
    let open: string[];
    try {
      const sessions = (await this.transport.request("session.list", {}))["sessions"];
      open = Array.isArray(sessions) ? sessions.flatMap((s) => (typeof s?.label === "string" ? [s.label as string] : [])) : [];
    } catch {
      return plain;
    }
    if (!open.includes(plain)) return plain;
    const numbered = (n: number) => `${rexLabel(plain, REX_LABEL_LIMIT - ` (${n})`.length)} (${n})`;
    let n = 2;
    while (open.includes(numbered(n))) n++;
    return numbered(n);
  }

  async openView(view: ComposedView): Promise<OpenViewResult> {
    const degraded: DegradedSeat[] = [...view.degraded];
    const opened: string[] = [];
    const base = { provider: this.name, absent: [...view.absent], degraded, opened };
    const degrade = (panes: ComposedPane[], reason: string) => {
      for (const pane of panes) degraded.push({ seat: pane.seat, host: REX_SURFACE_HOST, reason });
    };

    const probe = await this.transport.probe();
    if (!probe.alive) {
      return { ...base, ok: false, pages: 0, code: "rex_unavailable", error: `${probe.detail ?? "the Rex server is not answering"}; is Rex running?` };
    }
    if (view.pages.length === 0) return { ...base, ok: view.opened.length === 0, pages: 0 };

    const labels = planTileLabels(view, this.newLaunchToken());
    const grids = view.pages.map((page) => buildRexGrid(page, view.columns));
    const plain = rexLabel(labels.space);
    const label = await this.freeSessionLabel(plain);
    const notes: string[] = [];
    let sessionId: string;
    try {
      // Empty first: blocks in a create's own windows stay owned by this short-lived client, holding back the app's resize.
      const created = await this.transport.request("session.create", { label });
      if (typeof created["session_id"] !== "string" || !created["session_id"]) throw new RexError("the reply named no session", "unknown");
      sessionId = created["session_id"];
    } catch (err) {
      const unknown = outcomeUnknown(err);
      const reason = unknown
        ? `Rex didn't confirm creating session "${label}" (${describe(err)}); it may exist. Check Rex before retrying.`
        : `rex session.create failed: ${describe(err)}`;
      for (const page of view.pages) degrade(page, reason);
      return { ...base, ok: view.opened.length === 0, pages: 0, error: reason, code: unknown ? "rex_outcome_unknown" : "rex_session_failed" };
    }

    const tiles: RexTile[] = [];
    let painted = 0;
    let firstFailure: string | undefined;
    const uncertainPages: number[] = [];
    for (const [index, pagePanes] of view.pages.entries()) {
      try {
        const window = await this.transport.request("session.new_window", {
          session_id: sessionId, window_label: rexLabel(labels.pages[index]!), ...(index > 0 ? { focus: false } : {}), layout: grids[index]!.root,
        });
        const ids = window["block_ids"];
        painted++;
        pagePanes.forEach((pane, i) => tiles.push({ pane, blockId: Array.isArray(ids) ? ids[i] : undefined }));
      } catch (err) {
        if (outcomeUnknown(err)) {
          uncertainPages.push(index + 1);
          degrade(pagePanes, `Rex didn't confirm page ${index + 1} of session "${label}" (${describe(err)}); its tiles may be open`);
          continue;
        }
        const reason = `rex session.new_window failed: ${describe(err)}`;
        firstFailure ??= reason;
        degrade(pagePanes, reason);
      }
    }
    const space = { id: sessionId, label };
    const unconfirmed = uncertainPages.length === 0 ? undefined
      : `Rex didn't confirm page${uncertainPages.length > 1 ? "s" : ""} ${uncertainPages.join(", ")} of session "${label}", so those seats are listed as degraded but may be open. Check the session in Rex before retrying.`;
    if (painted === 0 && unconfirmed) {
      // The session may hold tiles, so it stays.
      return { ...base, ok: view.opened.length === 0, pages: 0, error: unconfirmed, code: "rex_outcome_unknown", space };
    }
    if (painted === 0) {
      try {
        await this.transport.request("session.destroy", { session_id: sessionId });
      } catch (err) {
        notes.push(`Rex may have kept the empty session "${label}" (${describe(err)}); close it in Rex if it's still open.`);
      }
      return { ...base, ok: view.opened.length === 0, pages: 0, error: firstFailure, code: "rex_session_failed", ...(notes.length ? { notes } : {}) };
    }
    if (unconfirmed) notes.push(unconfirmed);

    if (label !== plain) notes.push(`A view named "${plain}" is already open, so this one is "${label}".`);
    await this.sleep(REX_TILE_SETTLE_MS);
    const reasons = await exitedTiles(this.transport, sessionId, tiles, notes);
    tiles.forEach(({ pane }, i) => {
      const reason = reasons[i];
      if (reason) degrade([pane], reason);
      else opened.push(pane.seat);
    });
    return {
      ...base,
      ok: opened.length > 0 || view.opened.length === 0,
      pages: painted,
      space,
      ...(notes.length ? { notes } : {}),
    };
  }
}
