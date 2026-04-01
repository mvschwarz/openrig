#!/usr/bin/env node
import { Command } from "commander";
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
import { claimCommand } from "./commands/claim.js";
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
import type { LifecycleDeps } from "./daemon-lifecycle.js";

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
  claimDeps?: StatusDeps;
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
}

export function createProgram(depsOverride?: ProgramDeps): Command {
  const program = new Command();

  program
    .name("rigged")
    .description("CLI for the Rigged local control plane")
    .version("0.1.0");

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
  program.addCommand(claimCommand(depsOverride?.claimDeps));
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

  return program;
}

// Only parse when executed directly (not imported for testing)
const isDirectRun =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  createProgram().parse();
}
