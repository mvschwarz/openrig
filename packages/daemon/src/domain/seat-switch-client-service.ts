import type { RigRepository } from "./rig-repository.js";
import type { TmuxAdapter, TmuxWindow, TmuxClient } from "../adapters/tmux.js";
import { SeatStatusService } from "./seat-status-service.js";

/**
 * OPR.0.4.3.26 — seat-recovery switch-client VIEW retarget.
 *
 * Points an already-attached tmux client (a human terminal / CMUX tile) at the
 * seat's canonical session/window. It is deliberately VIEW-ONLY: the only
 * dependencies are `rigRepo` (read, via SeatStatusService) and `tmuxAdapter`
 * (probe + switch). It holds NO SessionRegistry write surface, NO ClaimService,
 * NO SeatHandoverService, and never calls converge/reconcile — so it is
 * structurally incapable of mutating routing, bindings, sessions, transcripts,
 * or node identity. It composes AFTER the routing-repair verbs
 * (`reconcile-session` / seat handover) as a distinct step.
 */

const RECONCILE_GUIDANCE =
  "Repair routing first (rig reconcile-session <session>, or rig seat handover <seat> ...), then re-run switch-client. switch-client only retargets a client's view; it never repairs routing.";

function attachGuidance(session: string): string {
  return `Attach a client first: tmux attach -t ${session} (or open the seat in CMUX), then re-run switch-client. switch-client never opens a new terminal.`;
}

export interface SeatSwitchClientRequest {
  seatRef: string;
  /** Target a specific attached client; required when multiple are attached. */
  client?: string | null;
  /** Target window index; defaults to 0 (the canonical seat window). */
  toWindow?: number | null;
}

export interface SeatSwitchClientSuccess {
  seat_ref: string;
  session: string;
  window: number;
  target: string;
  client: string;
  /** VIEW-ONLY marker: switch-client never mutates routing/bindings/identity. */
  mutated: false;
  retargeted: true;
}

interface ClientRef {
  name: string;
  session: string;
}

export type SeatSwitchClientResult =
  | { ok: true; result: SeatSwitchClientSuccess }
  | {
      ok: false;
      code:
        | "seat_ref_required"
        | "seat_not_found"
        | "seat_ambiguous"
        | "missing_canonical_session"
        | "session_not_found"
        | "window_not_found"
        | "no_client"
        | "ambiguous_client"
        | "client_not_found"
        | "switch_failed"
        | "tmux_probe_failed";
      message: string;
      guidance?: string;
      /** Attached clients, surfaced on the ambiguous / not-found paths so the
       *  operator can re-run with an explicit --client. */
      clients?: ClientRef[];
      matches?: Array<{ rig_name: string; logical_id: string; current_occupant: string | null }>;
    };

export class SeatSwitchClientService {
  private rigRepo: RigRepository;
  private tmuxAdapter: TmuxAdapter;

  constructor(deps: { rigRepo: RigRepository; tmuxAdapter: TmuxAdapter }) {
    this.rigRepo = deps.rigRepo;
    this.tmuxAdapter = deps.tmuxAdapter;
  }

  /** Honest probe-failure result. The tmux adapter intentionally RETHROWS
   *  unexpected probe failures (permission / socket errors). Every probe here
   *  (hasSession / listWindows / listClients) routes a throw through this so it
   *  surfaces as a structured tmux_probe_failed (-> HTTP 502) that names the
   *  failed operation, never an unstructured 500. */
  private probeFailed(operation: string, err: unknown): SeatSwitchClientResult {
    return {
      ok: false,
      code: "tmux_probe_failed",
      message: `tmux ${operation} probe failed: ${err instanceof Error ? err.message : String(err)}`,
      guidance: RECONCILE_GUIDANCE,
    };
  }

