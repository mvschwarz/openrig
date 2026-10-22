// OPR.0.7.0.9: the lines both the seat view (`rig skill loadout --seat`) and the printed fresh-launch plan
// (`rig seat launch --plan`) show for a seat's own launch additions, so neither surface hides one.

export interface SeatLaunchAdditionsView {
  agent?: string;
  /** Whether the agent's prompt is non-empty, which replaces Claude's default system prompt when it runs as the main agent. */
  agentPromptReplacesDefault?: boolean;
  appendSystemPromptFile?: string;
  pluginDirs: string[];
  missing: string[];
  refused: string[];
}

export function seatLaunchAdditionLines(additions: SeatLaunchAdditionsView | null | undefined): string[] {
  if (!additions) return [];
  return [
    ...(additions.agent ? [`agent       ${additions.agent} (--agent${additions.agentPromptReplacesDefault ? "; its prompt replaces Claude's default system prompt" : ""})`] : []),
    ...(additions.appendSystemPromptFile ? [`prompt      ${additions.appendSystemPromptFile} (--append-system-prompt-file)`] : []),
    ...additions.pluginDirs.map((dir) => `plugin dir  ${dir} (CLAUDE_CODE_PLUGIN_DIRS)`),
    ...additions.missing.map((file) => `missing     ${file}: not passed to the launch`),
    ...additions.refused.map((reason) => `refused     ${reason}: not passed to the launch`),
  ];
}
