// Rig Context / Composable Context Injection v0 (PL-014) — `rig
// context-pack` CLI verb family.
//
// Six subcommands parallel to `rig specs`:
//   list / show / preview / add / sync / send
//
// Each delegates to /api/context-packs/library/* against the daemon.
// The `add` verb installs a pack from a directory at
// ~/.openrig/context-packs/<name>/ — host-symlink-free contract,
// matches `rig specs add` shape (regular files only; no symlinks).

import { Command } from "commander";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface ContextPackEntryWire {
  id: string;
  kind: "context-pack";
  name: string;
  version: string;
  purpose: string | null;
  sourceType: "builtin" | "user_file" | "workspace";
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  manifestEstimatedTokens: number | null;
  derivedEstimatedTokens: number;
  files: Array<{
    path: string;
    role: string;
    summary: string | null;
    absolutePath: string | null;
    bytes: number | null;
    estimatedTokens: number | null;
  }>;
}

interface PreviewWire {
  id: string;
  name: string;
  version: string;
  bundleText: string;
  bundleBytes: number;
  estimatedTokens: number;
  files: Array<{ path: string; role: string; bytes: number; estimatedTokens: number }>;
  missingFiles: Array<{ path: string; role: string }>;
}

interface SendWire {
  id: string;
  name: string;
  version: string;
  destinationSession: string;
  bundleBytes: number;
  estimatedTokens: number;
  files: Array<{ path: string; role: string; bytes: number; estimatedTokens: number }>;
  missingFiles: Array<{ path: string; role: string }>;
  dryRun: boolean;
  bundleText?: string;
  sent?: boolean;
  reason?: string;
  error?: string;
}

function assertTreeHasNoSymlinks(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absPath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Context pack directories must not contain symlinks: ${absPath}`);
      }
      if (entry.isDirectory()) stack.push(absPath);
    }
  }
}

async function resolvePack(client: DaemonClient, nameOrId: string): Promise<ContextPackEntryWire> {
  // First try as id (context-pack:<name>:<version>); else search by name.
  if (nameOrId.startsWith("context-pack:")) {
    const res = await client.get<ContextPackEntryWire>(`/api/context-packs/library/${encodeURIComponent(nameOrId)}`);
    if (res.status === 200) return res.data;
    if (res.status === 404) throw new Error(`Context pack '${nameOrId}' not found in library. Run 'rig context-pack list' to see what's available.`);
    throw new Error(`Daemon returned HTTP ${res.status} for /api/context-packs/library/${nameOrId}`);
  }
  const res = await client.get<ContextPackEntryWire[]>("/api/context-packs/library");
  if (res.status !== 200) throw new Error(`Daemon returned HTTP ${res.status} for /api/context-packs/library`);
  const entries = res.data ?? [];
  const matches = entries.filter((e) => e.name === nameOrId);
  if (matches.length === 0) {
    throw new Error(`Context pack '${nameOrId}' not found in library. Run 'rig context-pack list' to see what's available.`);
  }
  if (matches.length > 1) {
    const versions = matches.map((m) => m.version).join(", ");
    throw new Error(`Context pack '${nameOrId}' is ambiguous (versions: ${versions}). Use the full id 'context-pack:${nameOrId}:<version>'.`);
  }
  return matches[0]!;
}

