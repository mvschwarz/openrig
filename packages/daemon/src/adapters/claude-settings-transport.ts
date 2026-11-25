import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getOpenRigHome } from "../openrig-compat.js";

export interface ClaudeSettingsSeat { openrigHome?: string | null; session: string }
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
// A transport margin, not a settings limit: large values use Claude's native file form on every platform.
const INLINE_MARGIN_BYTES = 64 * 1024;
// Claude's --settings file limit (CLI reference).
const MAX_SETTINGS_FILE_BYTES = 2 * 1024 * 1024;
const ownedName = /^(private-)?[a-f0-9]{64}\.json$/;
const directory = (seat: ClaudeSettingsSeat) => path.join(path.resolve(seat.openrigHome ?? getOpenRigHome()), "state", "claude-settings", digest(seat.session));

/** Read only this seat's own unchanged content-addressed file. Foreign settings files remain opaque. */
export function ownClaudeSettings(value: string, seat?: ClaudeSettingsSeat): string | undefined {
  // Continuation may serialize this value back into argv. File-backed settings stay opaque to it.
  return readStagedSettings(value, seat, false);
}

function readStagedSettings(value: string, seat: ClaudeSettingsSeat | undefined, includePrivate: boolean): string | undefined {
  const name = path.basename(value);
  const match = ownedName.exec(name);
  if (!seat || path.dirname(value) !== directory(seat) || !match || (match[1] && !includePrivate)) return undefined;
  try {
    if (!fs.lstatSync(value).isFile()) return undefined;
    const bytes = readSettingsFile(value);
    return `${match[1] ?? ""}${digest(bytes)}.json` === name ? bytes : undefined;
  } catch { return undefined; }
}

function publishSettings(file: string, value: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, value);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* keep the original publication error */ }
    throw error;
  }
}

type SettingsEntry = { at: number; inline: boolean; value: string };
function entries(args: readonly string[]): SettingsEntry[] {
  return args.flatMap<SettingsEntry>((arg, at) => arg.startsWith("--settings=")
    ? [{ at, inline: true, value: arg.slice(11) }]
    : arg === "--settings" && args[at + 1] !== undefined ? [{ at, inline: false, value: args[at + 1]! }] : []);
}

function stageSettings(seat: ClaudeSettingsSeat, value: string, privateFile = false): string {
  const dir = directory(seat);
  const file = path.join(dir, `${privateFile ? "private-" : ""}${digest(value)}.json`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (readStagedSettings(file, seat, true) !== value) publishSettings(file, value);
  else fs.chmodSync(file, 0o600);
  return file;
}

function settingsObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Claude settings must be an object");
  return value as Record<string, unknown>;
}

export function readSettingsFile(file: string, { followSymlinks = false }: { followSymlinks?: boolean } = {}): string {
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (followSymlinks ? 0 : fs.constants.O_NOFOLLOW);
  const fd = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_FILE_BYTES) throw new Error("invalid file");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) throw new Error("settings file changed during read");
    return bytes.toString("utf8", 0, offset);
  } finally { fs.closeSync(fd); }
}

/** Claude uses the last --settings argument. Compose that one and keep file-backed values out of argv. */
export function composeClaudeLaunchSettings(args: string[], seat: ClaudeSettingsSeat, cwd: string, warnings: string[],
  compose: (settings: Record<string, unknown>) => Record<string, unknown>): string[] {
  const selected = entries(args).at(-1);
  const fileBacked = selected !== undefined && !selected.value.trimStart().startsWith("{");
  let raw = selected?.value ?? "{}";
  let settings: Record<string, unknown>;
  try {
    if (fileBacked) raw = readSettingsFile(path.resolve(cwd, raw));
    settings = settingsObject(raw);
  } catch {
    warnings.push(`OpenRig kept the original --settings ${fileBacked ? "file" : "value"} because it could not read a settings object.`);
    return args;
  }

  const original = JSON.stringify(settings);
  const composed = JSON.stringify(compose(settings));
  if (composed === original) return args;
  if (fileBacked) {
    try {
      if (Buffer.byteLength(composed, "utf8") > MAX_SETTINGS_FILE_BYTES) throw new Error("settings too large");
      raw = stageSettings(seat, composed, true);
    } catch {
      warnings.push("OpenRig kept the original --settings file because the composed launch settings could not be staged privately.");
      return args;
    }
  } else raw = composed;
  if (!selected) return [...args, "--settings", raw];
  const result = [...args];
  result[selected.inline ? selected.at : selected.at + 1] = selected.inline ? `--settings=${raw}` : raw;
  return result;
}

/** After all composition, stage exact JSON bytes before dispatch; on write failure retain inline bytes and warn.
 * Captured live arguments protect their files while the new launch is prepared. No shared settings are written. */
export function transportClaudeSettings(args: string[], seat: ClaudeSettingsSeat, warnings: string[], liveArgs: readonly string[] = []): string[] {
  const result = [...args], dir = directory(seat);
  let wrote = false;
  for (const entry of entries(args)) {
    const bytes = Buffer.byteLength(entry.value, "utf8");
    if (bytes <= INLINE_MARGIN_BYTES) continue;
    try {
      const parsed: unknown = JSON.parse(entry.value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    } catch { continue; } // a filename or invalid JSON is passed as before
    try {
      const file = stageSettings(seat, entry.value);
      result[entry.inline ? entry.at : entry.at + 1] = entry.inline ? `--settings=${file}` : file;
      wrote = true;
    } catch (error) {
      warnings.push(`Claude --settings (${bytes} UTF-8 bytes) file write failed: ${(error as Error).message}; using the unchanged inline argument.`);
    }
  }
  if (wrote || entries(result).some(entry => readStagedSettings(entry.value, seat, true) !== undefined)) {
    const keep = new Set([...entries(result), ...entries(liveArgs)].map(entry => entry.value));
    try {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (!keep.has(file) && readStagedSettings(file, seat, true) !== undefined) fs.unlinkSync(file);
      }
    } catch (error) { warnings.push(`Claude settings file pruning failed: ${(error as Error).message}`); }
  }
  return result;
}
