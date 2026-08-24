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
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigStore } from "../config-store.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , statusGuardMessage} from "../daemon-lifecycle.js";
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

// Slice-03 lineage repair (R2 HIGH-2): the install boundary mirrors the daemon
// bounded, delimiter-free version token (ref-safety.SAFE_VERSION) so an unsafe
// version is rejected BEFORE any local write — matching the per-segment ref
// mirror above.
const SAFE_INSTALL_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/;

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

// Slice-03 lineage repair (R2 HIGH-1): a lexically-safe path-like install ref
// can still escape the store if one of its parent namespace segments is a
// symlink (or a non-directory). Walk every ANCESTOR segment under the store root
// and reject before the copy — the FS-canonical containment the lexical ref
// check alone cannot give, mirroring the daemon compose namespace walk
// (context-pack-library-service.ts). A not-yet-created segment (ENOENT) is safe:
// cpSync will materialize it as a real directory.
function assertDestinationNamespaceContained(targetRoot: string, installName: string): void {
  const segments = installName.split("/");
  let cursor = targetRoot;
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(cursor);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
      throw err;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `unsafe install ref '${installName}' — its namespace segment '${cursor}' is a symlink or non-directory, ` +
          `so the copy would escape the context store root. Remove it or install under a different --name.`,
      );
    }
  }
}

// Kept in lockstep with the daemon parser's ALLOWED_FILE_SUFFIXES (manifest-parser.ts).
// OPR.0.5.3.7 R2 added .sh/.ts (skill helper assets, served as text); the install
// validator must accept what the daemon will serve.
const ALLOWED_CONTEXT_PACK_SUFFIXES = new Set([".md", ".markdown", ".yaml", ".yml", ".txt", ".sh", ".ts"]);

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
  const versionStr = String(obj["version"]);
  if (!SAFE_INSTALL_VERSION.test(versionStr)) {
    throw new Error(
      `manifest at ${manifestPath} has an invalid version '${versionStr}' — a version must be a single bounded ` +
        `token [A-Za-z0-9][A-Za-z0-9._+-]{0,31} (no ':' or separator, no whitespace, ≤32 chars).`,
    );
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

function isHttpUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

async function fetchTextOrThrow(url: string, what: string): Promise<{ text: string; finalUrl: string }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Could not reach ${what} at ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`Could not fetch ${what} at ${url}: HTTP ${res.status} ${res.statusText}`.trim());
  // res.url is the FINAL url after any redirects — declared files must resolve
  // relative to it, not the caller's original spelling (r2 MEDIUM-1).
  return { text: await res.text(), finalUrl: res.url || url };
}

