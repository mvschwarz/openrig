// The binary's fast path: `rig <command> …` imports only that command's module, instead of the
// ~85 that createProgram() imports, so a seat's `rig queue list` no longer pays for the MCP SDK,
// ajv or the daemon's mission code. Anything else (no argument, help, an unknown name) is left to
// the full program, whose root help and suggestions need every command.
import { Command } from "commander";
import { configureRoot } from "./program-root.js";

// The wrapper runs the program with this runProgram, from beside the commands, so it loads after the compile cache
// is on and its daemon-error checks see the client module the commands throw from.
export { runProgram } from "./cli-error.js";

type Load = () => Promise<Command>;

/** Each top-level command by its name, in createProgram()'s order (a test keeps them equal). */
export const COMMAND_LOADERS: ReadonlyMap<string, Load> = new Map<string, Load>([
  ["start", async () => (await import("./commands/start.js")).startCommand()],
  ["daemon", async () => (await import("./commands/daemon.js")).daemonCommand()],
  ["status", async () => (await import("./commands/status.js")).statusCommand()],
  ["snapshot", async () => (await import("./commands/snapshot.js")).snapshotCommand()],
  ["restore", async () => (await import("./commands/restore.js")).restoreCommand()],
  ["crash-cart", async () => (await import("./commands/crash-cart.js")).crashCartCommand()],
  ["gateway", async () => (await import("./commands/gateway.js")).gatewayCommand()],
  ["parked", async () => (await import("./commands/parked.js")).parkedCommand()],
  ["export", async () => (await import("./commands/export.js")).exportCommand()],
  ["import", async () => (await import("./commands/import.js")).importCommand()],
  ["ui", async () => (await import("./commands/ui.js")).uiCommand()],
  ["tui", async () => (await import("./commands/tui.js")).tuiCommand()],
  ["package", async () => (await import("./commands/package.js")).packageCommand()],
  ["bootstrap", async () => (await import("./commands/bootstrap.js")).bootstrapCommand()],
  ["requirements", async () => (await import("./commands/requirements.js")).requirementsCommand()],
  ["discover", async () => (await import("./commands/discover.js")).discoverCommand()],
  ["attach", async () => (await import("./commands/attach.js")).attachCommand()],
  ["bind", async () => (await import("./commands/bind.js")).bindCommand()],
  ["adopt", async () => (await import("./commands/adopt.js")).adoptCommand()],
  ["bundle", async () => (await import("./commands/bundle.js")).bundleCommand()],
  ["up", async () => (await import("./commands/up.js")).upCommand()],
  ["down", async () => (await import("./commands/down.js")).downCommand()],
  ["archive", async () => (await import("./commands/archive.js")).archiveCommand()],
  ["unarchive", async () => (await import("./commands/unarchive.js")).unarchiveCommand()],
  ["host", async () => (await import("./commands/host.js")).hostCommand()],
  ["ps", async () => (await import("./commands/ps.js")).psCommand()],
  ["roster", async () => (await import("./commands/roster.js")).rosterCommand()],
  ["mcp", async () => (await import("./commands/mcp.js")).mcpCommand()],
  ["agent", async () => (await import("./commands/agent.js")).agentCommand()],
  ["spec", async () => (await import("./commands/rig.js")).rigCommand()],
  ["transcript", async () => (await import("./commands/transcript.js")).transcriptCommand()],
  ["send", async () => (await import("./commands/send.js")).sendCommand()],
  ["stream", async () => (await import("./commands/stream.js")).streamCommand()],
  ["queue", async () => (await import("./commands/queue.js")).queueCommand()],
  ["slack", async () => (await import("./commands/slack.js")).slackCommand()],
  ["project", async () => (await import("./commands/project.js")).projectCommand()],
  ["view", async () => (await import("./commands/view.js")).viewCommand()],
  ["terminal", async () => (await import("./commands/terminal.js")).terminalCommand()],
  ["watchdog", async () => (await import("./commands/watchdog.js")).watchdogCommand()],
  ["workflow", async () => (await import("./commands/workflow.js")).workflowCommand()],
  ["capture", async () => (await import("./commands/capture.js")).captureCommand()],
  ["broadcast", async () => (await import("./commands/broadcast.js")).broadcastCommand()],
  ["walk", async () => (await import("./commands/walk.js")).walkCommand()],
  ["ask", async () => (await import("./commands/ask.js")).askCommand()],
  ["chatroom", async () => (await import("./commands/chatroom.js")).chatroomCommand()],
  ["specs", async () => (await import("./commands/specs.js")).specsCommand()],
  ["context", async () => (await import("./commands/context.js")).contextCommand()],
  ["plugin", async () => (await import("./commands/plugin.js")).pluginCommand()],
  ["skill", async () => (await import("./commands/skill.js")).skillCommand()],
  ["agent-image", async () => (await import("./commands/agent-image.js")).agentImageCommand()],
  ["community-harness", async () => (await import("./commands/community-harness.js")).communityHarnessCommand()],
  ["fork", async () => (await import("./commands/fork.js")).forkCommand()],
  ["workspace", async () => (await import("./commands/workspace.js")).workspaceCommand()],
  ["mode", async () => (await import("./commands/rig-mode.js")).rigModeCommand()],
  ["policy", async () => (await import("./commands/policy.js")).policyCommand()],
  ["whoami", async () => (await import("./commands/whoami.js")).whoamiCommand()],
  ["config", async () => (await import("./commands/config.js")).configCommand()],
  ["file", async () => (await import("./commands/file.js")).fileCommand()],
  ["preflight", async () => (await import("./commands/preflight.js")).preflightCommand()],
  ["auth", async () => (await import("./commands/auth.js")).authCommand()],
  ["provider", async () => (await import("./commands/provider.js")).providerCommand()],
  ["usage", async () => (await import("./commands/usage.js")).usageCommand()],
  ["telemetry", async () => (await import("./commands/telemetry.js")).telemetryCommand()],
  ["health", async () => (await import("./commands/health.js")).healthCommand()],
  ["doctor", async () => (await import("./commands/doctor.js")).doctorCommand()],
  ["expand", async () => (await import("./commands/expand.js")).expandCommand()],
  ["add", async () => (await import("./commands/add.js")).addMemberCommand()],
  ["create", async () => (await import("./commands/create.js")).createCommand()],
  ["grow", async () => (await import("./commands/grow.js")).growCommand()],
  ["reconcile-session", async () => (await import("./commands/reconcile-session.js")).reconcileSessionCommand()],
  ["env", async () => (await import("./commands/env.js")).envCommand()],
  ["unclaim", async () => (await import("./commands/unclaim.js")).unclaimCommand()],
  ["release", async () => (await import("./commands/release.js")).releaseCommand()],
  ["launch", async () => (await import("./commands/launch.js")).launchCommand()],
  ["remove", async () => (await import("./commands/remove.js")).removeCommand()],
  ["shrink", async () => (await import("./commands/shrink.js")).shrinkCommand()],
  ["destroy", async () => (await import("./commands/destroy.js")).destroyCommand()],
  ["setup", async () => (await import("./commands/setup.js")).setupCommand()],
  ["restore-check", async () => (await import("./commands/restore-check.js")).restoreCheckCommand()],
  ["restore-packet", async () => (await import("./commands/restore-packet.js")).restorePacketCommand()],
  ["compact-plan", async () => (await import("./commands/compact-plan.js")).compactPlanCommand()],
  ["compact", async () => (await import("./commands/compact.js")).compactCommand()],
  ["heartbeat", async () => (await import("./commands/heartbeat.js")).heartbeatCommand()],
  ["seat", async () => (await import("./commands/seat.js")).seatCommand()],
  ["handover", async () => (await import("./commands/seat.js")).handoverCommand()],
  ["startup-proof", async () => (await import("./commands/startup-proof.js")).startupProofCommand()],
  ["scope", async () => (await import("./commands/scope.js")).scopeCommand()],
  ["proof", async () => (await import("./commands/proof.js")).proofCommand()],
]);

/** The program for `rig <first> …` with only what that call needs: the bare root for
 *  `--version`, the root and that one command for a known name; null for everything else. */
export async function createLazyProgram(first: string | undefined): Promise<Command | null> {
  if (first === "--version" || first === "-V") return configureRoot(new Command());
  const load = first === undefined ? undefined : COMMAND_LOADERS.get(first);
  if (!load) return null;
  return configureRoot(new Command()).addCommand(await load());
}