export function contextPackCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("context-pack")
    .description("Browse, preview, send, and install operator-authored context packs")
    .addHelpText("after", `
Examples:
  rig context-pack list
  rig context-pack show pl-005-phase-a-priming
  rig context-pack preview pl-005-phase-a-priming
  rig context-pack add ./my-pack
  rig context-pack sync
  rig context-pack send pl-005-phase-a-priming velocity-driver@openrig-velocity --dry-run
  rig context-pack send pl-005-phase-a-priming velocity-driver@openrig-velocity
`);

  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  async function getClient(): Promise<DaemonClient> {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      throw new Error("Daemon not running. Start it with: rig daemon start");
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd.command("list")
    .description("List all context packs in the library")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.get<ContextPackEntryWire[]>("/api/context-packs/library");
        const entries = res.data ?? [];
        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }
        if (entries.length === 0) {
          console.log("No context packs in library. Author one at ~/.openrig/context-packs/<name>/ then run: rig context-pack sync");
          return;
        }
        for (const e of entries) {
          console.log(`${e.name.padEnd(28)} v${String(e.version).padEnd(6)} ${String(e.files.length).padStart(2)} files  ~${String(e.derivedEstimatedTokens).padStart(6)} tokens  ${e.sourceType}  ${e.sourcePath}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("show")
    .argument("<name-or-id>", "Context pack name or library ID")
    .description("Show pack manifest + per-file metadata")
    .option("--json", "JSON output")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolvePack(client, nameOrId);
        if (opts.json) {
          console.log(JSON.stringify(entry, null, 2));
          return;
        }
        console.log(`Name:        ${entry.name}`);
        console.log(`Version:     ${entry.version}`);
        console.log(`Source:      ${entry.sourceType} (${entry.sourcePath})`);
        console.log(`Files:       ${entry.files.length}`);
        console.log(`Tokens (~):  ${entry.derivedEstimatedTokens}${entry.manifestEstimatedTokens !== null ? ` (manifest: ${entry.manifestEstimatedTokens})` : ""}`);
        if (entry.purpose) {
          console.log("");
          console.log("Purpose:");
          console.log(`  ${entry.purpose.replaceAll("\n", "\n  ")}`);
        }
        console.log("");
        for (const f of entry.files) {
          const sizeStr = f.bytes === null ? "(missing)" : `${f.bytes}B`;
          const tokenStr = f.estimatedTokens === null ? "—" : `~${f.estimatedTokens} tokens`;
          console.log(`  ${f.path.padEnd(40)} role=${f.role.padEnd(20)} ${sizeStr.padEnd(12)} ${tokenStr}`);
          if (f.summary) console.log(`    ${f.summary}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("preview")
    .argument("<name-or-id>", "Context pack name or library ID")
    .description("Show the assembled bundle (the exact text that would be sent)")
    .option("--json", "JSON output")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolvePack(client, nameOrId);
        const res = await client.get<PreviewWire>(`/api/context-packs/library/${encodeURIComponent(entry.id)}/preview`);
        if (res.status !== 200) throw new Error(`Daemon returned HTTP ${res.status}`);
        const preview = res.data;
        if (opts.json) {
          console.log(JSON.stringify(preview, null, 2));
          return;
        }
        if (preview.missingFiles.length > 0) {
          console.error(`Warning: ${preview.missingFiles.length} file(s) referenced by manifest are missing on disk:`);
          for (const m of preview.missingFiles) console.error(`  - ${m.path} (role: ${m.role})`);
          console.error("");
        }
        console.log(`# Preview: ${preview.name} v${preview.version}`);
        console.log(`# Bundle: ${preview.bundleBytes} bytes (~${preview.estimatedTokens} tokens), ${preview.files.length} files`);
        console.log("# ---");
        console.log(preview.bundleText);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("sync")
    .description("Re-walk discovery roots and refresh the library index")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.post<{ count: number; errors: Array<{ source: string; error: string }>; entries: ContextPackEntryWire[] }>(
          "/api/context-packs/library/sync",
        );
        if (res.status !== 200) throw new Error(`Daemon returned HTTP ${res.status}`);
        const data = res.data;
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(`Indexed ${data.count} context pack(s).`);
        if (data.errors.length > 0) {
          console.log(`Encountered ${data.errors.length} parse error(s):`);
          for (const e of data.errors) console.log(`  - ${e.source}: ${e.error}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("add")
    .argument("<source-dir>", "Directory containing manifest.yaml + included files")
    .description("Install a context pack from a local directory into ~/.openrig/context-packs/")
    .option("--name <name>", "Override the install name (defaults to source directory basename)")
    .option("--json", "JSON output")
    .action(async (sourceDir: string, opts: { name?: string; json?: boolean }) => {
      try {
        if (!existsSync(sourceDir)) throw new Error(`Source directory not found: ${sourceDir}`);
        const stat = lstatSync(sourceDir);
        if (stat.isSymbolicLink()) throw new Error(`Source must not be a symlink: ${sourceDir}`);
        if (!stat.isDirectory()) throw new Error(`Source must be a directory containing manifest.yaml: ${sourceDir}`);
        const manifestPath = join(sourceDir, "manifest.yaml");
        if (!existsSync(manifestPath)) {
          throw new Error(`Source directory must contain manifest.yaml: ${sourceDir}`);
        }
        // Read the manifest's name as the canonical install name when
        // --name not given. Cheap parse: trust the daemon to validate
        // on next sync; here we just need the name.
        const installName = opts.name ?? (() => {
          try {
            const raw = readFileSync(manifestPath, "utf-8");
            const m = raw.match(/^name:\s*['"]?([^'"\n]+)['"]?\s*$/m);
            return m?.[1]?.trim() || basename(sourceDir);
          } catch {
            return basename(sourceDir);
          }
        })();
        assertTreeHasNoSymlinks(sourceDir);
        const targetRoot = getDefaultOpenRigPath("context-packs");
        mkdirSync(targetRoot, { recursive: true });
        const targetDir = join(targetRoot, installName);
        if (existsSync(targetDir)) {
          throw new Error(`A context pack named '${installName}' already exists at ${targetDir}. Remove it first or use --name to install under a different name.`);
        }
        cpSync(sourceDir, targetDir, { recursive: true });
        // Sync the daemon library so the new pack appears immediately.
        const client = await getClient();
        const syncRes = await client.post<{ count: number; entries: ContextPackEntryWire[] }>("/api/context-packs/library/sync");
        if (syncRes.status !== 200) {
          // Install succeeded; sync failed → still surface install path.
          if (opts.json) console.log(JSON.stringify({ installedAt: targetDir, syncError: `HTTP ${syncRes.status}` }, null, 2));
          else console.log(`Installed at ${targetDir}; daemon sync failed (HTTP ${syncRes.status}). Run 'rig context-pack sync' manually.`);
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify({ installedAt: targetDir, count: syncRes.data.count }, null, 2));
        } else {
          console.log(`Installed at ${targetDir}. Library now has ${syncRes.data.count} context pack(s).`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("send")
    .argument("<name-or-id>", "Context pack name or library ID")
    .argument("<destination-session>", "Destination session name (e.g., velocity-driver@openrig-velocity)")
    .description("Assemble the pack into one paste-ready bundle and send to a seat")
    .option("--dry-run", "Show what would be sent without invoking SessionTransport")
    .option("--json", "JSON output")
    .action(async (nameOrId: string, destinationSession: string, opts: { dryRun?: boolean; json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolvePack(client, nameOrId);
        const res = await client.post<SendWire>(`/api/context-packs/library/${encodeURIComponent(entry.id)}/send`, {
          destinationSession,
          dryRun: opts.dryRun ?? false,
        });
        if (res.status !== 200) {
          // 502/503/etc. — surface daemon error verbatim.
          const data = res.data as Partial<SendWire> & { error?: string; reason?: string };
          throw new Error(data.error ?? data.reason ?? `Daemon returned HTTP ${res.status}`);
        }
        const data = res.data;
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        if (data.dryRun) {
          if (data.missingFiles.length > 0) {
            console.error(`Warning: ${data.missingFiles.length} manifest file(s) missing on disk.`);
          }
          console.log(`(dry-run) ${data.name} v${data.version} → ${data.destinationSession}`);
          console.log(`Bundle: ${data.bundleBytes} bytes (~${data.estimatedTokens} tokens), ${data.files.length} files`);
          if (data.bundleText) {
            console.log("# ---");
            console.log(data.bundleText);
          }
          return;
        }
        console.log(`Sent ${data.name} v${data.version} (${data.bundleBytes} bytes) to ${data.destinationSession}.`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;
}