// OPR.0.5.3.7 R4 — install a context pack from a URL. <url> points at the pack's
// manifest.yaml (a trailing '/' is treated as '<url>manifest.yaml'); every
// files[].path is fetched relative to that manifest. ATOMIC BY CONSTRUCTION:
// everything stages into a temp SIBLING of the target and is published by one
// renameSync, so a malformed manifest, an unreachable URL, or a missing declared
// file leaves NO partial pack behind. Deliberately dumb: no registry, no cache.
async function installPackFromUrl(
  url: string,
  overrideName: string | undefined,
  targetRoot: string,
): Promise<{ targetDir: string; installName: string }> {
  const manifestUrl = url.endsWith("/") ? `${url}manifest.yaml` : url;
  mkdirSync(targetRoot, { recursive: true });
  const staging = mkdtempSync(join(targetRoot, ".tmp-add-"));
  try {
    // Fetch + validate the manifest before touching the target namespace.
    const { text: manifestText, finalUrl: finalManifestUrl } = await fetchTextOrThrow(manifestUrl, "manifest");
    writeFileSync(join(staging, "manifest.yaml"), manifestText);
    validateContextPackManifestForInstall(join(staging, "manifest.yaml"));
    const manifest = parseYaml(manifestText) as { name: string; files: Array<{ path: string }> };
    const installName = overrideName ?? manifest.name;
    assertSafeInstallRef(installName);
    assertDestinationNamespaceContained(targetRoot, installName);
    const targetDir = join(targetRoot, installName);
    if (existsSync(targetDir)) {
      throw new Error(`A context pack named '${installName}' already exists at ${targetDir}. Remove it first or use --name to install under a different name.`);
    }
    // Fetch every declared file relative to the manifest's FINAL url (after
    // redirects), via the platform URL resolver — never the caller's original
    // spelling (r2 MEDIUM-1: a redirected manifest must not resolve files against
    // the stale request base).
    //
    // BOUNDARY (r2 HIGH-1): new URL() also honors an ABSOLUTE f.path, and the
    // manifest validator accepts a URL-shaped value as a filesystem-relative
    // path. Require every resolved file URL to stay under the manifest's own
    // directory (same origin + path prefix) so a stranger-supplied manifest can
    // never make add fetch cross-origin or climb out of its pack. The trailing
    // slash on the base defeats prefix-sibling ('/pack' vs '/pack-evil') tricks.
    const manifestDirUrl = new URL("./", finalManifestUrl).href;
    for (const f of manifest.files) {
      const fileUrl = new URL(f.path, finalManifestUrl).href;
      if (!fileUrl.startsWith(manifestDirUrl)) {
        throw new Error(
          `manifest file '${f.path}' resolves to ${fileUrl}, outside the pack directory ${manifestDirUrl}. ` +
            `Declared files must be relative to the manifest (no absolute URLs, no escaping the pack).`,
        );
      }
      const { text: fileText } = await fetchTextOrThrow(fileUrl, `file '${f.path}'`);
      const dest = join(staging, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, fileText);
    }
    // Re-validate the on-disk staged pack, then publish atomically.
    validateContextPackManifestForInstall(join(staging, "manifest.yaml"));
    assertTreeHasNoSymlinks(staging);
    renameSync(staging, targetDir);
    return { targetDir, installName };
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
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
  rig context trace --rig product-team --seat orch1-lead --name LEARNED.md
`);

  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  async function getClient(): Promise<DaemonClient> {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      // B8-1b: epistemic-matched language via the one helper (down ≠ busy).
      const gm = statusGuardMessage(status); throw new Error(`${gm.fact} ${gm.action}`);
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  // OPR.0.5.3.6 — the productized chain-file trace. Daemon-independent by
  // design: the walk is a config read + filesystem reads, so it works on a
  // box whose daemon is down (orientation is exactly when that happens).
  cmd.command("trace")
    .description("Walk the topology tree for one chain filename (instance -> rig -> seat), keyed off topology.root")
    .requiredOption("--rig <rig>", "Rig name (the rigs/<rig> altitude)")
    .option("--seat <seat>", "Seat id (the seats/<seat> altitude); omit for a rig-level trace")
    .requiredOption("--name <file>", "Chain filename, identical at every altitude (e.g. LEARNED.md, CULTURE.md)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { rig: string; seat?: string; name: string; json?: boolean }) => {
      const { ConfigStore } = await import("../config-store.js");
      const { traceTopologyChain } = await import("../lib/topology-trace.js");
      const store = new ConfigStore();
      const resolved = store.resolveWithSource("topology.root");
      let result;
      try {
        result = traceTopologyChain({
          topologyRoot: String(resolved.value),
          name: opts.name,
          rig: opts.rig,
          seat: opts.seat ?? null,
        });
      } catch (err) {
        // r2-B3: traversal-shaped input is a clean refusal, never a stack trace.
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      // Advisories go to stderr on BOTH output modes — a legacy read must
      // never pass silently, and stdout stays clean for piping.
      for (const level of result.levels) {
        if (level.advisory) console.error(`ADVISORY ${level.advisory}`);
      }
      if (opts.json) {
        console.log(JSON.stringify({ topologyRootSource: resolved.source, ...result }, null, 2));
        return;
      }
      console.log(`chain "${result.name}" under topology.root=${result.topologyRoot} (source: ${resolved.source})`);
      for (const level of result.levels) {
        if (level.source === "absent") {
          console.log(`\n== ${level.altitude} — absent (${level.path})`);
          continue;
        }
        const origin = level.source === "legacy" ? ` [LEGACY: ${level.resolvedPath}]` : "";
        console.log(`\n== ${level.altitude} — ${level.path}${origin}`);
        console.log(level.content?.trimEnd() ?? "");
      }
    });

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

  // OPR.0.5.3.7 R1 — the PULL verb: an agent-facing serving verb over the EXISTING assembler
  // path (the same by-ref/preview machinery `preview` uses — never a parallel assembler).
  // `preview` is the operator's pre-send check; `get` is what a seat runs on demand to LOAD a
  // library entry. Output is the assembled bundle itself (so the agent consumes exactly those
  // bytes), warnings to stderr; `--json` for programmatic use. Naming ruled: `rig context get`
  // (one library, one verb — NOT `rig skills get`; "skills" is an org category in the library).
  cmd.command("get")
    .argument("<name-or-ref>", "Context library entry name, path-like ref, or address (<pack-ref>/<file>#H2-slug/H3-slug)")
    .description("Serve the assembled bundle for an agent to load on demand (the pull verb)")
    .option("--json", "JSON output")
    .action(async (nameOrRef: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        // OPR.0.5.3.5 Atom 4c (Q4: one `name#H2/H3` form across the verb
        // family): an address routes to the daemon's single resolver home;
        // stdout is exactly the resolved span bytes so an agent consumes the
        // addressed section and nothing else. Fail-loud passthrough — the
        // daemon names every failure; this verb adds nothing to it.
        if (nameOrRef.includes("#")) {
          const res = await client.get<{ text?: string; message?: string; error?: string }>(
            `/api/context-packs/library/resolve-address?address=${encodeURIComponent(nameOrRef)}`,
          );
          if (res.status !== 200) {
            throw new Error(res.data?.message ?? res.data?.error ?? `Daemon returned HTTP ${res.status} for resolve-address`);
          }
          if (opts.json) console.log(JSON.stringify(res.data, null, 2));
          else console.log(res.data.text);
          return;
        }
        const entry = await resolvePack(client, nameOrRef);
        const res = await client.get<PreviewWire>(`/api/context-packs/library/by-ref/preview?ref=${encodeURIComponent(entry.relativePath)}`);
        if (res.status !== 200) throw new Error(`Daemon returned HTTP ${res.status}`);
        const bundle = res.data;
        if (opts.json) {
          console.log(JSON.stringify(bundle, null, 2));
          return;
        }
        // Warnings go to stderr so stdout is exactly the served bundle bytes.
        if (bundle.missingFiles.length > 0) {
          console.error(`Warning: ${bundle.missingFiles.length} file(s) referenced by manifest are missing on disk.`);
          for (const m of bundle.missingFiles) console.error(`  - ${m.path} (role: ${m.role})`);
        }
        console.log(bundle.bundleText);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // OPR.0.5.3.5 Atom 4d — situation-composed delivery (the profile verb).
  // Serving only: pieces to stdout with their source labels (Q2-Amendment 1),
  // budget report + provenance warnings to stderr. Delivery-free like every
  // library verb — nothing here sends to a seat. Naming rig/seat (or mission)
  // is the caller's explicit grant of read access to that directory subtree.
  cmd.command("profile")
    .argument("<name-or-ref>", "Context pack name or path-like ref (its manifest must declare atoms)")
    .requiredOption("--situation <situation>", "fresh | handover | post-compaction")
    // r1 4d obs 2: default from the seat's own environment — a codex seat that
    // forgets the flag must not silently get a claude profile (mini-req 3 is
    // the rule that the runtimes compose DIFFERENT profiles). Flag beats env;
    // an unrecognized env value falls back to claude rather than erroring a
    // surface the env owner may not control.
    .option("--runtime <runtime>", "claude | codex (default: $OPENRIG_RUNTIME, else claude)")
    .option("--budget <tokens>", "Situation token budget — overage is REPORTED, never truncated")
    .option("--rig <rig>", "With --seat: grant read access to that seat's tree (seat: atoms)")
    .option("--seat <seat>", "With --rig: the seat whose tree seat: atoms may read")
    .option("--mission <mission>", "Grant read access to that mission's tree (mission: atoms)")
    .option("--json", "JSON output (the full composed profile)")
    .action(async (nameOrRef: string, opts: { situation: string; runtime?: string; budget?: string; rig?: string; seat?: string; mission?: string; json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolvePack(client, nameOrRef);
        // r1 F2: the product's runtime vocabulary is "claude-code" / "codex"
        // (the adapters' values, live on real seats) — map it EXPLICITLY. A
        // genuinely unknown value falls back to claude WITH A VOICE: a future
        // third runtime must not silently get a claude profile (the exact
        // mini-req 3 hazard this default exists to close).
        const envRuntime = process.env["OPENRIG_RUNTIME"];
        let runtime = opts.runtime;
        if (runtime === undefined) {
          if (envRuntime === "codex") runtime = "codex";
          else if (envRuntime === "claude-code" || envRuntime === "claude") runtime = "claude";
          else {
            if (envRuntime) console.error(`Warning: unrecognized OPENRIG_RUNTIME '${envRuntime}' — composing the claude profile; pass --runtime to override.`);
            runtime = "claude";
          }
        }
        const params = new URLSearchParams({ ref: entry.relativePath, situation: opts.situation, runtime });
        if (opts.budget !== undefined) params.set("budget", opts.budget);
        if (opts.rig !== undefined) params.set("rig", opts.rig);
        if (opts.seat !== undefined) params.set("seat", opts.seat);
        if (opts.mission !== undefined) params.set("mission", opts.mission);
        const res = await client.get<{
          pieces?: Array<{ atomId: string; address: string; sourceKind: string; text: string; estimatedTokens: number }>;
          totalEstimatedTokens?: number;
          budget?: { limitTokens: number; overageTokens: number; dropCandidates: Array<{ atomId: string; priority: string; estimatedTokens: number }> };
          provenanceWarnings?: string[];
          message?: string;
          error?: string;
        }>(`/api/context-packs/library/by-ref/profile?${params.toString()}`);
        if (res.status !== 200) {
          throw new Error(res.data?.message ?? res.data?.error ?? `Daemon returned HTTP ${res.status} for by-ref/profile`);
        }
        const profile = res.data;
        if (opts.json) {
          console.log(JSON.stringify(profile, null, 2));
          return;
        }
        // Warnings and the budget report ride stderr so stdout is exactly the
        // composed walk an agent consumes.
        for (const w of profile.provenanceWarnings ?? []) console.error(`PROVENANCE ${w}`);
        if (profile.budget) {
          console.error(
            `BUDGET: over by ~${profile.budget.overageTokens} tokens (limit ${profile.budget.limitTokens}); ` +
            `drop candidates in order: ${profile.budget.dropCandidates.map((d) => `${d.atomId} (${d.priority}, ~${d.estimatedTokens})`).join(", ")}`,
          );
        }
        for (const p of profile.pieces ?? []) {
          // r1 4d obs 1: the escape marker rides the FRAMING header, so an
          // agent that discards stderr still learns a piece's bytes came from
          // outside its root — self-describing payload, zero composed bytes
          // touched.
          const escaped = (p as { provenance?: { escapesRoot?: boolean } }).provenance?.escapesRoot ? " !ESCAPED-ROOT" : "";
          console.log(`=== ${p.atomId} [${p.sourceKind}${escaped}] ${p.address} (~${p.estimatedTokens} tokens)`);
          console.log(p.text);
          console.log("");
        }
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
    .argument("<source>", "Local directory OR http(s):// URL of a context pack (manifest.yaml + files)")
    .description("Install a context pack from a local directory or a URL into the context-packs landing zone")
    .option("--name <name>", "Override the install name (defaults to the manifest name / source basename)")
    .option("--json", "JSON output")
    .action(async (source: string, opts: { name?: string; json?: boolean }) => {
      try {
        // OPR.0.5.3.7 R4 — config-resolved landing zone (env > config > $OPENRIG_HOME/context-packs),
        // never a hardcoded ~/.openrig literal; the daemon resolves the same key.
        const targetRoot = new ConfigStore().resolve().context.packsRoot;
        let targetDir: string;
        if (isHttpUrl(source)) {
          // R4 — URL install: fetch → validate → atomic stage+rename (no partial pack).
          ({ targetDir } = await installPackFromUrl(source, opts.name, targetRoot));
        } else {
          // Local directory install.
          if (!existsSync(source)) throw new Error(`Source directory not found: ${source}`);
          const stat = lstatSync(source);
          if (stat.isSymbolicLink()) throw new Error(`Source must not be a symlink: ${source}`);
          if (!stat.isDirectory()) throw new Error(`Source must be a directory containing manifest.yaml: ${source}`);
          const manifestPath = join(source, "manifest.yaml");
          if (!existsSync(manifestPath)) {
            throw new Error(`Source directory must contain manifest.yaml: ${source}`);
          }
          validateContextPackManifestForInstall(manifestPath);
          const installName = opts.name ?? (() => {
            try {
              const raw = readFileSync(manifestPath, "utf-8");
              const m = raw.match(/^name:\s*['"]?([^'"\n]+)['"]?\s*$/m);
              return m?.[1]?.trim() || basename(source);
            } catch {
              return basename(source);
            }
          })();
          assertSafeInstallRef(installName);
          assertTreeHasNoSymlinks(source);
          mkdirSync(targetRoot, { recursive: true });
          assertDestinationNamespaceContained(targetRoot, installName);
          targetDir = join(targetRoot, installName);
          let targetExists = false;
          try {
            lstatSync(targetDir);
            targetExists = true;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
          if (targetExists) {
            throw new Error(`A context pack named '${installName}' already exists at ${targetDir}. Remove it first or use --name to install under a different name.`);
          }
          cpSync(source, targetDir, { recursive: true });
        }
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
