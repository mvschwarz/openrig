import type Database from "better-sqlite3";

export const CLAUDE_AUTO_MODE_LISTS = ["environment", "allow", "soft_deny", "hard_deny"] as const;
export type ClaudeAutoModeList = typeof CLAUDE_AUTO_MODE_LISTS[number];

/** A seat's Claude `autoMode` settings block, passed to the classifier verbatim through the launch's --settings. */
export type ClaudeAutoMode = Partial<Record<ClaudeAutoModeList, string[]>> & { classifyAllShell?: boolean };

/** What a launch recorded as sent: a block, null for none, or unknown when it read --settings from a file OpenRig can't see. */
export type AppliedClaudeAutoMode = ClaudeAutoMode | null | { unknown: "settings_file" };

/** A saved block that can't be read. The launch goes ahead without it and warns with `unreadable`. */
export interface UnreadableClaudeAutoMode { unreadable: string }
export type ClaudeAutoModeChoice = ClaudeAutoMode | UnreadableClaudeAutoMode;

/** The block a launch sends (undefined for none), and the warning when the saved one can't be read. */
export function claudeAutoModeForLaunch(choice: ClaudeAutoModeChoice | undefined): { block?: ClaudeAutoMode; warning?: string } {
  if (choice === undefined) return {};
  if ("unreadable" in choice) return { warning: choice.unreadable };
  return { block: choice };
}

export function validateClaudeAutoMode(value: unknown, label = "claude_auto_mode"): ClaudeAutoMode {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}: expected a mapping of environment, allow, soft_deny, hard_deny and classifyAllShell`);
  }
  const raw = value as Record<string, unknown>;
  const result: ClaudeAutoMode = {};
  for (const key of Object.keys(raw)) {
    if (key === "classifyAllShell") {
      if (typeof raw[key] !== "boolean") throw new Error(`${label}.classifyAllShell: expected true or false`);
      result.classifyAllShell = raw[key] as boolean;
      continue;
    }
    if (!(CLAUDE_AUTO_MODE_LISTS as readonly string[]).includes(key)) {
      throw new Error(`${label}.${key}: unsupported key; use environment, allow, soft_deny, hard_deny or classifyAllShell`);
    }
    if (!Array.isArray(raw[key])) throw new Error(`${label}.${key}: expected a list of prose entries`);
    result[key as ClaudeAutoModeList] = (raw[key] as unknown[]).map((entry, index) => {
      if (typeof entry !== "string" || !entry.trim()) throw new Error(`${label}.${key}[${index}]: expected a non-empty string`);
      return entry;
    });
  }
  return result;
}

/** Warnings, never refusals. Claude combines entries from user, managed and --settings scopes. Its docs say a list
 *  without `$defaults` replaces the built-ins, and 2.1.322 keeps them when another scope keeps `$defaults` or the list
 *  is empty. The wording says "may", so it stays true either way. */
export function claudeAutoModeAdvisories(block: ClaudeAutoMode, label = "claude_auto_mode"): string[] {
  const advisories: string[] = [];
  for (const key of CLAUDE_AUTO_MODE_LISTS) {
    const list = block[key];
    if (list === undefined) continue;
    if (!list.includes("$defaults")) advisories.push(`${label}.${key}: without "$defaults", this list may replace Claude's built-in ${key} entries for this seat, unless another scope (user or managed settings) keeps "$defaults" there. Add "$defaults" to keep them; claude auto-mode config shows the effective lists.`);
    else if (list.every(entry => entry === "$defaults")) advisories.push(`${label}.${key}: only "$defaults" adds no entries of its own; it keeps Claude's built-in ${key} entries for this seat even where your user settings leave them out.`);
    list.forEach((entry, index) => {
      if (/^[A-Za-z_][A-Za-z0-9_*-]*\(.*\)$/.test(entry.trim())) {
        advisories.push(`${label}.${key}[${index}]: auto mode entries are prose read by the classifier, not tool patterns; use claude_permissions for tool rules.`);
      }
    });
  }
  return advisories;
}

