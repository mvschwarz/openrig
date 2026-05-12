// Slice 24 — CmuxLayoutService.
//
// Algorithmic core of the "Launch in CMUX" feature. Three pure helpers
// (computeLayout / chunkAgents / orderAgentsFromRigSpec) + one
// coordinated method (buildWorkspace) that drives the CmuxAdapter
// through workspace.create + N-1 surface.split + N surface.sendText
// calls to populate a freshly-created cmux workspace with one tmux-
// attach panel per agent.
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

export interface RigSpecLike {
  pods?: Array<{
    id: string;
    members?: Array<{ id: string }>;
  }>;
}

export class CmuxLayoutService {
  constructor(private cmuxAdapter: CmuxAdapter) {}

  static computeLayout(n: number): LayoutShape {
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`CmuxLayoutService.computeLayout: N must be a positive integer (got ${n})`);
    }
    if (n > MAX_PER_WORKSPACE) {
      throw new Error(
        `CmuxLayoutService.computeLayout: N=${n} exceeds MAX_PER_WORKSPACE=${MAX_PER_WORKSPACE}; caller should chunk first`,
      );
    }
    if (n === 1) {
      return { rows: 1, cols: 1, blanks: 0 };
    }
    const cols = MAX_COLS;
    const rows = Math.ceil(n / cols);
    const blanks = rows * cols - n;
    return { rows, cols, blanks };
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
    // Empty agent list: still create the workspace (operator may want
    // an empty workspace named after the rig) but skip the layout
    // entirely.
    if (agentSessions.length === 0) {
      const ws = await this.cmuxAdapter.createWorkspace(workspaceName, cwd);
      if (!ws.ok) return ws;
      return {
        ok: true,
        data: { workspaceId: ws.data, workspaceName, agents: [], blanks: 0 },
      };
    }

    if (agentSessions.length > MAX_PER_WORKSPACE) {
      return {
        ok: false,
        code: "invalid_input",
        message: `buildWorkspace: ${agentSessions.length} agents exceeds MAX_PER_WORKSPACE=${MAX_PER_WORKSPACE}; caller should chunk first`,
      };
    }

    const layout = CmuxLayoutService.computeLayout(agentSessions.length);

    // 1. Create the workspace.
    const wsResult = await this.cmuxAdapter.createWorkspace(workspaceName, cwd);
    if (!wsResult.ok) return wsResult;
    const workspaceId = wsResult.data;

    // 2. Discover the workspace's default surface (workspace.create
    //    auto-creates one terminal surface). listSurfaces returns it.
    const surfacesResult = await this.cmuxAdapter.listSurfaces(workspaceId);
    if (!surfacesResult.ok) return surfacesResult;
    if (surfacesResult.data.length === 0) {
      return {
        ok: false,
        code: "request_failed",
        message: `buildWorkspace: workspace ${workspaceId} has no default surface to anchor splits`,
      };
    }
    const initialSurface = surfacesResult.data[0]!.id;

    // 3. Build the grid surface list. Layout shape determines split sequence:
    //    - col 1: 1 initial surface + (rows-1) down splits below it
    //    - col 2: 1 right split off initial + (rows-1) down splits below each
    //    Result: rows × cols surfaces, laid out top-to-bottom left-to-right.
    const grid: string[][] = [[initialSurface]];

    // Add col 2 by splitting right off col 1's top surface.
    if (layout.cols === 2) {
      const rightSplit = await this.cmuxAdapter.splitSurface(initialSurface, "right", workspaceId);
      if (!rightSplit.ok) return rightSplit;
      grid.push([rightSplit.data]);
    }

    // Add rows 2..R by splitting down off the previous row's surface
    // in each column.
    for (let r = 1; r < layout.rows; r++) {
      for (let c = 0; c < layout.cols; c++) {
        const prevSurfaceInCol = grid[c]![r - 1]!;
        const downSplit = await this.cmuxAdapter.splitSurface(prevSurfaceInCol, "down", workspaceId);
        if (!downSplit.ok) return downSplit;
        grid[c]!.push(downSplit.data);
      }
    }

    // 4. Send tmux-attach to each agent's surface, top-to-bottom
    //    left-to-right, until agents are exhausted (blanks remain
    //    unpopulated in the grid's last row).
    let agentIndex = 0;
    for (let r = 0; r < layout.rows && agentIndex < agentSessions.length; r++) {
      for (let c = 0; c < layout.cols && agentIndex < agentSessions.length; c++) {
        const surface = grid[c]![r]!;
        const session = agentSessions[agentIndex]!;
        const sendResult = await this.cmuxAdapter.sendText(
          surface,
          `tmux attach -t ${session}\n`,
          workspaceId,
        );
        if (!sendResult.ok) return sendResult;
        agentIndex += 1;
      }
    }

    return {
      ok: true,
      data: {
        workspaceId,
        workspaceName,
        agents: agentSessions.slice(),
        blanks: layout.blanks,
      },
    };
  }
}
