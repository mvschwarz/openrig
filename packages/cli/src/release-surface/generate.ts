// OPR.0.3.3.13.1 - sample-diff generator entry.
//
// Runnable after `npm run build`:
//   node dist/release-surface/generate.js --from v0.3.1 --to v0.3.2 --out <path>
// Emits the deterministic release-surface diff to --out (or stdout). Not wired
// into the shipped `rig` binary (that placement is a 13.3 decision); this is the
// POC proof-artifact generator.

import fs from "node:fs";

import { generateSurfaceDiff, diffToYaml, SurfaceParserError } from "./surface-diff.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  try {
    const diff = generateSurfaceDiff({ from: args.from, to: args.to, cwd: args.cwd });
    if (diff.release_from_source === "checkout-nearest-release") {
      process.stderr.write(`Warning: no earlier release found for ${diff.release_to}. Using the checkout's nearest release ${diff.release_from}. Pass --from to choose a different base.\n`);
    }
    const yaml = diffToYaml(diff);
    if (args.out) {
      fs.writeFileSync(args.out, yaml);
      process.stderr.write(`release-surface diff written to ${args.out}\n`);
    } else {
      process.stdout.write(yaml);
    }
    return 0;
  } catch (err) {
    if (err instanceof SurfaceParserError) {
      process.stderr.write(`Error: ${err.fact}\n${err.consequence}\n${err.action}\n`);
      return 1;
    }
    throw err;
  }
}

process.exitCode = main(process.argv.slice(2));