export interface ClaudeAutoModeStatus {
  /** The seat's record: what its next managed launch or resume composes. */
  saved: { state: "recorded"; block: ClaudeAutoMode } | { state: "none" } | { state: "unavailable"; error: string };
  /** The block the current occupant's launch sent; unknown when it wasn't recorded, or (with a reason) when the launch
   *  read --settings from a file. */
  lastLaunch: { state: "sent"; block: ClaudeAutoMode } | { state: "none" } | { state: "unknown"; reason?: "settings_file" };
  /** Whether the next launch would compose what the last one did; null when either side can't be read. */
  matchesLastLaunch: boolean | null;
  /** Whether the next fresh launch is planned in auto mode; null when the plan can't be read. */
  plannedAutoMode: boolean | null;
  advisories: string[];
  notes: string[];
  /** Prints the classifier's effective lists for this block, beside the user and managed settings where it runs. */
  inspect?: string;
}

/** Key order doesn't matter; list order does. */
function canonicalJson(block: ClaudeAutoMode): string {
  return JSON.stringify(Object.fromEntries(Object.entries(block).sort(([a], [b]) => a.localeCompare(b))));
}

/** Saved against applied, for seat status. `applied` is the observation's field: absent when not recorded. `plannedAuto` is undefined when the plan can't be read. */
export function claudeAutoModeStatus(db: Database.Database, nodeId: string, applied: AppliedClaudeAutoMode | undefined, plannedAuto: boolean | undefined): ClaudeAutoModeStatus | undefined {
  let saved: ClaudeAutoModeStatus["saved"];
  try {
    const block = readClaudeAutoMode(db, nodeId);
    saved = block === undefined ? { state: "none" } : { state: "recorded", block };
  } catch (error) { saved = { state: "unavailable", error: (error as Error).message }; }
  const lastLaunch: ClaudeAutoModeStatus["lastLaunch"] = applied === undefined ? { state: "unknown" }
    : applied === null ? { state: "none" } : "unknown" in applied ? { state: "unknown", reason: applied.unknown } : { state: "sent", block: applied };
  // Shown with nothing saved when the last launch sent a block, or when a launch recorded that it couldn't tell.
  if (saved.state === "none" && lastLaunch.state !== "sent" && !(lastLaunch.state === "unknown" && lastLaunch.reason)) return undefined;
  const savedJson = saved.state === "recorded" ? canonicalJson(saved.block) : saved.state === "none" ? "null" : undefined;
  const appliedJson = lastLaunch.state === "sent" ? canonicalJson(lastLaunch.block) : lastLaunch.state === "none" ? "null" : undefined;
  const matchesLastLaunch = savedJson === undefined || appliedJson === undefined ? null : savedJson === appliedJson;
  const notes = ["Claude adds these entries to your user and managed auto mode settings; OpenRig doesn't read or change those."];
  if (matchesLastLaunch === false) notes.push("The saved block differs from the last launch's; it applies at the next managed launch or resume.");
  if (plannedAuto === undefined) notes.push("Whether the next launch uses auto mode: unknown, because its permission plan can't be read.");
  if (saved.state === "recorded" && plannedAuto === false) notes.push("The next launch isn't planned in auto mode, so the classifier won't read this block unless the session switches to auto mode.");
  return { saved, lastLaunch, matchesLastLaunch, plannedAutoMode: plannedAuto ?? null, notes,
    advisories: saved.state === "recorded" ? claudeAutoModeAdvisories(saved.block) : [],
    ...(saved.state === "recorded" ? { inspect: `claude --settings '${JSON.stringify({ autoMode: saved.block }).replace(/'/g, "'\\''")}' auto-mode config` } : {}) };
}

/** Read the current seat. Minimal old fixtures have no column. */
export function readClaudeAutoMode(db: Database.Database, nodeId: string): ClaudeAutoMode | undefined {
  let seat = nodeId;
  try {
    const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as { logical_id?: string; claude_auto_mode_json?: string | null } | undefined;
    if (row?.claude_auto_mode_json == null) return undefined;
    if (row.logical_id) seat += ` (${row.logical_id})`;
    return validateClaudeAutoMode(JSON.parse(row.claude_auto_mode_json));
  } catch (error) {
    throw new Error(`Seat ${seat}: the saved claude_auto_mode can't be read (${(error as Error).message}), so launches don't send it. Set it again with rig seat set-permissions <seat> --auto-mode <file> --reason <reason>, or clear it with --clear-auto-mode.`);
  }
}

/** For launches: a block that can't be read comes back as unreadable instead of stopping the launch. */
export function readClaudeAutoModeForLaunch(db: Database.Database, nodeId: string): ClaudeAutoModeChoice | undefined {
  try { return readClaudeAutoMode(db, nodeId); } catch (error) { return { unreadable: (error as Error).message }; }
}
