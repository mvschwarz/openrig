// OPR.0.4.3.05 seat-forking closeout — the top-level `rig fork` verb.
//
// One discoverable command that branches a live seat's context into a new
// seat. It is a THIN client over the shipped agent-image fork foundation: it
// POSTs to the narrow daemon fork composer (/api/agent-images/fork), which
// resolves the native resume id server-side and composes add_member. The
// native id is redacted at every wire boundary and never reaches the CLI.
//
//   default        one-shot fork, no library growth (mode: fork, native_id)
//   --keep-image   also capture a durable, PINNED (prune-protected) image

import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface ForkResponse {
  ok?: boolean;
  code?: string;
  error?: string;
  message?: string;
  errors?: string[];
  result?: {
    podNamespace?: string;
    node?: { logicalId: string; status: string; error?: string; sessionName?: string };
    warnings?: string[];
  };
  image?: { id: string; name: string; version: string; pinned: boolean };
}

export function forkCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("fork")
    .description("Fork a live seat's context into a new seat (composes the shipped agent-image fork path)")
    .argument("<source-session>", "Source session canonical name (e.g., dev-impl@openrig-delivery)")
    .requiredOption("--rig <rig-id>", "Target rig id")
    .requiredOption("--pod <pod-namespace>", "Target existing pod namespace")
    .requiredOption("--member <member-id>", "New member id for the forked successor")
    .option("--keep-image", "Also capture a durable, pinned agent image (default forks one-shot with no library growth)")
    .option("--image-name <name>", "Name for the kept image (with --keep-image; default fork-<member>)")
    .option("--image-version <version>", "Version for the kept image (default 1)")
    .option("--rig-root <path>", "Root directory for agent resolution")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig fork dev-impl@openrig-delivery --rig openrig-delivery --pod dev --member dev-impl-fork
  rig fork dev-impl@openrig-delivery --rig openrig-delivery --pod dev --member dev-impl-2 --keep-image --image-name impl-primed
`)
    .action(async (sourceSession: string, opts: {
      rig: string;
      pod: string;
      member: string;
      keepImage?: boolean;
      imageName?: string;
      imageVersion?: string;
      rigRoot?: string;
      json?: boolean;
    }) => {
      try {
        const deps = depsOverride ?? {
          lifecycleDeps: realDeps(),
          clientFactory: (url: string) => new DaemonClient(url),
        };
        const status = await getDaemonStatus(deps.lifecycleDeps);
        if (status.state !== "running" || status.healthy === false) {
          console.error("Daemon not running. Start it with: rig daemon start");
          process.exitCode = 1;
          return;
        }
        const client = deps.clientFactory(getDaemonUrl(status));

        const body: Record<string, unknown> = {
          sourceSession,
          rigId: opts.rig,
          pod: opts.pod,
          member: opts.member,
        };
        if (opts.keepImage) body["keepImage"] = true;
        if (opts.imageName) body["imageName"] = opts.imageName;
        if (opts.imageVersion) body["imageVersion"] = opts.imageVersion;
        if (opts.rigRoot) body["rigRoot"] = opts.rigRoot;

        const res = await client.post<ForkResponse>("/api/agent-images/fork", body);
        const data = res.data;

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          if (res.status >= 400 || !data.ok || (data.result?.node && data.result.node.status !== "launched")) {
            process.exitCode = 1;
          }
          return;
        }

        if (res.status >= 400 || !data.ok) {
          const msg = data.message
            ?? (data.errors && data.errors.length > 0 ? data.errors.join("; ") : data.error)
            ?? `Fork failed (HTTP ${res.status})`;
          console.error(msg);
          process.exitCode = 1;
          return;
        }

        const node = data.result?.node;
        const icon = node?.status === "launched" ? "OK" : "FAIL";
        const session = node?.sessionName ? ` (${node.sessionName})` : "";
        const error = node?.error ? ` - ${node.error}` : "";
        console.log(`Forked ${sourceSession} into rig ${opts.rig}`);
        console.log(`  Pod: ${data.result?.podNamespace ?? opts.pod}`);
        console.log(`  New seat: [${icon}] ${node?.logicalId ?? opts.member}${session}${error}`);
        if (data.image) {
          console.log(`  Kept image: ${data.image.name} v${data.image.version} (pinned, protected from prune)`);
        } else {
          console.log("  One-shot fork (no image retained)");
        }
        for (const w of data.result?.warnings ?? []) console.log(`  Warning: ${w}`);

        if (node && node.status !== "launched") process.exitCode = 1;
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;
}
