// OpenRig's mods in a herdr-app home, installed or updated by each open.
//
// Four mods draw a Rig-layout view (the strip, cell headers, pad and ended cells); they ship in
// packages/daemon/assets/herdr-app/mods and are copied to <app home>/mods/<name>. OpenRig owns only the files it
// copies there, recorded with their hash in
// <app home>/openrig/mods.json:
// - a missing folder is installed whole;
// - an update replaces those files, one at a time and atomically, and removes only files OpenRig itself shipped
//   before and no longer ships. Anything else in the folder (a personal subfolder, dotfile, symlink, herdr-app's own
//   jsconfig.json) is never read, moved or deleted;
// - if one of OpenRig's files was changed, or its name is now a link or a folder, the mod is the person's: the install
//   says which and leaves that folder as it is. The other mods are still installed or updated, and a view still opens
//   with the person's folder in place; only a mod that is missing and can't be installed stops an open.
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const SHIPPED_MODS_DIR = path.resolve(import.meta.dirname, "../../../assets/herdr-app/mods");
/** The mods a Rig-layout view needs; every mods folder has them. */
export const RIG_MODS = ["rig-strip", "rig-cell-header", "rig-pad", "rig-ended"] as const;

/** The regular files directly in a mod folder. */
async function shippedFiles(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith(".")) out.set(entry.name, await readFile(path.join(dir, entry.name), "utf8"));
  }
  return out;
}

/** The named files in an installed folder: their text, null when absent, or "not-a-file" for a link or folder. */
async function namedFiles(dir: string, names: Iterable<string>): Promise<Map<string, string | null | "not-a-file">> {
  const out = new Map<string, string | null | "not-a-file">();
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const info = await lstat(file);
      out.set(name, info.isFile() ? await readFile(file, "utf8") : "not-a-file");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      out.set(name, null);
    }
  }
  return out;
}

export function folderHash(files: Map<string, string>): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) hash.update(`${name}\0${files.get(name)}\0`);
  return hash.digest("hex");
}

async function exists(p: string): Promise<boolean> {
  try { await lstat(p); return true; } catch { return false; }
}

