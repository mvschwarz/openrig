// OpenRig's mods in a herdr-app home (`rig herdr install`, and on an open that finds them missing).
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
      result.refused.push({ name, reason: `${dest} already has ${collisions.join(", ")}, which this OpenRig release now ships as its own; it was left as it is. Rename or remove ${collisions.length > 1 ? "them" : "it"} and run \`rig herdr install\` again.` });
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
    r.unchanged.length ? `${r.unchanged.length} already current` : "", r.refused.length ? `kept ${r.refused.map((x) => x.name).join(", ")} as they are` : ""].filter(Boolean);
  return `OpenRig's herdr-app mods: ${parts.join("; ")}.${why ? ` ${why}` : ""}`;
}

/** The keys that move the keyboard between a Rig view's cells, in keys.json section `layout:rig`. */
export const DEFAULT_RIG_KEYS: Record<string, "left" | "right" | "up" | "down"> = {
  "alt-left": "left", "alt-right": "right", "alt-up": "up", "alt-down": "down",
};
const RIG_KEY_SECTION = "layout:rig";

export interface KeysResult {
  ok: boolean;
  /** Keys bound (or, with remove, unbound) by this run. */
  changed: string[];
  /** Keys left alone, with why: already bound to something else where it would win or clash. */
  conflicts: { key: string; reason: string }[];
  backup?: string;
  message: string;
}

/**
 * Opt-in (`rig herdr install --keys`), reversible (`--remove`). Only OpenRig's own entries in `layout:rig` are added
 * or removed; any key already bound there or in a section that wins while a cell has focus (`terminal`) is left as
 * it is and reported. keys.json must exist (herdr-app writes it on first start): creating it would replace the
 * person's defaults. Herdr treats any edit as making the whole file the person's, so later releases' new default
 * shortcuts are no longer added to it automatically; the message says so.
 */
/** herdr-app's own shipped `global` bindings for OpenRig's keys (`defaults/keys.json`, herdr-app 0.1.13). A key still
 *  bound to its default is not a conflict: in the Rig layout, `layout:rig` takes it over (`pane.go` doesn't move between
 *  Rig cells, which are layout blocks; `agent.prev`/`agent.next` stay on every other layout). Any other global binding
 *  is the person's and wins. */
const HERDR_APP_GLOBAL_DEFAULTS: Record<string, string> = {
  "alt-left": "pane.go:left", "alt-right": "pane.go:right", "alt-up": "agent.prev", "alt-down": "agent.next",
};

export async function installRigKeys(appHome: string, opts: { remove?: boolean; keys?: Record<string, "left" | "right" | "up" | "down"> } = {}): Promise<KeysResult> {
  const file = path.join(appHome, "keys.json");
  let text: string;
  try { text = await readFile(file, "utf8"); } catch {
    return { ok: false, changed: [], conflicts: [], message: `${file} doesn't exist yet. Start herdr-app once (it writes its default keys), then run this again.` };
  }
  let keys: Record<string, Record<string, unknown>>;
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the root is not an object");
    keys = raw as Record<string, Record<string, unknown>>;
  } catch (e) {
    return { ok: false, changed: [], conflicts: [], message: `${file} is not valid JSON (${(e as Error).message}); it was not changed.` };
  }
  const wanted = opts.keys ?? DEFAULT_RIG_KEYS;
  const section = { ...(keys[RIG_KEY_SECTION] ?? {}) };
  const changed: string[] = [];
  const conflicts: KeysResult["conflicts"] = [];
  const shadowed: string[] = [];
  if (opts.remove) {
    for (const [key, action] of Object.entries(section)) {
      if (typeof action === "string" && action.startsWith("rig-strip.")) { delete section[key]; changed.push(key); }
    }
  } else {
    for (const [key, dir] of Object.entries(wanted)) {
      const action = `rig-strip.${dir}`;
      if (section[key] === action) continue;
      if (section[key] !== undefined) { conflicts.push({ key, reason: `already bound to ${JSON.stringify(section[key])} in ${RIG_KEY_SECTION}` }); continue; }
      if (keys.terminal?.[key] !== undefined) { conflicts.push({ key, reason: `bound in "terminal", which wins while a cell has focus` }); continue; }
      const global = keys.global?.[key];
      if (global !== undefined && global !== HERDR_APP_GLOBAL_DEFAULTS[key]) { conflicts.push({ key, reason: `bound in "global" to ${JSON.stringify(global)}; ${RIG_KEY_SECTION} would hide it in the Rig layout` }); continue; }
      if (global !== undefined) shadowed.push(`${key} (${String(global)})`);
      section[key] = action;
      changed.push(key);
    }
  }
  if (!changed.length) {
    return { ok: conflicts.length === 0, changed, conflicts,
      message: opts.remove ? "No OpenRig keys to remove." : conflicts.length ? `No keys bound: ${conflicts.map((c) => `${c.key} ${c.reason}`).join("; ")}.` : "OpenRig's Rig keys are already bound." };
  }
  const next = { ...keys };
  if (Object.keys(section).length) next[RIG_KEY_SECTION] = section; else delete next[RIG_KEY_SECTION];
  const backup = path.join(appHome, "openrig", "keys.json.before-openrig");
  await mkdir(path.dirname(backup), { recursive: true });
  try { await readFile(backup, "utf8"); } catch { await writeFile(backup, text); }
  const tmp = path.join(appHome, `.keys.json.openrig-${process.pid}`);
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, file);
  return {
    ok: conflicts.length === 0, changed, conflicts, backup,
    message: opts.remove
      ? `Removed OpenRig's keys (${changed.join(", ")}) from ${RIG_KEY_SECTION}. Your original file is kept at ${backup}.`
      : `Bound ${changed.join(", ")} in ${RIG_KEY_SECTION} to move between a view's cells.`
        + `${shadowed.length ? ` In the Rig layout they replace herdr-app's defaults ${shadowed.join(", ")}; those keep working on your other layouts.` : ""}`
        + `${conflicts.length ? ` Skipped: ${conflicts.map((c) => `${c.key} (${c.reason})`).join("; ")}.` : ""}`
        + ` herdr-app now treats keys.json as yours: new default shortcuts in later releases are not added to it automatically. Undo with \`rig herdr install --keys --remove\`; your file before this change is at ${backup}.`,
  };
}
