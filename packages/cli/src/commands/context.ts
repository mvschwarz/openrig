// Rig Context / Composable Context Injection — the `rig context` CLI verb
// family (Atom-7 renamed the retired `context-pack` grammar to `rig context`;
// the pack STORE contract — kind/id/API/on-disk dir — is unchanged).
//
// Delivery-free subcommands parallel to `rig specs`:
//   list / show / preview / compose / add / rm / sync
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
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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

// Slice-03 Atom 2 — mirror the daemon's per-segment ref contract at the
// local install boundary. This must run before creating the context store.
const SAFE_REF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertSafeInstallRef(ref: string): void {
  const safe =
    ref.length > 0 &&
    ref.split("/").every(
      (segment) => segment.length > 0 && segment !== "." && segment !== ".." && SAFE_REF_SEGMENT.test(segment),
    );
  if (!safe) {
    throw new Error(
      `unsafe install ref '${ref}' — a ref must be one or more '/'-separated segments, each matching ` +
        `[A-Za-z0-9][A-Za-z0-9._-]{0,63} (no '.'/'..', no absolute path, no empty segment, no ` +
        `whitespace or injection), so packs stay inside the context store root.`,
    );
  }
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

const ALLOWED_CONTEXT_PACK_SUFFIXES = new Set([".md", ".markdown", ".yaml", ".yml", ".txt"]);

function validateContextPackManifestForInstall(manifestPath: string): void {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new Error(`manifest at ${manifestPath} is not valid YAML: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`manifest at ${manifestPath} must be a YAML object at the root`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["name"] !== "string" || obj["name"].length === 0) {
    throw new Error(`manifest at ${manifestPath} is missing required field 'name' (string)`);
  }
  if (obj["version"] === undefined || obj["version"] === null) {
    throw new Error(`manifest at ${manifestPath} is missing required field 'version'`);
  }
  const files = obj["files"];
  if (!Array.isArray(files)) {
    throw new Error(`manifest at ${manifestPath} must declare 'files: [...]'`);
  }
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`manifest at ${manifestPath} has malformed entry at files[${i}]`);
    }
    const file = entry as Record<string, unknown>;
    const relPath = file["path"];
    if (typeof relPath !== "string" || relPath.length === 0) {
      throw new Error(`manifest at ${manifestPath} files[${i}] missing 'path' (string)`);
    }
    if (relPath.includes("..") || isAbsolute(relPath) || relPath.startsWith("\\")) {
      throw new Error(`manifest at ${manifestPath} files[${i}].path '${relPath}' must be a relative path inside the pack (no '..' segments, no leading '/')`);
    }
    if (!ALLOWED_CONTEXT_PACK_SUFFIXES.has(extname(relPath))) {
      throw new Error(`manifest at ${manifestPath} files[${i}].path '${relPath}' has an unsupported suffix; allowed: ${Array.from(ALLOWED_CONTEXT_PACK_SUFFIXES).join(", ")}`);
    }
    if (typeof file["role"] !== "string" || file["role"].length === 0) {
      throw new Error(`manifest at ${manifestPath} files[${i}] missing 'role' (string)`);
    }
  }
}

async function resolvePack(client: DaemonClient, nameOrRef: string): Promise<ContextPackEntryWire> {
  if (nameOrRef.startsWith("context-pack:")) {
    throw new Error(
      "Context pack colon-id addressing ('context-pack:<name>:<version>') was removed. " +
        "Address a pack by its path-like ref instead (for example 'packs/compaction-restore').",
    );
  }
  if (nameOrRef.includes("/")) {
    const res = await client.get<ContextPackEntryWire & { error?: string; message?: string }>(
      `/api/context-packs/library/by-ref?ref=${encodeURIComponent(nameOrRef)}`,
    );
    if (res.status === 200) return res.data;
    if (res.status === 404) throw new Error(`Context pack '${nameOrRef}' not found in library. Run 'rig context list' to see what's available.`);
    if (res.status === 400) throw new Error(res.data?.message ?? `Unsafe context pack ref '${nameOrRef}'.`);
    throw new Error(`Daemon returned HTTP ${res.status} for /api/context-packs/library/by-ref`);
  }
  const res = await client.get<ContextPackEntryWire[]>("/api/context-packs/library");
  if (res.status !== 200) throw new Error(`Daemon returned HTTP ${res.status} for /api/context-packs/library`);
  const entries = res.data ?? [];
  const exactRef = entries.find((entry) => entry.relativePath === nameOrRef);
  if (exactRef) return exactRef;
  const matches = entries.filter((e) => e.name === nameOrRef);
  if (matches.length === 0) {
    throw new Error(`Context pack '${nameOrRef}' not found in library. Run 'rig context list' to see what's available.`);
  }
  if (matches.length > 1) {
    const refs = matches.map((entry) => entry.relativePath).join(", ");
    throw new Error(`Context pack name '${nameOrRef}' is ambiguous across refs: ${refs}. Address it by path-like ref.`);
  }
  return matches[0]!;
}

export function contextCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("context")
    .description("Browse, preview, compose, and manage operator-authored context packs")
    .addHelpText("after", `
Examples:
  rig context list
  rig context show pl-005-phase-a-priming
  rig context preview pl-005-phase-a-priming
  rig context add ./my-pack
  rig context rm packs/compaction-restore
  rig context sync
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

  cmd.command("compose")
    .description("Compose ordered files into a durable context-pack ref (never delivers)")
    .requiredOption("--out <ref>", "Path-like durable output ref")
    .requiredOption("--from <files...>", "Ordered source files")
    .action(async (opts: { out: string; from: string[] }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon is not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }
      const client = deps.clientFactory(getDaemonUrl(status));
      try {
        const res = await client.post<{
          ref?: string;
          bytes?: number;
          estimatedTokens?: number;
          files?: unknown[];
          error?: string;
          message?: string;
        }>("/api/context-packs/library/compose", {
          outRef: opts.out,
          sources: opts.from.map((path) => ({ path: resolve(path), label: path })),
        });
        if (res.status !== 201) {
          throw new Error(res.data.message ?? res.data.error ?? `Daemon returned HTTP ${res.status}`);
        }
        console.log(
          `Composed ${res.data.files?.length ?? opts.from.length} file(s) -> ${res.data.ref} ` +
          `(${res.data.bytes ?? 0} bytes, ~${res.data.estimatedTokens ?? 0} tokens).`,
        );
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

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
          console.log("No context packs in library. Author one at ~/.openrig/context-packs/<name>/ then run: rig context sync");
          return;
        }
        for (const e of entries) {
          console.log(`${e.relativePath.padEnd(36)} ${e.name.padEnd(24)} v${String(e.version).padEnd(6)} ${String(e.files.length).padStart(2)} files  ~${String(e.derivedEstimatedTokens).padStart(6)} tokens  ${e.sourceType}  ${e.sourcePath}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  cmd.command("show")
    .argument("<name-or-ref>", "Context pack name or path-like ref")
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
        console.log(`Ref:         ${entry.relativePath}`);
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
    .argument("<name-or-ref>", "Context pack name or path-like ref")
    .description("Show the assembled bundle without delivering it")
    .option("--json", "JSON output")
    .action(async (nameOrRef: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolvePack(client, nameOrRef);
        const res = await client.get<PreviewWire>(`/api/context-packs/library/by-ref/preview?ref=${encodeURIComponent(entry.relativePath)}`);
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
        validateContextPackManifestForInstall(manifestPath);
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
        assertSafeInstallRef(installName);
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
        const syncRes = await client.post<{ count: number; errors?: Array<{ source: string; error: string }>; entries: ContextPackEntryWire[] }>("/api/context-packs/library/sync");
        if (syncRes.status !== 200) {
          // Install succeeded; sync failed → still surface install path.
          if (opts.json) console.log(JSON.stringify({ installedAt: targetDir, syncError: `HTTP ${syncRes.status}` }, null, 2));
          else console.log(`Installed at ${targetDir}; daemon sync failed (HTTP ${syncRes.status}). Run 'rig context sync' manually.`);
          return;
        }
        const syncError = syncRes.data.errors?.find((e) => e.source === targetDir);
        if (syncError) {
          throw new Error(`Installed at ${targetDir}, but daemon rejected the pack during sync: ${syncError.error}`);
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

  cmd.command("rm")
    .argument("<ref>", "Path-like ref of the context pack to remove (e.g. packs/compaction-restore)")
    .description("Remove a context pack from the library by its path-like ref")
    .option("--json", "JSON output")
    .action(async (ref: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.delete<{
          removed?: boolean;
          ref?: string;
          removedPath?: string;
          count?: number;
          error?: string;
          message?: string;
        }>(`/api/context-packs/library/by-ref?ref=${encodeURIComponent(ref)}`);
        if (res.status !== 200) {
          throw new Error(res.data?.message ?? res.data?.error ?? `Daemon returned HTTP ${res.status}`);
        }
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }
        console.log(`Removed context pack '${res.data.ref}'.${typeof res.data.count === "number" ? ` Library now has ${res.data.count} context pack(s).` : ""}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;
}
