import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { CmuxAdapter, CmuxResult } from "../adapters/cmux.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { tmuxAttachCommand } from "../adapters/tmux-server.js";

export type OpenCmuxAction = "focused_existing" | "created_new" | "created_helper";

export interface OpenCmuxResult {
  ok: boolean;
  action?: OpenCmuxAction;
  error?: string;
  code?: string;
}

export class NodeCmuxService {
  private tmuxAdapter: TmuxAdapter | null;
  constructor(
    private rigRepo: RigRepository,
    private sessionRegistry: SessionRegistry,
    private cmuxAdapter: CmuxAdapter,
    tmuxAdapter?: TmuxAdapter,
  ) {
    this.tmuxAdapter = tmuxAdapter ?? null;
  }

  async openOrFocusNodeSurface(rigId: string, logicalId: string): Promise<OpenCmuxResult> {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return { ok: false, error: "rig not found", code: "not_found" };

    const node = rig.nodes.find((n) => n.logicalId === logicalId);
    if (!node) return { ok: false, error: "node not found", code: "not_found" };

    const binding = node.binding;

    // For tmux-backed nodes, check liveness BEFORE any surface creation or focus.
    const isTmux = binding?.attachmentType === "tmux" && binding?.tmuxSession;
    if (isTmux && this.tmuxAdapter) {
      const alive = await this.tmuxAdapter.hasSession(binding.tmuxSession!);
      if (!alive) {
        return { ok: false, error: `tmux session '${binding.tmuxSession}' is not alive — cannot attach`, code: "session_not_found" };
      }
    }

    // Focus existing surface if already bound
    if (binding?.cmuxSurface) {
      const result = await this.cmuxAdapter.focusSurface(binding.cmuxSurface, binding.cmuxWorkspace ?? undefined);
      if (result.ok) return { ok: true, action: "focused_existing" };
      if (result.code === "unavailable") {
        return { ok: false, error: result.message, code: result.code };
      }
    }

    return this.createAndBindSurface(node.id, logicalId, binding);
  }

  private async createAndBindSurface(
    nodeId: string,
    logicalId: string,
    binding: {
      attachmentType?: string | null;
      tmuxSession?: string | null;
      externalSessionName?: string | null;
    } | null | undefined,
  ): Promise<OpenCmuxResult> {

    // Resolve a workspace anchor for the new surface. OPR.0.4.1.31 part A —
    // node open-in-cmux previously anchored ONLY on currentWorkspace(), so when
    // no cmux workspace was current EVERY unbound row failed before the
    // node-specific attach (only rig-level Launch-in-CMUX created one). Now we
    // resolve an anchor: current if present, else select an existing workspace,
    // else create + select one, so the surface lands in a VISIBLE workspace.
    const wsResult = await this.resolveWorkspaceAnchor();
    if (!wsResult.ok) return { ok: false, error: wsResult.message, code: wsResult.code };

    // Create a new terminal surface
    const createResult = await this.cmuxAdapter.createTerminalSurface(wsResult.data);
    if (!createResult.ok) return { ok: false, error: createResult.message, code: createResult.code };

    const newSurfaceId = createResult.data;

    // Session name from binding or logical id
    const sessionName = binding?.tmuxSession ?? binding?.externalSessionName ?? logicalId;

    // tmux-backed: attach into tmux (liveness already checked in openOrFocusNodeSurface).
    // Defer binding persistence until AFTER attach + focus succeed so a failed
    // attach never leaves a stale cmuxSurface that a retry would focus as
    // focused_existing without re-attaching.
    const isTmux = binding?.attachmentType === "tmux" && binding?.tmuxSession;
    if (isTmux) {
      const sendResult = await this.cmuxAdapter.sendText(newSurfaceId, `${tmuxAttachCommand(sessionName)}\n`, wsResult.data);
      if (!sendResult.ok) return { ok: false, error: sendResult.message, code: sendResult.code };
      const focusResult = await this.cmuxAdapter.focusSurface(newSurfaceId, wsResult.data);
      if (!focusResult.ok) return { ok: false, error: focusResult.message, code: focusResult.code };
      this.sessionRegistry.updateBinding(nodeId, {
        cmuxWorkspace: wsResult.data,
        cmuxSurface: newSurfaceId,
      });
      return { ok: true, action: "created_new" };
    }

    // External-cli / no tmux: honest helper console. Defer binding
    // persistence until after helper text + focus succeed (same rule as tmux).
    const helperText = [
      `# Helper console for ${sessionName}`,
      `# This node is externally attached — no direct terminal session available.`,
      `# Useful commands:`,
      `rig capture ${sessionName}`,
      `rig transcript ${sessionName} --tail 100`,
      `rig send ${sessionName} "..." --verify`,
    ].join("\n");
    const sendResult = await this.cmuxAdapter.sendText(newSurfaceId, helperText, wsResult.data);
    if (!sendResult.ok) return { ok: false, error: sendResult.message, code: sendResult.code };
    const focusResult = await this.cmuxAdapter.focusSurface(newSurfaceId, wsResult.data);
    if (!focusResult.ok) return { ok: false, error: focusResult.message, code: focusResult.code };
    this.sessionRegistry.updateBinding(nodeId, {
      cmuxWorkspace: wsResult.data,
      cmuxSurface: newSurfaceId,
    });
    return { ok: true, action: "created_helper" };
  }

  // OPR.0.4.1.31 part A — resolve a workspace to anchor a new surface in.
  // (1) Use the current workspace if cmux has one. (2) If cmux is unreachable,
  // propagate the honest error — there's no anchor to resolve. (3) Otherwise
  // (cmux open but no current workspace) create one: cmux opens a NEW workspace
  // as the active/visible one (the `cmux <path>` / new-workspace model), so the
  // surface we then create lands where the operator is looking.
  //
  // Deliberately uses ONLY transport-allowlisted, binary-verified methods
  // (workspace.current + workspace.create). We do NOT call workspace.select: the
  // cmux CLI exposes no select-workspace command and our cmux transport does not
  // allow that RPC, so calling it would throw on the real path (dev1-guard B1).
  // The official socket API lists workspace.select, but the external docs are not
  // sufficient — the integration surface must actually expose it. If create
  // fails, the honest error surfaces (the operator can use rig-level Launch-in-CMUX).
  private async resolveWorkspaceAnchor(): Promise<CmuxResult<string>> {
    const current = await this.cmuxAdapter.currentWorkspace();
    if (current.ok) return current;
    if (current.code === "unavailable") return current;
    return this.cmuxAdapter.createWorkspace("OpenRig");
  }
}