async function writeFileAtomic(file: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.openrig-${process.pid}`);
  await writeFile(tmp, text);
  await rename(tmp, file);
}

export interface ModInstallResult {
  /** Every mod a Rig view needs is in the app home (installed, current, or the person's own folder). */
  ok: boolean;
  /** Shipped mods missing from OpenRig's own install: what to do. Those mods were not installed. */
  error?: string;
  /** Mods a Rig view needs that are not in the app home and could not be installed. */
  missing: string[];
  /** The folder the mods came from. */
  from?: string;
  installed: string[];
  updated: string[];
  unchanged: string[];
  /** Mod folders that aren't OpenRig's (made or changed by the person): left as they are. */
  refused: { name: string; reason: string }[];
}

/** What OpenRig recorded per mod: the hash of its own files, and their names. */
type ManifestEntry = { hash: string; files: string[] };

export async function installRigMods(appHome: string, opts: { shippedDir?: string; check?: boolean } = {}): Promise<ModInstallResult> {
  const shippedDir = opts.shippedDir ?? SHIPPED_MODS_DIR;
  const names: readonly string[] = [...RIG_MODS];
  const manifestPath = path.join(appHome, "openrig", "mods.json");
  let manifest: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
  } catch { /* first install */ }
  const result: ModInstallResult = { ok: true, from: shippedDir, missing: [], installed: [], updated: [], unchanged: [], refused: [] };
  const plan: { name: string; files: Map<string, string>; dest: string; kind: "installed" | "updated"; drop: string[] }[] = [];
  for (const name of names) {
    const shipped = await shippedFiles(path.join(shippedDir, name)).catch(() => null);
    if (!shipped?.size) {
      result.error = `${result.error ? `${result.error} ` : ""}OpenRig's ${name} mod is missing from ${shippedDir}; reinstall OpenRig.`;
      continue;
    }
    const dest = path.join(appHome, "mods", name);
    // A linked mod folder (a dotfiles copy, say) is never written through: an update would land in the link's target.
    if ((await lstat(dest).catch(() => null))?.isSymbolicLink()) {
      result.refused.push({ name, reason: `${dest} is a link; OpenRig doesn't write through it. It was left as it is.` });
      continue;
    }
    if (!await exists(dest)) { plan.push({ name, files: shipped, dest, kind: "installed", drop: [] }); continue; }
    const entry = manifest[name] as Partial<ManifestEntry> | undefined;
    const recorded: ManifestEntry | undefined = entry && typeof entry.hash === "string" && Array.isArray(entry.files)
      && entry.files.every((f): f is string => typeof f === "string")
      ? { hash: entry.hash, files: entry.files }
      : undefined;
    // OpenRig's files there now: the ones it recorded, else (never recorded) the names it ships.
    const own = await namedFiles(dest, new Set([...(recorded?.files ?? []), ...shipped.keys()]));
    if ([...own.values()].includes("not-a-file")) {
      result.refused.push({ name, reason: `${dest} holds a link or folder where OpenRig keeps one of its files; it was left as it is.` });
      continue;
    }
    const present = new Map([...own].filter((e): e is [string, string] => typeof e[1] === "string"));
    const current = new Map([...present].filter(([file]) => shipped.has(file)));
    if (current.size === shipped.size && folderHash(current) === folderHash(shipped)
      && (!recorded || recorded.files.every((f) => shipped.has(f) || !present.has(f)))) {
      result.unchanged.push(name);
      continue;
    }
    if (!recorded || folderHash(new Map([...present].filter(([file]) => recorded.files.includes(file)))) !== recorded.hash) {
      result.refused.push({ name, reason: `${dest} isn't the copy OpenRig installed (its files were made or changed by someone else); it was left as it is.` });
      continue;
    }
    // A file this release newly ships (not recorded as OpenRig's) that is already there is the person's: never replace it.
    const collisions = [...shipped.keys()].filter((f) => !recorded.files.includes(f) && present.has(f) && present.get(f) !== shipped.get(f));
    if (collisions.length) {
      result.refused.push({ name, reason: `${dest} already has ${collisions.join(", ")}, which this OpenRig release now ships as its own; it was left as it is. Rename or remove ${collisions.length > 1 ? "them" : "it"} to let the next open install OpenRig's copy.` });
      continue;
    }
    plan.push({ name, files: shipped, dest, kind: "updated", drop: recorded.files.filter((f) => !shipped.has(f) && present.has(f)) });
  }
  if (opts.check) { result.ok = plan.length === 0 && !result.refused.length && !result.error; return result; }
  await mkdir(path.dirname(manifestPath), { recursive: true });
  for (const item of plan) {
    if (item.kind === "installed") {
      // A new folder is written beside, then moved in whole, so herdr never loads a half-written mod.
      const staging = path.join(path.dirname(item.dest), `.${item.name}.openrig-${process.pid}`);
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true });
      for (const [file, text] of item.files) await writeFile(path.join(staging, file), text);
      await rename(staging, item.dest);
    } else {
      // Only OpenRig's own files change; everything else in the folder stays as it is.
      for (const [file, text] of item.files) await writeFileAtomic(path.join(item.dest, file), text);
      for (const file of item.drop) await rm(path.join(item.dest, file), { force: true });
    }
    manifest[item.name] = { hash: folderHash(item.files), files: [...item.files.keys()].sort() };
    result[item.kind].push(item.name);
  }
  for (const name of result.unchanged) {
    const shipped = await shippedFiles(path.join(shippedDir, name));
    manifest[name] = { hash: folderHash(shipped), files: [...shipped.keys()].sort() };
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // A refused folder is the person's and stays; a mod with no folder at all (or a link to nothing) is missing.
  for (const name of names) if (!await stat(path.join(appHome, "mods", name)).then(() => true, () => false)) result.missing.push(name);
  result.ok = result.missing.length === 0;
  return result;
}

export function describeModInstall(r: ModInstallResult): string {
  const why = [r.error, ...r.refused.map((x) => x.reason)].filter(Boolean).join(" ");
  if (r.missing.length) return `OpenRig's herdr-app mods ${r.missing.join(", ")} are missing and could not be installed.${why ? ` ${why}` : ""}`;
  const parts = [r.installed.length ? `installed ${r.installed.join(", ")}` : "", r.updated.length ? `updated ${r.updated.join(", ")}` : "",
    r.unchanged.length ? `${r.unchanged.length} already current` : "", r.refused.length ? `kept ${r.refused.map((x) => x.name).join(", ")} unchanged` : ""].filter(Boolean);
  return `OpenRig's herdr-app mods: ${parts.join("; ")}.${why ? ` ${why}` : ""}`;
}
