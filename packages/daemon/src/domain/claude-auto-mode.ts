import type Database from "better-sqlite3";

export const CLAUDE_AUTO_MODE_LISTS = ["environment", "allow", "soft_deny", "hard_deny"] as const;
export type ClaudeAutoModeList = typeof CLAUDE_AUTO_MODE_LISTS[number];

/** A seat's Claude `autoMode` settings block, passed to the classifier verbatim through the launch's --settings. */
export type ClaudeAutoMode = Partial<Record<ClaudeAutoModeList, string[]>> & { classifyAllShell?: boolean };

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

/** Warnings, never refusals. Claude combines entries from user, managed and --settings scopes. Its built-in entries
 *  join a section when any scope keeps `$defaults`, and drop out when a scope sets a non-empty list and none keeps it. */
export function claudeAutoModeAdvisories(block: ClaudeAutoMode, label = "claude_auto_mode"): string[] {
  const advisories: string[] = [];
  for (const key of CLAUDE_AUTO_MODE_LISTS) {
    const list = block[key];
    if (list === undefined) continue;
    if (list.length === 0) advisories.push(`${label}.${key}: an empty list adds no entries and changes nothing; your user and managed settings for this section still decide it.`);
    else if (!list.includes("$defaults")) advisories.push(`${label}.${key}: without "$defaults", this list replaces Claude's built-in ${key} entries for this seat, unless your user or managed settings keep "$defaults" there. Add "$defaults" to keep them.`);
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
  saved: { state: "recorded"; block: ClaudeAutoMode } | { state: "none" } | { state: "invalid"; error: string };
  /** The block the current occupant's launch composed; unknown when that launch predates the record. */
  lastLaunch: { state: "sent"; block: ClaudeAutoMode } | { state: "none" } | { state: "unknown" };
  /** Whether the next launch would compose what the last one did; null when either side can't be read. */
  matchesLastLaunch: boolean | null;
  advisories: string[];
  notes: string[];
  /** Prints the classifier's effective lists for this block, beside the user and managed settings where it runs. */
  inspect?: string;
}

/** Saved against applied, for seat status. `applied` is the observation's field: absent when not recorded. */
export function claudeAutoModeStatus(db: Database.Database, nodeId: string, applied: ClaudeAutoMode | null | undefined, plannedAuto: boolean): ClaudeAutoModeStatus | undefined {
  let saved: ClaudeAutoModeStatus["saved"];
  try {
    const block = readClaudeAutoMode(db, nodeId);
    saved = block === undefined ? { state: "none" } : { state: "recorded", block };
  } catch (error) { saved = { state: "invalid", error: (error as Error).message }; }
  const lastLaunch: ClaudeAutoModeStatus["lastLaunch"] = applied === undefined ? { state: "unknown" }
    : applied === null ? { state: "none" } : { state: "sent", block: applied };
  if (saved.state === "none" && lastLaunch.state !== "sent") return undefined;
  const savedJson = saved.state === "recorded" ? JSON.stringify(saved.block) : saved.state === "none" ? "null" : undefined;
  const appliedJson = lastLaunch.state === "sent" ? JSON.stringify(lastLaunch.block) : lastLaunch.state === "none" ? "null" : undefined;
  const matchesLastLaunch = savedJson === undefined || appliedJson === undefined ? null : savedJson === appliedJson;
  const notes = ["Claude adds these entries to your user and managed auto mode settings; OpenRig doesn't read or change those."];
  if (matchesLastLaunch === false) notes.push("The saved block differs from the last launch's; it applies at the next managed launch or resume.");
  if (saved.state === "recorded" && !plannedAuto) notes.push("The next launch isn't planned in auto mode, so the classifier won't read this block unless the session switches to auto mode.");
  return { saved, lastLaunch, matchesLastLaunch, notes,
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
    throw new Error(`Seat ${seat}: cannot read claude_auto_mode (${(error as Error).message}). Replace it with rig seat set-permissions <seat> --auto-mode <file> --reason <reason>, or clear it with --clear-auto-mode, before launching.`);
  }
}
