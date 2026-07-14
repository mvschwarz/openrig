// Slice 24 — CmuxLayoutService.
//
// Algorithmic core of the "Launch in CMUX" feature. Three pure helpers
// (computeLayout / chunkAgents / orderAgentsFromRigSpec) + the
// coordinated grid builder (buildWorkspacePanes, with buildWorkspace as
// its tmux-attach wrapper) that drives the CmuxAdapter through
// workspace.create + N-1 surface.split + N surface.sendText calls to
// populate a freshly-created cmux workspace with one panel per agent.
// The terminal-provider ride reuses the same core with composer-built
// pane commands (read-only -r / ssh-wrap preserved).
//
// Timing strategy (per slice 24 README §Daemon-side + cmux-rig-layout
// skill §5 gotchas):
//   - After every splitSurface, wait OP_DELAY_MS so the freshly-created
//     surface's shell reaches its prompt before the next operation
//     (skill §5 gotcha 3 — surface-not-ready-for-input window).
//   - After the LAST sendText, wait FINAL_SETTLE_MS to defeat the
//     last-send-key race (skill §5 gotcha 2).
//   - listSurfaces immediately after createWorkspace retries with
//     small backoff to absorb the workspace-default-surface attach
//     latency. The default surface is created by cmux daemon at
//     workspace.create time but the listing may not reflect it for
//     a beat.
// Sleep is injected via constructor so tests stub it to no-op.
//
// Constants live at the top of the file per slice 24 README §Layout
// algorithm §"Configurability posture". v0 ships them as hardcoded
// constants; v0.3.2 follow-on graduates to settings keys.
//
// TODO(0.3.2): graduate MAX_COLS + MAX_PER_WORKSPACE to settings keys
// cmux.workspace_columns + cmux.workspace_max_panels (slice 08 settings
// infra is ready; this is a 2-keys-plus-optional-UI-surface follow-on).

import type { CmuxAdapter, CmuxResult } from "../adapters/cmux.js";

export const MAX_COLS = 2;
export const MAX_PER_WORKSPACE = 12;
export const OP_DELAY_MS = 500;
export const FINAL_SETTLE_MS = 1000;
export const LIST_SURFACES_RETRY_DELAY_MS = 100;
export const LIST_SURFACES_MAX_ATTEMPTS = 5;
export const EQUALIZE_PASSES = 2;
export const EQUALIZE_SETTLE_MS = 1200;

export type SleepFn = (ms: number) => Promise<void>;

/**
 * The modal Auto-grid column count for N panes. MUST mirror the UI's
 * TerminalLauncher `suggestLayout` (PM ruling: the applied cmux grid matches
 * the modal preview — N=7 → 3×3, never 2×4). Kept here because the daemon
 * cannot import from packages/ui; a drift is a bug in whichever side changed.
 */
