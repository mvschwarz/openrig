import { Command } from "commander";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getDefaultOpenRigPath } from "../openrig-compat.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface LibraryEntry {
  id: string;
  kind: string;
  name: string;
  version: string;
  sourceType: string;
  sourcePath: string;
  relativePath: string;
  updatedAt: string;
  summary?: string;
}

interface AddSpecSource {
  inputPath: string;
  yamlPath: string;
  installName: string;
  installKind: "file" | "directory";
  libraryEntrySuffix: string;
}

function normalizePathForMatch(path: string): string {
  return path.replaceAll("\\", "/");
}

function requireRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
}

function assertTreeHasNoSymlinks(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absPath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Spec directories must not contain symlinks: ${absPath}`);
      }
      if (entry.isDirectory()) {
        stack.push(absPath);
      }
    }
  }
}

function resolveAddSpecSource(inputPath: string): AddSpecSource {
  if (!existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  const stat = lstatSync(inputPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Spec path must not be a symlink: ${inputPath}`);
  }

  if (stat.isFile()) {
    return {
      inputPath,
      yamlPath: inputPath,
      installName: basename(inputPath),
      installKind: "file",
      libraryEntrySuffix: basename(inputPath),
    };
  }

  if (!stat.isDirectory()) {
    throw new Error(`Spec path must be a YAML file or spec directory: ${inputPath}`);
  }

  const rootSpec = ["rig.yaml", "rig.yml", "agent.yaml", "agent.yml"]
    .map((candidate) => join(inputPath, candidate))
    .find((candidate) => existsSync(candidate));
  if (!rootSpec) {
    throw new Error(`Spec directory must contain rig.yaml or agent.yaml: ${inputPath}`);
  }
  requireRegularFile(rootSpec, "Root spec file");

  const installName = basename(inputPath);
  return {
    inputPath,
    yamlPath: rootSpec,
    installName,
    installKind: "directory",
    libraryEntrySuffix: normalizePathForMatch(join(installName, basename(rootSpec))),
  };
}

function installSpecSource(source: AddSpecSource, userRoot: string): string {
  mkdirSync(userRoot, { recursive: true });
  const dest = join(userRoot, source.installName);

  if (source.installKind === "file") {
    requireRegularFile(source.inputPath, "Spec file");
    copyFileSync(source.inputPath, dest);
    return dest;
  }

  if (existsSync(dest)) {
    throw new Error(`A spec directory already exists at ${dest}. Remove or rename it before adding this spec.`);
  }

  assertTreeHasNoSymlinks(source.inputPath);
  const tempParent = mkdtempSync(join(userRoot, ".spec-add-"));
  const tempDest = join(tempParent, source.installName);
  try {
    cpSync(source.inputPath, tempDest, { recursive: true, errorOnExist: true, force: false });
    renameSync(tempDest, dest);
  } catch (err) {
    rmSync(tempParent, { recursive: true, force: true });
    throw err;
  }
  rmSync(tempParent, { recursive: true, force: true });
  return dest;
}

/**
 * Shared name resolution for library specs.
 * Returns the matching entry, or throws with guidance on ambiguity/not-found.
 */
export async function resolveLibrarySpec(
  client: DaemonClient,
  nameOrId: string,
): Promise<LibraryEntry> {
  const res = await client.get<LibraryEntry[]>("/api/specs/library");
  const entries = res.data ?? [];

  // Try exact ID match first
  const byId = entries.find((e) => e.id === nameOrId);
  if (byId) return byId;

  // Try name match
  const byName = entries.filter((e) => e.name === nameOrId);
  if (byName.length === 1) return byName[0]!;

  if (byName.length > 1) {
    const candidates = byName.map((e) => `  ${e.id} — ${e.sourcePath}`).join("\n");
    throw new Error(
      `Spec name '${nameOrId}' is ambiguous — ${byName.length} entries match.\nUse the ID instead:\n${candidates}`
    );
  }

  throw new Error(
    `Spec '${nameOrId}' not found in library. Run 'rig specs ls' to see available rigs, agents, and managed apps.`
  );
}

