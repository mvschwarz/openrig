import { link, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { getOpenRigHome } from "../openrig-compat.js";

type ExportOptions = {
  readonly host?: boolean;
  readonly rig?: string[];
  readonly mission?: string[];
  readonly slice?: string[];
  readonly qitems?: string[];
  readonly out?: string;
  readonly preview?: boolean;
};

export function queueExportCommand(): Command {
  const cmd = new Command("export").allowExcessArguments(false)
    .description("Proposed: preview or archive explicitly selected local queue work without moving it");
  return cmd.option("--host", "Select the entire local queue (no host argument)")
    .option("--rig <name...>", "Select local rig names")
    .option("--mission <id...>", "Select exact mission tags")
    .option("--slice <id...>", "Select exact slice tags")
    .option("--qitems <id...>", "Select exact queue IDs")
    .option("--out <file>", "Write a new private archive file")
    .option("--preview", "Print the unfrozen source archive to stdout; write no file")
    .action(async (opts: ExportOptions) => {
      const candidates = [opts.host, opts.rig, opts.mission, opts.slice, opts.qitems].filter(Boolean);
      if (candidates.length !== 1) cmd.error("Name exactly one source scope: --host, --rig, --mission, --slice, or --qitems.");
      if (Boolean(opts.preview) === Boolean(opts.out)) cmd.error("Supply exactly one of --out <file> or --preview.");
      const selection = opts.rig ? { kind: "rig", names: opts.rig } as const
        : opts.mission ? { kind: "mission", names: opts.mission } as const
        : opts.slice ? { kind: "slice", names: opts.slice } as const
        : opts.qitems ? { kind: "qitems", names: opts.qitems } as const : { kind: "host" } as const;
      try {
        const { exportLocalQueue } = await import("@openrig/daemon/queue-transfer-export");
        const { archive, ...summary } = exportLocalQueue({ home: getOpenRigHome(), dbPath: process.env.OPENRIG_DB ?? process.env.RIGGED_DB }, selection);
        if (opts.preview) {
          process.stdout.write(archive);
          process.stderr.write("not_ready_for_activation\n");
        } else if (opts.out) {
          process.stderr.write(`${JSON.stringify(summary)}\n`);
          const out = resolve(opts.out);
          const temporary = await mkdtemp(join(dirname(out), ".queue-export-"));
          try {
            const file = join(temporary, "archive");
            await writeFile(file, archive, { mode: 0o600, flag: "wx" });
            await link(file, out);
          } finally {
            await rm(temporary, { recursive: true, force: true });
          }
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        cmd.error(error.message);
      }
    });
}