  async switchClient(req: SeatSwitchClientRequest): Promise<SeatSwitchClientResult> {
    // 1. Resolve seat -> canonical session, READ-ONLY (no binding mutation).
    const statusService = new SeatStatusService({ rigRepo: this.rigRepo });
    const status = statusService.getStatus(req.seatRef);
    if (!status.ok) {
      // Propagate the read-only resolution errors verbatim (seat_ref_required /
      // seat_not_found / seat_ambiguous, incl. the ambiguity match list).
      if (status.code === "seat_ambiguous") {
        return { ok: false, code: "seat_ambiguous", message: status.message, guidance: status.guidance, matches: status.matches };
      }
      return { ok: false, code: status.code, message: status.message, guidance: status.guidance };
    }

    const session = status.status.current_occupant;
    if (!session) {
      return {
        ok: false,
        code: "missing_canonical_session",
        message: `Seat "${req.seatRef}" has no canonical tmux session to view.`,
        guidance: RECONCILE_GUIDANCE,
      };
    }

    // 2. Probe the canonical session (read-only). A genuine probe failure
    //    (permission, etc.) is surfaced honestly rather than swallowed.
    let sessionLive: boolean;
    try {
      sessionLive = await this.tmuxAdapter.hasSession(session);
    } catch (err) {
      return this.probeFailed(`has-session for "${session}"`, err);
    }
    if (!sessionLive) {
      return {
        ok: false,
        code: "session_not_found",
        message: `Canonical session "${session}" for seat "${req.seatRef}" is not live.`,
        guidance: RECONCILE_GUIDANCE,
      };
    }

    // 3. Resolve the target window. Default = 0 (the canonical seat window).
    //    An explicit --to-window is verified against the live session so the
    //    operator gets actionable guidance, never a raw tmux failure.
    const windowIndex = req.toWindow ?? 0;
    if (req.toWindow != null) {
      let windows: TmuxWindow[];
      try {
        windows = await this.tmuxAdapter.listWindows(session);
      } catch (err) {
        return this.probeFailed(`list-windows for "${session}"`, err);
      }
      if (!windows.some((w) => w.index === req.toWindow)) {
        const available = windows.map((w) => w.index).join(", ") || "none";
        return {
          ok: false,
          code: "window_not_found",
          message: `Window ${req.toWindow} does not exist in session "${session}".`,
          guidance: `Available windows: ${available}.`,
        };
      }
    }

    // 4. Select the attached client to retarget.
    let clients: TmuxClient[];
    try {
      clients = await this.tmuxAdapter.listClients();
    } catch (err) {
      return this.probeFailed("list-clients", err);
    }
    if (clients.length === 0) {
      return {
        ok: false,
        code: "no_client",
        message: `No attached tmux client to retarget for seat "${req.seatRef}".`,
        guidance: attachGuidance(session),
      };
    }

    let targetClient: string;
    if (req.client) {
      const match = clients.find((cl) => cl.name === req.client);
      if (!match) {
        return {
          ok: false,
          code: "client_not_found",
          message: `No attached client named "${req.client}".`,
          guidance: "Re-run with a --client from the attached clients list.",
          clients: clients.map((cl) => ({ name: cl.name, session: cl.session })),
        };
      }
      targetClient = match.name;
    } else if (clients.length === 1) {
      targetClient = clients[0]!.name;
    } else {
      // Never silently retarget one of several humans' views — force an
      // explicit --client selection.
      return {
        ok: false,
        code: "ambiguous_client",
        message: `Multiple attached clients; specify one with --client <name>.`,
        guidance: "Re-run with --client set to one of the attached clients.",
        clients: clients.map((cl) => ({ name: cl.name, session: cl.session })),
      };
    }

    // 5. Retarget the client's VIEW (the only side effect; not a mutation of
    //    OpenRig routing/identity).
    const target = `${session}:${windowIndex}`;
    const switchResult = await this.tmuxAdapter.switchClient(targetClient, target);
    if (!switchResult.ok) {
      return {
        ok: false,
        code: "switch_failed",
        message: `tmux switch-client failed: ${switchResult.message}`,
        guidance: RECONCILE_GUIDANCE,
      };
    }

    return {
      ok: true,
      result: {
        seat_ref: req.seatRef,
        session,
        window: windowIndex,
        target,
        client: targetClient,
        mutated: false,
        retargeted: true,
      },
    };
  }
}
