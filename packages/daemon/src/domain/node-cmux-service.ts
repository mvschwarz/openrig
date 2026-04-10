import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { CmuxAdapter } from "../adapters/cmux.js";

export type OpenCmuxAction = "focused_existing" | "created_new" | "created_helper";

export interface OpenCmuxResult {
  ok: boolean;
  action?: OpenCmuxAction;
  error?: string;
  code?: string;
}

export class NodeCmuxService {
  constructor(
    private rigRepo: RigRepository,
    private sessionRegistry: SessionRegistry,
    private cmuxAdapter: CmuxAdapter,
  ) {}

  async openOrFocusNodeSurface(rigId: string, logicalId: string): Promise<OpenCmuxResult> {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return { ok: false, error: "rig not found", code: "not_found" };

    const node = rig.nodes.find((n) => n.logicalId === logicalId);
    if (!node) return { ok: false, error: "node not found", code: "not_found" };

    const binding = node.binding;

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

    // Get current workspace as creation anchor
    const wsResult = await this.cmuxAdapter.currentWorkspace();
    if (!wsResult.ok) return { ok: false, error: wsResult.message, code: wsResult.code };

    // Create a new terminal surface
    const createResult = await this.cmuxAdapter.createTerminalSurface(wsResult.data);
    if (!createResult.ok) return { ok: false, error: createResult.message, code: createResult.code };

    const newSurfaceId = createResult.data;

    // Persist binding
    this.sessionRegistry.updateBinding(nodeId, {
      cmuxWorkspace: wsResult.data,
      cmuxSurface: newSurfaceId,
    });

    // Session name from binding or logical id
    const sessionName = binding?.tmuxSession ?? binding?.externalSessionName ?? logicalId;

    // tmux-backed: attach into tmux
    const isTmux = binding?.attachmentType === "tmux" && binding?.tmuxSession;
    if (isTmux) {
      const sendResult = await this.cmuxAdapter.sendText(newSurfaceId, `tmux attach -t ${binding.tmuxSession}\n`, wsResult.data);
      if (!sendResult.ok) return { ok: false, error: sendResult.message, code: sendResult.code };
      const focusResult = await this.cmuxAdapter.focusSurface(newSurfaceId, wsResult.data);
      if (!focusResult.ok) return { ok: false, error: focusResult.message, code: focusResult.code };
      return { ok: true, action: "created_new" };
    }

    // External-cli / no tmux: honest helper console
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
    return { ok: true, action: "created_helper" };
  }
}
