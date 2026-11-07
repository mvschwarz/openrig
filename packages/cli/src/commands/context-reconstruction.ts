import { Command } from "commander";
import { join, resolve } from "node:path";
import { ConfigStore } from "../config-store.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { resolveWorkContextHome } from "../lib/work-install.js";
import { ReconstructionError, readReconstruction, readStoreMappings, reconstructionOutput } from "../lib/reconstruction-reader.js";

interface Options {
  store?: string; storeMap?: string; project?: string; mission?: string; slice?: string; cwd?: string;
  item: string[]; category: string[]; tag: string[]; checkSources?: boolean; maxBytes: string; json?: boolean;
}
const collect = (value: string, previous: string[]) => [...previous, value];

/** A local config/filesystem consumer. This command never starts or contacts a
 * daemon, invokes a helper, writes revisions, or takes over the selected work. */
export function reconstructionCommand(): Command {
  const cmd = new Command("reconstruction")
    .description("Inspect or read an exact immutable reconstruction locally (read-only v0 consumer)");
  for (const mode of ["inspect", "view"] as const) {
    cmd.command(`${mode} <revision>`)
      .description(mode === "inspect" ? "Inspect provenance, dates, size and the complete source manifest" : "Read a faithful selected view with dependencies and explicit omissions")
      .option("--store <absolute-path>", "Explicit local v0/import store; default: selected work home/reconstructions")
      .option("--store-map <file>", "JSON array of {sourceStore, localStore, sourceHost?}; read-time mapping only")
      .option("--project <id>", "Catalog project, with the same inference as context work-install")
      .option("--mission <id>", "Mission in the selected project's configured missions root")
      .option("--slice <id>", "Slice under the selected mission")
      .option("--cwd <path>", "Working directory used for project inference")
      .option("--item <id>", "Include item (repeatable; selectors form a union)", collect, [])
      .option("--category <name>", "Include category (repeatable)", collect, [])
      .option("--tag <name>", "Include tag (repeatable)", collect, [])
      .option("--check-sources", "Hash declared local files within 128 files / 64 MiB; never refresh observation dates")
      .option("--max-bytes <bytes>", "Maximum complete output, 1024..8388608 UTF-8 bytes", "262144")
      .option("--json", "Structured output; inspect always uses JSON")
      .addHelpText("after", "\nSupports openrig.reconstruction/v0 with safe integer JSON numbers; other numeric representations are explicitly unsupported. No implicit remote reads. Context does not transfer authority.\n")
      .action((revision: string, opts: Options) => {
        try {
          let store = opts.store;
          let resolution: object = { mode: "explicit-store", project: null, home: null };
          if (store === undefined || opts.project !== undefined || opts.mission !== undefined || opts.slice !== undefined) {
            const config = new ConfigStore();
            const home = resolveWorkContextHome({
              workspaceRoot: String(config.resolveWithSource("workspace.root").value),
              catalogPath: String(config.resolveWithSource("workspace.catalog_path").value),
              cwd: resolve(opts.cwd ?? process.cwd()),
              ...(readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME") ? { sessionName: readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")! } : {}),
              ...(opts.project === undefined ? {} : { project: opts.project }),
              ...(opts.mission === undefined ? {} : { mission: opts.mission }),
              ...(opts.slice === undefined ? {} : { slice: opts.slice }),
            });
            if ("error" in home) throw new ReconstructionError(home.error.code, home.error.message);
            resolution = { mode: store === undefined ? "work-home" : "explicit-store", ...home };
            store ??= join(home.home, "reconstructions");
          }
          const result = readReconstruction({ store, revision,
            ...(opts.storeMap ? { mappings: readStoreMappings(resolve(opts.storeMap)) } : {}),
            items: opts.item, categories: opts.category, tags: opts.tag, checkSources: opts.checkSources });
          const response = { ...result, resolution };
          console.log(reconstructionOutput(response, mode, Boolean(opts.json), Number(opts.maxBytes)));
          if (!result.complete) process.exitCode = 1;
        } catch (error) {
          const code = error instanceof ReconstructionError ? error.code : "reconstruction_unavailable";
          if (opts.json || mode === "inspect") console.log(JSON.stringify({ complete: false, error: { code, message: (error as Error).message } }, null, 2));
          else console.error(`${code}: ${(error as Error).message}`);
          process.exitCode = 1;
        }
      });
  }
  return cmd;
}
