// OpenRig's entries in the user-scope Cursor hooks file (~/.cursor/hooks.json). Cursor reads this
// file for every cursor-agent run, including runs with a per-seat CURSOR_CONFIG_DIR. The relay does
// nothing outside an OpenRig seat (no OPENRIG_SESSION_NAME/NODE_ID), so the operator's own Cursor
// sessions are unaffected. The file is JSON, so OpenRig's entries are recognised by their command.
//
// sessionStart and sessionEnd are deliberately not subscribed. The seat's chat id is created before
// launch, so no session identity is needed from a hook, and `stop` already marks the seat idle. A
// nested `cursor-agent -p` run inside any seat would fire sessionStart with a different chat id
// under that seat's env and overwrite its resume token.

export const OPENRIG_CURSOR_HOOK_EVENTS = ["beforeSubmitPrompt", "preToolUse", "stop"] as const;

const OPENRIG_RELAY_RE = /openrig-core[\\/]hooks[\\/]scripts[\\/]activity-relay\.cjs/;

interface HookEntry { command?: unknown; [key: string]: unknown }
interface HooksFile { version?: unknown; hooks?: Record<string, HookEntry[]>; [key: string]: unknown }

export function cursorRelayCommand(relayPath: string): string {
  return `node ${JSON.stringify(relayPath)}`;
}

function isOpenRigEntry(entry: HookEntry): boolean {
  return !!entry && typeof entry.command === "string" && OPENRIG_RELAY_RE.test(entry.command);
}

function parse(content: string): HooksFile {
  if (content.trim() === "") return {};
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error("~/.cursor/hooks.json is not valid JSON; OpenRig left it unchanged"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("~/.cursor/hooks.json is not a JSON object; OpenRig left it unchanged");
  return parsed as HooksFile;
}

function hooksObject(file: HooksFile): Record<string, unknown> | undefined {
  const h = file.hooks;
  return h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>) : undefined;
}

function render(file: HooksFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function upsertCursorActivityHooks(content: string, relayPath: string): string {
  const file = parse(content);
  if (file.hooks !== undefined && !hooksObject(file)) throw new Error("~/.cursor/hooks.json has an unexpected hooks value; OpenRig left it unchanged");
  const existingHooks = hooksObject(file) ?? {};
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (!Array.isArray(entries)) throw new Error(`~/.cursor/hooks.json has a non-list value for hook "${event}"; OpenRig left it unchanged`);
  }
  // Drop OpenRig's entries from every event first, so events an earlier version subscribed to
  // (sessionStart, sessionEnd) lose them too; an event left empty only by that removal is dropped.
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(existingHooks) as Array<[string, HookEntry[]]>) {
    const theirs = entries.filter((entry) => !isOpenRigEntry(entry));
    if (theirs.length > 0 || entries.length === 0) hooks[event] = theirs;
  }
  for (const event of OPENRIG_CURSOR_HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { command: cursorRelayCommand(relayPath) }];
  }
  const next = render({ ...file, version: file.version ?? 1, hooks });
  return content.trim() !== "" && JSON.stringify(parse(content)) === JSON.stringify(parse(next)) ? content : next;
}

/** Returns the file without OpenRig's entries, the input unchanged when there is nothing to remove or
 *  it cannot be parsed, or null when nothing but an empty shell would remain (delete the file). */
export function stripCursorActivityHooks(content: string): string | null {
  let file: HooksFile;
  try { file = parse(content); } catch { return content; }
  const existingHooks = hooksObject(file);
  if (!existingHooks) return content;
  let removed = false;
  const hooks: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (!Array.isArray(entries)) { hooks[event] = entries; continue; }
    const kept = (entries as HookEntry[]).filter((entry) => !isOpenRigEntry(entry));
    if (kept.length !== entries.length) removed = true;
    if (kept.length > 0) hooks[event] = kept;
  }
  if (!removed) return content;
  const rest: HooksFile = { ...file };
  delete rest.hooks;
  const version = rest.version;
  delete rest.version;
  if (Object.keys(hooks).length === 0 && Object.keys(rest).length === 0) return null;
  return render({ ...rest, version, hooks: hooks as Record<string, HookEntry[]> });
}
