// OPR.0.4.4.18 — `rig file` (v0: ONE explicit verb, copy).
//
// Every transfer names its source, destination, and policy: <hostId>:<path>
// is remote (resolving the registry's ssh entries), a bare path is local,
// and NOTHING is inferred from cwd/env/session (FR-2). Existing destination
// files are OVERWRITTEN — v0 copy semantics, stated (arch R18-2); --dry-run
// is the guard rail. The security wall lives in lib/file-transfer.ts.

import { Command } from "commander";
import { buildSftpArgv } from "../lib/native-sftp-copy.js";
import {
  planFileCopy,
  buildRsyncArgv,
  runFileCopy,
  type CopyPlan,
  type PlanDeps,
} from "../lib/file-transfer.js";

export interface FileCommandDeps extends PlanDeps {
  run?: typeof runFileCopy;
}

function operandLabel(side: CopyPlan["src"]): string {
  return side.kind === "remote" ? `${side.host!.id}:${side.path}` : side.path;
}

export function fileCommand(deps: FileCommandDeps = {}): Command {
  const file = new Command("file").description(
    "Copy files locally or over SSH (native SFTP on Windows, rsync on POSIX)",
  );

  file
    .command("copy <src> <dst>")
    .description(
      "Copy files or directories. <hostId>:<absolute-path> = remote (ssh registry entry); bare path = local. Windows drive and UNC paths are local; other local colon names need the ./ prefix. Valid shapes: local→remote, remote→local, local→local. An existing destination is OVERWRITTEN — preview with --dry-run.",
    )
    .option("--dry-run", "Print the exact planned transfer (src, dst, host, files/bytes) and move nothing")
    .option("--json", "JSON output for agents")
    .action(async (src: string, dst: string, opts: { dryRun?: boolean; json?: boolean }) => {
      const planned = planFileCopy(src, dst, { dryRun: opts.dryRun, registryLoader: deps.registryLoader });
      if (!planned.ok) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, code: planned.code, error: planned.error }));
        } else {
          console.error(planned.error);
        }
        process.exitCode = 1;
        return;
      }
      const plan = planned.plan;
      const srcLabel = operandLabel(plan.src);
      const dstLabel = operandLabel(plan.dst);
      const run = deps.run ?? runFileCopy;
      const result = await run(plan);

      if (opts.json) {
        console.log(
          JSON.stringify({
            ok: result.ok,
            dryRun: plan.dryRun,
            src: srcLabel,
            dst: dstLabel,
            failedStep: result.failedStep,
            bytesTransferred: result.bytesTransferred ?? null,
            filesTransferred: result.filesTransferred ?? null,
            exitCode: result.exitCode,
            error: result.ok ? null : result.stderr.trim() || `file copy failed (${result.failedStep})`,
            hint: result.hint ?? null,
            transport: result.transport ?? "rsync",
            rsyncArgv: result.transport && result.transport !== "rsync" ? null : buildRsyncArgv(plan),
            ...(result.transport === "sftp" ? { sshArgv: buildSftpArgv(plan) } : {}),
          }),
        );
        if (!result.ok) process.exitCode = 1;
        return;
      }

      if (result.ok) {
        if (plan.dryRun) {
          console.log(`DRY RUN — nothing moved. Planned transfer:`);
          console.log(`  ${srcLabel} → ${dstLabel}`);
          if (result.filesTransferred !== undefined) console.log(`  files: ${result.filesTransferred}${result.bytesTransferred !== undefined ? `, bytes: ${result.bytesTransferred}` : ""}`);
          const itemized = result.stdout.split("\n").filter((l) => /^[<>ch.*][fdLDS]/.test(l));
          for (const line of itemized) console.log(`  ${line}`);
        } else {
          console.log(`Copied ${srcLabel} → ${dstLabel}${result.bytesTransferred !== undefined ? ` (${result.bytesTransferred} bytes)` : ""}`);
        }
        return;
      }
      console.error(`file copy failed [${result.failedStep}]: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      if (result.hint) console.error(`Hint: ${result.hint}`);
      process.exitCode = 1;
    });

  return file;
}
