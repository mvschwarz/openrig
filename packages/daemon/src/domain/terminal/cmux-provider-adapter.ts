// OPR.0.4.6.02 C2 — the cmux TerminalProvider facade.
//
// A THIN facade over the SHIPPED `NodeCmuxService` + `CmuxAdapter`. It wraps,
// it does not rewrite: `openView` delegates each pane to the existing
// `openOrFocusNodeSurface` (the shipped open/focus semantics, unchanged), and
// `status`/`liveness` read the shipped `CmuxAdapter` status. cmux stays
// best-effort / non-gating / no-regression — a seat cmux can't tile is
// degraded honestly (never a hard failure, never a silent drop).
//
// cmux surfaces are always LOCAL (cmux runs on the operator's machine), so a
// cmux-level degrade stamps the `local` host sentinel.

import type { CmuxAdapter } from "../../adapters/cmux.js";
import type { NodeCmuxService } from "../node-cmux-service.js";
import type {
  AbsentSeat,
  ComposedView,
  DegradedSeat,
  OpenViewResult,
  ProviderLiveness,
  ProviderStatus,
  TerminalProvider,
} from "./terminal-provider.js";

/** Rig + node coordinates the shipped NodeCmuxService needs to open a surface. */
export interface SeatNodeRef {
  rigId: string;
  logicalId: string;
}

export interface CmuxProviderDeps {
  cmuxAdapter: CmuxAdapter;
  nodeCmuxService: NodeCmuxService;
  /**
   * Map a seat (canonical session name) to its rig + node so the shipped
   * NodeCmuxService can open/focus its surface. A seat that does not resolve to
   * a managed local node degrades honestly (cmux tiles managed nodes only).
   */
  resolveSeatNode(seat: string): SeatNodeRef | null;
}

/** Sentinel host for cmux-level degrades (cmux surfaces are always local). */
const CMUX_LOCAL_HOST = "local";

export class CmuxProviderAdapter implements TerminalProvider {
  readonly name = "cmux";

  constructor(private readonly deps: CmuxProviderDeps) {}

  async status(): Promise<ProviderStatus> {
    const s = this.deps.cmuxAdapter.getStatus();
    return { provider: this.name, available: s.available, capabilities: s.capabilities };
  }

  async liveness(): Promise<ProviderLiveness> {
    const alive = this.deps.cmuxAdapter.isAvailable();
    return alive ? { alive: true } : { alive: false, detail: "cmux is not connected" };
  }

  async openView(view: ComposedView): Promise<OpenViewResult> {
    // Carry forward the composer's honest-partial classification verbatim.
    const absent: AbsentSeat[] = [...view.absent];
    const degraded: DegradedSeat[] = [...view.degraded];
    const opened: string[] = [];

    for (const pane of view.opened) {
      const ref = this.deps.resolveSeatNode(pane.seat);
      if (!ref) {
        degraded.push({
          seat: pane.seat,
          host: CMUX_LOCAL_HOST,
          reason: "cmux: seat is not a managed local node (cmux tiles managed nodes only)",
        });
        continue;
      }
      const res = await this.deps.nodeCmuxService.openOrFocusNodeSurface(ref.rigId, ref.logicalId);
      if (res.ok) {
        opened.push(pane.seat);
      } else {
        degraded.push({
          seat: pane.seat,
          host: CMUX_LOCAL_HOST,
          reason: `cmux: ${res.error ?? res.code ?? "open failed"}`,
        });
      }
    }

    // cmux is non-gating: a partial render is still ok=true (the honest-partial
    // detail lives in absent/degraded). Only an unexpected throw is a failure.
    return {
      provider: this.name,
      ok: true,
      opened,
      absent,
      degraded,
      pages: view.pages.length,
    };
  }
}
