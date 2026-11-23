import { Command } from "commander";
import { ConfigStore } from "../config-store.js";
import { resolveLocalDbOverride } from "../local-db.js";
import { getOpenRigHome } from "../openrig-compat.js";

const destination = () => ({ home: getOpenRigHome(), dbPath: resolveLocalDbOverride() });
const print = (report: unknown) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

export function queueImportCommand(): Command {
  return new Command("import").allowExcessArguments(false)
    .description("Proposed: stage a queue archive without creating live work")
    .argument("<file>", "Local queue transfer archive")
    .option("--dry-run", "Proposed: review the archive against this destination without writing anything")
    .option("--max-bytes <n>", "Proposed: set the archive bound (default 16 MiB; raising it increases memory use)")
    .action(async (file: string, opts: { readonly dryRun?: boolean; readonly maxBytes?: string }, cmd: Command) => {
      try {
        const { importLocalQueue } = await import("@openrig/daemon/queue-transfer-staging");
        const allowlist = new ConfigStore().resolveWithSource("files.allowlist").value;
        const report = importLocalQueue({ ...destination(), allowlist: typeof allowlist === "string" ? allowlist : undefined }, file, { dryRun: opts.dryRun === true,
          ...(opts.maxBytes === undefined ? {} : { maxBytes: /^\d+$/.test(opts.maxBytes) ? Number(opts.maxBytes) : NaN }) });
        print(report);
        if (report.status === "rejected") process.exitCode = 2;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        cmd.error(error.message);
      }
    });
}

export function queueStagingCommand(): Command {
  const command = new Command("staging").description("Proposed: manage inactive queue archives");
  command.command("list").allowExcessArguments(false).description("List staging manifests, not archive contents")
    .action(async () => {
      const { listLocalQueueStages } = await import("@openrig/daemon/queue-transfer-staging");
      print(listLocalQueueStages(destination()));
    });
  command.command("discard <importId>").allowExcessArguments(false).description("Remove the envelope of an inactive stage")
    .action(async (importId: string, _opts: object, cmd: Command) => {
      const { discardLocalQueueStage } = await import("@openrig/daemon/queue-transfer-staging");
      const manifest = discardLocalQueueStage(destination(), importId);
      if (!manifest) cmd.error("No staged import with that ID");
      print(manifest);
    });
  return command;
}
