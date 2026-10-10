import { shellQuote } from "./shell-quote.js";

interface LaunchChoice {
  nonInterruptive?: boolean;
  launchPosture?: "floor" | "full_bypass" | "auto";
  permissionMode?: string;
}

/** Per-launch overrides only. This choice never changes permissions or native settings files.
 * Claude Code 2.1.282 and Codex 0.153.4 expose these settings on their CLI surfaces.
 */
export function nonInterruptiveArgs(runtime: string, choice: LaunchChoice): string[] {
  if (!choice.nonInterruptive || choice.launchPosture !== "full_bypass") return [];
  if (runtime === "claude-code") {
    // An explicit native selection overrides the declarative posture.
    if (choice.permissionMode && choice.permissionMode !== "bypassPermissions") return [];
    return ["--settings", '{"skipDangerousModePermissionPrompt":true}'];
  }
  if (runtime === "codex") return [
    "-c", "notice.hide_full_access_warning=true",
    "-c", "notice.hide_gpt5_1_migration_prompt=true",
    // Codex 0.153.4 splits override paths on every dot, even inside quotes.
    // Leave the dotted GPT-5.1-Codex-Max notice key unchanged.
  ];
  return [];
}

export function nonInterruptiveArg(runtime: string, choice: LaunchChoice): string {
  return nonInterruptiveArgs(runtime, choice).map(arg => ` ${shellQuote(arg)}`).join("");
}

export function nonInterruptiveNotice(runtime: string, choice: LaunchChoice): string | undefined {
  if (!nonInterruptiveArgs(runtime, choice).length) return undefined;
  return `Non-interruptive: OpenRig ${runtime === "claude-code"
    ? "accepted Claude's bypass-permissions warning"
    : "hid Codex's full-access and GPT-5.1 migration notices"} for this seat using launch flags. The saved choice applies to this rig's launches only; no warning-acceptance settings were written.`;
}

export function nonInterruptiveSummary(enabled: boolean): string {
  return enabled
    ? "Non-interruptive mode is saved for this rig and remains in effect on later launches and restores. Only full-bypass Claude and Codex seats receive warning flags; other seats are unchanged. To clear this rig's choice, first run rig down <rig-name>, then rig up <rig-name> --existing --no-non-interruptive."
    : "Non-interruptive mode is off for this rig's launches; OpenRig will not pass warning-acceptance flags. This does not erase warnings you previously accepted in the harness.";
}
