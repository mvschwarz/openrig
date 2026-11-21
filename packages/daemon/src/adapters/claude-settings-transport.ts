import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getOpenRigHome } from "../openrig-compat.js";

export interface ClaudeSettingsSeat { openrigHome?: string | null; session: string }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
// A transport margin, not a settings limit: large values use Claude's native file form on every platform.
const INLINE_MARGIN_BYTES = 64 * 1024;
const ownedName = /^[a-f0-9]{64}\.json$/;
const directory = (seat: ClaudeSettingsSeat) => path.join(path.resolve(seat.openrigHome ?? getOpenRigHome()), "state", "claude-settings", digest(seat.session));

/** Read only this seat's own unchanged content-addressed file. Foreign settings files remain opaque. */
export function ownClaudeSettings(value: string, seat?: ClaudeSettingsSeat): string | undefined {
  if (!seat || path.dirname(value) !== directory(seat) || !ownedName.test(path.basename(value))) return undefined;
  try {
    if (!fs.lstatSync(value).isFile()) return undefined;
    const text = fs.readFileSync(value, "utf8");
    return `${digest(text)}.json` === path.basename(value) ? text : undefined;
  } catch { return undefined; }
}

type SettingsEntry = { at: number; inline: boolean; value: string };
function entries(args: readonly string[]): SettingsEntry[] {
  return args.flatMap<SettingsEntry>((arg, at) => arg.startsWith("--settings=")
    ? [{ at, inline: true, value: arg.slice(11) }]
    : arg === "--settings" && args[at + 1] !== undefined ? [{ at, inline: false, value: args[at + 1]! }] : []);
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
    const file = path.join(dir, `${digest(entry.value)}.json`);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (ownClaudeSettings(file, seat) !== entry.value) fs.writeFileSync(file, entry.value, { flag: "wx", mode: 0o600 });
      else fs.chmodSync(file, 0o600);
      result[entry.inline ? entry.at : entry.at + 1] = entry.inline ? `--settings=${file}` : file;
      wrote = true;
    } catch (error) {
      warnings.push(`Claude --settings (${bytes} UTF-8 bytes) file write failed: ${(error as Error).message}; using the unchanged inline argument.`);
    }
  }
  if (wrote) {
    const keep = new Set([...entries(result), ...entries(liveArgs)].map(entry => entry.value));
    try {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (ownedName.test(name) && !keep.has(file) && fs.lstatSync(file).isFile()) fs.unlinkSync(file);
      }
    } catch (error) { warnings.push(`Claude settings file pruning failed: ${(error as Error).message}`); }
  }
  return result;
}
