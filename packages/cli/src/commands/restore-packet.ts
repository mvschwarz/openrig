// restore-packet.ts — `rig restore-packet {write,read,validate}` CLI command.
//
// M2a chunk: command shape + mutual-exclusion for `write`; `read` and
// `validate` are subcommand stubs that return a clear "M3 only" error so
// the CLI surface is registrable now.
//
// M2b will add: source-adapter wiring (codex-jsonl-parser, claude-transcript-
// parser, runtime-detect, redaction, omitted-records).
// M2c will add: packet-writer atomic emission + daemon route integration.
// M3 will replace the read/validate stubs with real implementations.

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { type LifecycleDeps } from "../daemon-lifecycle.js";

export interface RestorePacketDeps {
  lifecycleDeps?: LifecycleDeps;
  clientFactory?: (url: string) => DaemonClient;
}

interface WriteOptions {
  sourceSession?: string;
  sourceJsonl?: string;
  sourceRuntime?: string;
  target: string;
  targetRig?: string;
  targetRuntime?: string;
  targetWorkspaceRoot?: string;
  defaultTargetRepo?: string;
}

function reportFailure(message: string): void {
  console.error(`rig restore-packet write: ${message}`);
  process.exitCode = 2;
}

export function restorePacketCommand(_depsOverride?: RestorePacketDeps): Command {
  // _depsOverride is reserved for M2b/M2c when the source adapters need a
  // DaemonClient (full-read transcript route) and a LifecycleDeps for daemon
  // boot / status checks. M2a does not use either; the test suite passes
  // depsOverride? as undefined.
  const cmd = new Command("restore-packet")
    .description(
      "Generate, read, and validate cross-runtime restore packets per the v0 standard",
    );

  cmd.command("write")
    .description(
      "Generate a restore packet from a source session or JSONL file",
    )
    .option("--source-session <session>", "Source session name (daemon-backed)")
    .option(
      "--source-jsonl <path>",
      "Source Codex/Claude JSONL transcript file (direct)",
    )
    .option(
      "--source-runtime <runtime>",
      "Force source runtime (claude-code | codex); auto-detected if omitted",
    )
    .requiredOption(
      "--target <dir>",
      "Target packet directory (must not exist; created atomically)",
    )
    .option("--target-rig <rig>", "Target rig name for the restored seat")
    .option(
      "--target-runtime <runtime>",
      "Target runtime (claude-code | codex)",
    )
    .option(
      "--target-workspace-root <path>",
      "Target workspace root absolute path",
    )
    .option(
      "--default-target-repo <path>",
      "Default target repo absolute path or null",
    )
    .action(async (opts: WriteOptions) => {
      const hasSession = typeof opts.sourceSession === "string" && opts.sourceSession.length > 0;
      const hasJsonl = typeof opts.sourceJsonl === "string" && opts.sourceJsonl.length > 0;
      if (hasSession && hasJsonl) {
        reportFailure(
          "--source-session and --source-jsonl are mutually exclusive; supply exactly one.",
        );
        return;
      }
      if (!hasSession && !hasJsonl) {
        reportFailure(
          "exactly one of --source-session or --source-jsonl is required.",
        );
        return;
      }
      // M2b lands the actual write path. The mutual-exclusion checks above
      // are M2a-final; from here on (M2b) the source-adapter dispatch will
      // route to codex-jsonl-parser, claude-transcript-parser, or the
      // daemon full-read route.
      reportFailure(
        "M2a: source adapters land in M2b; this command is registered but not yet executable. (target was: " +
          opts.target +
          ")",
      );
    });

  cmd.command("read")
    .description("Render a restore packet contents (human or --json)")
    .argument("<packet-dir>", "Packet directory path")
    .option("--json", "Emit machine-readable JSON output")
    .action(async (packetDir: string, _opts: { json?: boolean }) => {
      console.error(
        `rig restore-packet read: M3 implementation pending; packet-dir was '${packetDir}'.`,
      );
      process.exitCode = 2;
    });

  cmd.command("validate")
    .description("Validate a restore packet against the v0 schema")
    .argument("<packet-dir>", "Packet directory path")
    .option("--json", "Emit machine-readable validation report")
    .action(async (packetDir: string, _opts: { json?: boolean }) => {
      console.error(
        `rig restore-packet validate: M3 implementation pending; packet-dir was '${packetDir}'.`,
      );
      process.exitCode = 2;
    });

  return cmd;
}
