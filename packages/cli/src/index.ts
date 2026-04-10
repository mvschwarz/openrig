#!/usr/bin/env node
import { Command } from "commander";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { daemonCommand } from "./commands/daemon.js";
import { statusCommand, type StatusDeps } from "./commands/status.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { restoreCommand } from "./commands/restore.js";
import { exportCommand, type ExportDeps } from "./commands/export.js";
import { importCommand, type ImportDeps } from "./commands/import.js";
import { uiCommand, type UiDeps } from "./commands/ui.js";
import { packageCommand } from "./commands/package.js";
import { bootstrapCommand } from "./commands/bootstrap.js";
import { requirementsCommand } from "./commands/requirements.js";
import { discoverCommand } from "./commands/discover.js";
import { attachCommand } from "./commands/attach.js";
import { bindCommand } from "./commands/bind.js";
import { adoptCommand, type AdoptDeps } from "./commands/adopt.js";
import { bundleCommand } from "./commands/bundle.js";
import { upCommand } from "./commands/up.js";
import { downCommand } from "./commands/down.js";
import { psCommand } from "./commands/ps.js";
import { mcpCommand } from "./commands/mcp.js";
import { agentCommand, type AgentDeps } from "./commands/agent.js";
import { rigCommand, type RigDeps } from "./commands/rig.js";
import { transcriptCommand } from "./commands/transcript.js";
import { sendCommand } from "./commands/send.js";
import { captureCommand } from "./commands/capture.js";
import { broadcastCommand } from "./commands/broadcast.js";
import { configCommand } from "./commands/config.js";
import { preflightCommand } from "./commands/preflight.js";
import { doctorCommand } from "./commands/doctor.js";
import { expandCommand } from "./commands/expand.js";
import { envCommand } from "./commands/env.js";
import { askCommand } from "./commands/ask.js";
import { chatroomCommand } from "./commands/chatroom.js";
import { specsCommand } from "./commands/specs.js";
import { whoamiCommand } from "./commands/whoami.js";
import { unclaimCommand } from "./commands/unclaim.js";
import { releaseCommand } from "./commands/release.js";
import { launchCommand } from "./commands/launch.js";
import { removeCommand } from "./commands/remove.js";
import { shrinkCommand } from "./commands/shrink.js";
import { destroyCommand, type DestroyCommandDeps } from "./commands/destroy.js";
import type { LifecycleDeps } from "./daemon-lifecycle.js";
import { CLI_VERSION } from "./version.js";

export interface ProgramDeps {
  daemonDeps?: LifecycleDeps;
  statusDeps?: StatusDeps;
  snapshotDeps?: StatusDeps;
  restoreDeps?: StatusDeps;
  uiDeps?: UiDeps;
  exportDeps?: ExportDeps;
  importDeps?: ImportDeps;
  packageDeps?: StatusDeps;
  bootstrapDeps?: StatusDeps;
  requirementsDeps?: StatusDeps;
  discoverDeps?: StatusDeps;
  attachDeps?: StatusDeps;
  bindDeps?: StatusDeps;
  adoptDeps?: AdoptDeps;
  bundleDeps?: StatusDeps;
  upDeps?: StatusDeps;
  downDeps?: StatusDeps;
  psDeps?: StatusDeps;
  mcpDeps?: StatusDeps;
  agentDeps?: AgentDeps;
  rigDeps?: RigDeps;
  transcriptDeps?: StatusDeps;
  sendDeps?: StatusDeps;
  captureDeps?: StatusDeps;
  broadcastDeps?: StatusDeps;
  askDeps?: StatusDeps;
  chatroomDeps?: StatusDeps;
  specsDeps?: StatusDeps;
  whoamiDeps?: StatusDeps;
  expandDeps?: StatusDeps;
  envDeps?: StatusDeps;
  unclaimDeps?: StatusDeps;
  releaseDeps?: StatusDeps;
  launchDeps?: StatusDeps;
  removeDeps?: StatusDeps;
  shrinkDeps?: StatusDeps;
  destroyDeps?: DestroyCommandDeps;
  configPath?: string;
}

export function createProgram(depsOverride?: ProgramDeps): Command {
  const program = new Command();

  program
    .name("rig")
    .description("CLI for the OpenRig local control plane")
    .version(CLI_VERSION);

  program.addCommand(daemonCommand(depsOverride?.daemonDeps));
  program.addCommand(statusCommand(depsOverride?.statusDeps));
  program.addCommand(snapshotCommand(depsOverride?.snapshotDeps));
  program.addCommand(restoreCommand(depsOverride?.restoreDeps));
  program.addCommand(exportCommand(depsOverride?.exportDeps));
  program.addCommand(importCommand(depsOverride?.importDeps));
  program.addCommand(uiCommand(depsOverride?.uiDeps));
  program.addCommand(packageCommand(depsOverride?.packageDeps));
  program.addCommand(bootstrapCommand(depsOverride?.bootstrapDeps));
  program.addCommand(requirementsCommand(depsOverride?.requirementsDeps));
  program.addCommand(discoverCommand(depsOverride?.discoverDeps));
  program.addCommand(attachCommand(depsOverride?.attachDeps));
  program.addCommand(bindCommand(depsOverride?.bindDeps));
  program.addCommand(adoptCommand(depsOverride?.adoptDeps));
  program.addCommand(bundleCommand(depsOverride?.bundleDeps));
  program.addCommand(upCommand(depsOverride?.upDeps));
  program.addCommand(downCommand(depsOverride?.downDeps));
  program.addCommand(psCommand(depsOverride?.psDeps));
  program.addCommand(mcpCommand(depsOverride?.mcpDeps));
  program.addCommand(agentCommand(depsOverride?.agentDeps));
  program.addCommand(rigCommand(depsOverride?.rigDeps));
  program.addCommand(transcriptCommand(depsOverride?.transcriptDeps));
  program.addCommand(sendCommand(depsOverride?.sendDeps));
  program.addCommand(captureCommand(depsOverride?.captureDeps));
  program.addCommand(broadcastCommand(depsOverride?.broadcastDeps));
  program.addCommand(askCommand(depsOverride?.askDeps));
  program.addCommand(chatroomCommand(depsOverride?.chatroomDeps));
  program.addCommand(specsCommand(depsOverride?.specsDeps));
  program.addCommand(whoamiCommand(depsOverride?.whoamiDeps));
  program.addCommand(configCommand(depsOverride?.configPath));
  program.addCommand(preflightCommand());
  program.addCommand(doctorCommand());
  program.addCommand(expandCommand(depsOverride?.expandDeps));
  program.addCommand(envCommand(depsOverride?.envDeps));
  program.addCommand(unclaimCommand(depsOverride?.unclaimDeps));
  program.addCommand(releaseCommand(depsOverride?.releaseDeps));
  program.addCommand(launchCommand(depsOverride?.launchDeps));
  program.addCommand(removeCommand(depsOverride?.removeDeps));
  program.addCommand(shrinkCommand(depsOverride?.shrinkDeps));
  program.addCommand(destroyCommand(depsOverride?.destroyDeps));

  return program;
}

export function isDirectRun(argv1 = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argv1) return false;

  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// Only parse when executed directly (not imported for testing)
if (isDirectRun()) {
  createProgram().parse();
}