export function autoGridCols(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

const defaultSleep: SleepFn = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface LayoutShape {
  rows: number;
  cols: number;
  blanks: number;
}

export interface BuildWorkspaceResult {
  workspaceId: string;
  workspaceName: string;
  agents: string[];
  blanks: number;
}

export interface BuildWorkspacePanesResult {
  workspaceId: string;
  workspaceName: string;
  paneCount: number;
  blanks: number;
  /**
   * Observability only — NOT the acceptance signal (VM-proven: cmux can
   * report equalized:true while later layout churn restores binary sizes;
   * final pane frames are the acceptance). True = at least one equalize pass
   * reported a rebalance; false = no pass did. Absent = not applicable
   * (no equalize needed for this shape).
   */
  equalized?: boolean;
}

export interface RigSpecLike {
  pods?: Array<{
    id: string;
    members?: Array<{ id: string }>;
  }>;
}

export interface CmuxLayoutServiceOptions {
  sleep?: SleepFn;
}

export class CmuxLayoutService {
  private readonly sleep: SleepFn;

  constructor(private cmuxAdapter: CmuxAdapter, opts: CmuxLayoutServiceOptions = {}) {
    this.sleep = opts.sleep ?? defaultSleep;
  }

  static computeLayout(n: number): LayoutShape {
    if (n === 1) {
      // Guard n here so the 1×1 fast path still rejects non-integers upstream.
      return CmuxLayoutService.computeGridLayout(n, 1);
    }
    return CmuxLayoutService.computeGridLayout(n, MAX_COLS);
  }

  /** Grid shape for N panes at an explicit column count (clamped to N). */
  static computeGridLayout(n: number, cols: number): LayoutShape {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`CmuxLayoutService.computeLayout: N must be a positive integer (got ${n})`);
    }
    if (n > MAX_PER_WORKSPACE) {
      throw new Error(
        `CmuxLayoutService.computeLayout: N=${n} exceeds MAX_PER_WORKSPACE=${MAX_PER_WORKSPACE}; caller should chunk first`,
      );
    }
    if (!Number.isInteger(cols) || cols <= 0) {
      throw new Error(`CmuxLayoutService.computeGridLayout: cols must be a positive integer (got ${cols})`);
    }
    const effectiveCols = Math.min(cols, n);
    const rows = Math.ceil(n / effectiveCols);
    const blanks = rows * effectiveCols - n;
    return { rows, cols: effectiveCols, blanks };
  }

  static chunkAgents<T>(agents: T[]): T[][] {
    if (agents.length === 0) return [];
    const chunks: T[][] = [];
    for (let i = 0; i < agents.length; i += MAX_PER_WORKSPACE) {
      chunks.push(agents.slice(i, i + MAX_PER_WORKSPACE));
    }
    return chunks;
  }

  static orderAgentsFromRigSpec(rigSpec: RigSpecLike): string[] {
    const out: string[] = [];
    for (const pod of rigSpec.pods ?? []) {
      for (const member of pod.members ?? []) {
        out.push(`${pod.id}.${member.id}`);
      }
    }
    return out;
  }

  async buildWorkspace(
    workspaceName: string,
    cwd: string | undefined,
    agentSessions: string[],
  ): Promise<CmuxResult<BuildWorkspaceResult>> {
    const built = await this.buildWorkspacePanes(
      workspaceName,
      cwd,
      agentSessions.map((session) => `tmux attach -t ${session}`),
    );
    if (!built.ok) return built;
    return {
      ok: true,
      data: {
        workspaceId: built.data.workspaceId,
        workspaceName,
        agents: agentSessions.slice(),
        blanks: built.data.blanks,
      },
    };
  }

  /**
   * Command-level grid builder (the shared core). Same one-workspace grid as
   * buildWorkspace, but each pane runs an arbitrary caller-composed shell
   * command verbatim (+ trailing newline) — the terminal-provider ride's
   * `paneCommand` contract (read-only `-r`, ssh-wrap, quoting preserved).
   *
   * `cols` overrides the column count (the terminal launcher passes the modal
   * Auto-grid `autoGridCols(N)` — PM ruling: the applied grid must match the
   * modal preview). Omitted → the legacy 2-column rig-launch shape.
   */
  async buildWorkspacePanes(
    workspaceName: string,
    cwd: string | undefined,
    paneCommands: string[],
    cols?: number,
  ): Promise<CmuxResult<BuildWorkspacePanesResult>> {
    if (paneCommands.length === 0) {
      const ws = await this.cmuxAdapter.createWorkspace(workspaceName, cwd);
      if (!ws.ok) return ws;
      return {
        ok: true,
        data: { workspaceId: ws.data, workspaceName, paneCount: 0, blanks: 0 },
      };
    }

    if (paneCommands.length > MAX_PER_WORKSPACE) {
      return {
        ok: false,
        code: "invalid_input",
        message: `buildWorkspace: ${paneCommands.length} agents exceeds MAX_PER_WORKSPACE=${MAX_PER_WORKSPACE}; caller should chunk first`,
      };
    }

    const layout =
      cols != null
        ? CmuxLayoutService.computeGridLayout(paneCommands.length, cols)
        : CmuxLayoutService.computeLayout(paneCommands.length);

    // 1. Create the workspace.
    const wsResult = await this.cmuxAdapter.createWorkspace(workspaceName, cwd);
    if (!wsResult.ok) return wsResult;
    const workspaceId = wsResult.data;

    // 2. Discover the workspace's default surface. workspace.create
    //    auto-creates one terminal surface but the listing may not
    //    reflect it immediately. Retry with small backoff (skill §5
    //    gotcha 3 — surface-not-ready-for-input window also applies
    //    to surface enumeration).
    const initialSurface = await this.discoverInitialSurface(workspaceId);
    if (!initialSurface.ok) return initialSurface;

    // 3. Build the grid. grid[col][row] holds the surface id. Layout
    //    shape determines the split sequence:
    //    - col 1: the initial surface + (rows-1) down splits below it
    //    - each further column: 1 right split off the previous column's
    //      top surface + (rows-1) down splits
    //    Sleep OP_DELAY_MS after every split so the freshly created
    //    surface's shell reaches its prompt before the next op.
    const grid: string[][] = [[initialSurface.data]];

    for (let c = 1; c < layout.cols; c++) {
      const rightSplit = await this.cmuxAdapter.splitSurface(
        grid[c - 1]![0]!,
        "right",
        workspaceId,
      );
      if (!rightSplit.ok) return rightSplit;
      grid.push([rightSplit.data]);
      await this.sleep(OP_DELAY_MS);
    }

    for (let r = 1; r < layout.rows; r++) {
      for (let c = 0; c < layout.cols; c++) {
        const prevSurfaceInCol = grid[c]![r - 1]!;
        const downSplit = await this.cmuxAdapter.splitSurface(
          prevSurfaceInCol,
          "down",
          workspaceId,
        );
        if (!downSplit.ok) return downSplit;
        grid[c]!.push(downSplit.data);
        await this.sleep(OP_DELAY_MS);
      }
    }

    // 4. Send each pane's command to its surface in COLUMN-MAJOR
    //    order: fill column 0 top-to-bottom first, then column 1
    //    top-to-bottom. Matches README §52 "Fill ... (top-to-bottom,
    //    left-to-right)" — each column's contents in reading order,
    //    moving left-to-right across columns.
    //    Any unpopulated surfaces in column 1's last row(s) remain
    //    as "blanks" (cmux still shows them as empty terminals).
    let paneIndex = 0;
    for (let c = 0; c < layout.cols && paneIndex < paneCommands.length; c++) {
      for (let r = 0; r < layout.rows && paneIndex < paneCommands.length; r++) {
        const surface = grid[c]![r]!;
        const command = paneCommands[paneIndex]!;
        const sendResult = await this.cmuxAdapter.sendText(
          surface,
          `${command}\n`,
          workspaceId,
        );
        if (!sendResult.ok) return sendResult;
        paneIndex += 1;
      }
    }

    // 5. Final settle. Per skill §5 gotcha 2 the very last send-key
    //    can drop if the script exits immediately; the sleep
    //    guarantees the terminal flushes the Enter character.
    await this.sleep(FINAL_SETTLE_MS);

    // 6. Equalize — explicit-cols Auto-grid only (legacy 2-col rig-launch
    //    stays byte-identical), for grids beyond 2 in either dimension
    //    (successive 50/50 binary splits land 50/25/25). VM-proven (PM
    //    ruling): equalization must run AFTER every pane command has landed
    //    and the workspace settled — an early call can even report
    //    equalized:true and still end 2:1:1 once later layout churn restores
    //    binary sizes. So: a fixed number of passes with a settle delay
    //    between them, never early-exiting on the RPC boolean. The boolean is
    //    observability only; acceptance is final pane-frame geometry.
    //    Non-fatal by design: an unequalized grid degrades sizing only,
    //    never the panes.
    let equalized: boolean | undefined;
    if (cols != null && (layout.cols > 2 || layout.rows > 2)) {
      equalized = false;
      for (let pass = 0; pass < EQUALIZE_PASSES; pass++) {
        const eq = await this.cmuxAdapter.equalizeSplits(workspaceId);
        if (eq.ok && eq.data.equalized) equalized = true;
        if (pass < EQUALIZE_PASSES - 1) {
          await this.sleep(EQUALIZE_SETTLE_MS);
        }
      }
    }

    return {
      ok: true,
      data: {
        workspaceId,
        workspaceName,
        paneCount: paneCommands.length,
        blanks: layout.blanks,
        ...(equalized !== undefined ? { equalized } : {}),
      },
    };
  }

  private async discoverInitialSurface(workspaceId: string): Promise<CmuxResult<string>> {
    for (let attempt = 0; attempt < LIST_SURFACES_MAX_ATTEMPTS; attempt++) {
      const result = await this.cmuxAdapter.listSurfaces(workspaceId);
      if (!result.ok) return result;
      if (result.data.length > 0) {
        return { ok: true, data: result.data[0]!.id };
      }
      if (attempt < LIST_SURFACES_MAX_ATTEMPTS - 1) {
        await this.sleep(LIST_SURFACES_RETRY_DELAY_MS);
      }
    }
    return {
      ok: false,
      code: "request_failed",
      message: `buildWorkspace: workspace ${workspaceId} had no default surface after ${LIST_SURFACES_MAX_ATTEMPTS} attempts; cmux daemon may not be ready`,
    };
  }
}