export function specsCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("specs")
    .description("Browse, preview, and manage the spec library, including managed apps")
    .addHelpText("after", `
Examples:
  rig specs ls
  rig specs preview secrets-manager
  rig specs show vault-specialist
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

  // specs ls
  cmd.command("ls")
    .description("List library rigs, agents, and managed apps")
    .option("--kind <kind>", "Filter by kind (rig or agent)")
    .option("--json", "JSON output")
    .action(async (opts: { kind?: string; json?: boolean }) => {
      try {
        const client = await getClient();
        const url = opts.kind ? `/api/specs/library?kind=${opts.kind}` : "/api/specs/library";
        const res = await client.get<LibraryEntry[]>(url);
        const entries = res.data ?? [];

        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        if (entries.length === 0) {
          console.log("No specs in library. Add specs with: rig specs add <path>");
          return;
        }

        for (const e of entries) {
          console.log(`${e.name.padEnd(24)} ${e.kind.padEnd(8)} ${e.version.padEnd(8)} ${e.sourceType.padEnd(12)} ${e.sourcePath}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs show
  cmd.command("show")
    .argument("<name-or-id>", "Spec name or library ID")
    .description("Show spec metadata and path")
    .option("--json", "JSON output")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveLibrarySpec(client, nameOrId);

        if (opts.json) {
          console.log(JSON.stringify(entry, null, 2));
          return;
        }

        console.log(`Name:     ${entry.name}`);
        console.log(`Kind:     ${entry.kind}`);
        console.log(`Version:  ${entry.version}`);
        console.log(`Source:   ${entry.sourceType}`);
        console.log(`Path:     ${entry.sourcePath}`);
        console.log(`ID:       ${entry.id}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs preview
  cmd.command("preview")
    .argument("<name-or-id>", "Spec name or library ID")
    .description("Show structured spec review, including managed app details")
    .option("--json", "JSON output")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveLibrarySpec(client, nameOrId);
        const res = await client.get<Record<string, unknown>>(`/api/specs/library/${encodeURIComponent(entry.id)}/review`);

        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          return;
        }

        const review = res.data;
        console.log(`${review["name"]} (${review["kind"]}, ${review["format"] ?? "agent"})`);
        if (review["summary"]) console.log(`  ${review["summary"]}`);
        console.log(`  Source: ${review["sourcePath"]} [${review["sourceState"]}]`);

        if (review["kind"] === "rig" && review["format"] === "pod_aware") {
          const pods = (review["pods"] as Array<{ id: string; members: Array<{ id: string; runtime: string }> }>) ?? [];
          for (const pod of pods) {
            console.log(`  Pod: ${pod.id} (${pod.members.length} members)`);
            for (const m of pod.members) {
              console.log(`    ${m.id} — ${m.runtime}`);
            }
          }
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs add
  cmd.command("add")
    .argument("<path>", "Path to YAML spec file or spec directory")
    .description("Add a spec file or full spec directory to the user library")
    .option("--json", "JSON output")
    .action(async (inputPath: string, opts: { json?: boolean }) => {
      try {
        const source = resolveAddSpecSource(inputPath);
        const yaml = readFileSync(source.yamlPath, "utf-8");
        const client = await getClient();

        // Validate via daemon
        let kind = "rig";
        let res = await client.post<Record<string, unknown>>("/api/specs/review/rig", { yaml });
        if (res.status >= 400) {
          res = await client.post<Record<string, unknown>>("/api/specs/review/agent", { yaml });
          kind = "agent";
        }
        if (res.status >= 400) {
          throw new Error("File is not a valid RigSpec or AgentSpec. Fix validation errors before adding.");
        }

        // Copy to user library
        const userRoot = getDefaultOpenRigPath("specs");
        const dest = installSpecSource(source, userRoot);

        // Sync and find the new entry
        const syncRes = await client.post<LibraryEntry[]>("/api/specs/library/sync");
        const entries = syncRes.data ?? [];
        const name = (res.data as Record<string, unknown>)["name"] as string ?? source.installName;
        const newEntry = entries.find((e) => (
          e.name === name &&
          normalizePathForMatch(e.sourcePath).endsWith(source.libraryEntrySuffix)
        ));

        if (opts.json) {
          console.log(JSON.stringify({ name, kind, path: dest, id: newEntry?.id ?? null, entry: newEntry ?? null }));
          return;
        }

        console.log(`Added ${kind} spec '${name}' to library at ${dest}`);
        if (newEntry) {
          console.log(`  ID: ${newEntry.id}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs sync
  cmd.command("sync")
    .description("Rescan spec library roots")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const res = await client.post<LibraryEntry[]>("/api/specs/library/sync");
        const entries = res.data ?? [];

        if (opts.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        console.log(`Library synced: ${entries.length} spec(s) indexed.`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs remove
  cmd.command("remove")
    .argument("<name-or-id>", "Spec name or library ID")
    .description("Remove a user-file spec from the library")
    .option("--json", "JSON output")
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveLibrarySpec(client, nameOrId);
        const res = await client.delete<Record<string, unknown>>(`/api/specs/library/${encodeURIComponent(entry.id)}`);

        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          if (res.status >= 400) process.exitCode = 1;
          return;
        }

        if (res.status >= 400) {
          console.error((res.data["error"] as string | undefined) ?? `Remove failed (HTTP ${res.status})`);
          process.exitCode = 1;
          return;
        }

        console.log(`Removed ${res.data["name"] ?? entry.name} from the library`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  // specs rename
  cmd.command("rename")
    .argument("<name-or-id>", "Spec name or library ID")
    .argument("<new-name>", "New spec name")
    .description("Rename a user-file spec in the library")
    .option("--json", "JSON output")
    .action(async (nameOrId: string, newName: string, opts: { json?: boolean }) => {
      try {
        const client = await getClient();
        const entry = await resolveLibrarySpec(client, nameOrId);
        const res = await client.post<Record<string, unknown>>(`/api/specs/library/${encodeURIComponent(entry.id)}/rename`, {
          name: newName,
        });

        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          if (res.status >= 400) process.exitCode = 1;
          return;
        }

        if (res.status >= 400) {
          console.error((res.data["error"] as string | undefined) ?? `Rename failed (HTTP ${res.status})`);
          process.exitCode = 1;
          return;
        }

        const renamed = (res.data["entry"] as Record<string, unknown> | undefined) ?? {};
        console.log(`Renamed ${entry.name} to ${renamed["name"] ?? newName}`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;
}
