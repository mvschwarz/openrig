// OpenRig's own additions in a Claude seat's cwd: the context collector `.openrig/context-collector.cjs`, its
// `statusLine`, and the activity relay hooks in `.claude/settings.local.json`. Ownership is the exact generated
// Node-command shape. The adapter's install and reconcile and rig down's cleanup (#875) share these matchers, so what
// down takes back is exactly what a launch would recognise as its own.

import fs from "node:fs";
import nodePath from "node:path";
import { CLAUDE_ACTIVITY_RELAY_RELATIVE_PATH, parseManagedClaudeNodeCommand } from "./claude-activity-hooks.js";

// OpenRig-owned relay path suffix. Ownership is the generated Node command whose single
// argument ends with this path — a changed prefix still matches (replace, not duplicate); a
// user command that merely contains the path (echo, or node with extra args) does NOT.
const LEGACY_OWNED_RELAY_SUFFIX = "/.openrig/hooks/scripts/activity-relay.cjs";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hookCommand(hook: unknown): string | undefined {
  return isPlainObject(hook) && typeof hook["command"] === "string" ? (hook["command"] as string) : undefined;
}

// OpenRig-owned collectors use canonical POSIX-quoted paths. Recognise older unquoted
// three/four-token commands too, but preserve commands composed with shell operators or
// extra arguments. Old unquoted paths containing spaces cannot be identified unambiguously.
const OWNED_COLLECTOR_SUFFIX = nodePath.sep + nodePath.join(".openrig", "context-collector.cjs");

export function isOwnedCollectorCommand(cmd: string): boolean {
  if (/[\r\n]/.test(cmd)) return false;
  const parsed = parseManagedClaudeNodeCommand(cmd);
  if (parsed && (parsed.args.length === 2 || parsed.args.length === 3)) {
    return parsed.args[0]!.endsWith(OWNED_COLLECTOR_SUFFIX);
  }
  const tokens = cmd.trim().split(/\s+/);
  if ((tokens.length !== 3 && tokens.length !== 4) || tokens[0] !== "node") return false;
  if (tokens.some((token) => /[;&|<>`$()'"\\]/.test(token))) return false;
  return tokens[1]!.endsWith(OWNED_COLLECTOR_SUFFIX);
}

export function isOwnedRelayCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  const parsed = parseManagedClaudeNodeCommand(cmd);
  if (!parsed || parsed.args.length !== 1) return false;
  const relay = parsed.args[0]!;
  return relay.endsWith("/plugins/openrig-core/hooks/scripts/activity-relay.cjs")
    || relay.endsWith(LEGACY_OWNED_RELAY_SUFFIX)
    || relay.endsWith(`/${CLAUDE_ACTIVITY_RELAY_RELATIVE_PATH}`);
}

/** Strip OpenRig-owned relay entries (EXACT node-command shape) from all events, hook by hook: a group keeps its other
 *  hooks and fields, and an emptied group or event is pruned. User-authored hooks are untouched. Returns whether an
 *  owned entry was removed. */
export function stripOwnedRelayHooks(hooks: Record<string, unknown>): boolean {
  let changed = false;
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : null;
    if (!groups) continue;
    const keptGroups: unknown[] = [];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group["hooks"])) { keptGroups.push(group); continue; }
      const groupHooks = group["hooks"] as unknown[];
      const keptHooks = groupHooks.filter((h) => !isOwnedRelayCommand(hookCommand(h)));
      if (keptHooks.length !== groupHooks.length) changed = true;
      if (keptHooks.length === 0) continue; // prune emptied group
      keptGroups.push({ ...group, hooks: keptHooks });
    }
    if (keptGroups.length === 0) delete hooks[event]; // prune emptied event
    else hooks[event] = keptGroups;
  }
  return changed;
}

/** Take OpenRig's own entries out of parsed Claude settings: its relay hooks, and the `type` and `command` its collector
 *  install wrote into `statusLine`. The person's other `statusLine` fields and every other setting stay. Returns
 *  whether anything changed. */
export function removeOwnedClaudeSettings(settings: Record<string, unknown>): boolean {
  let changed = false;
  const hooks = settings["hooks"];
  if (isPlainObject(hooks) && stripOwnedRelayHooks(hooks)) {
    changed = true;
    if (Object.keys(hooks).length === 0) delete settings["hooks"];
  }
  const statusLine = settings["statusLine"];
  if (isPlainObject(statusLine) && typeof statusLine["command"] === "string" && isOwnedCollectorCommand(statusLine["command"])) {
    const rest = { ...statusLine };
    delete rest["command"];
    if (rest["type"] === "command") delete rest["type"];
    if (Object.keys(rest).length > 0) settings["statusLine"] = rest;
    else delete settings["statusLine"];
    changed = true;
  }
  return changed;
}

function removeIfEmpty(dir: string, isShared: (path: string) => boolean): void {
  try {
    if (!isShared(dir) && fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // Missing, or not ours to judge: leave it.
  }
}

const SHARED = "another seat's directory still uses it through a link, so it was kept";

/** rig down (#875), for a cwd no Claude seat still uses: take back what OpenRig added there for Claude.
 *  - Its entries leave `.claude/settings.local.json`, which is kept even when that leaves `{}`, since nothing records
 *    whether OpenRig created it. Settings that don't parse as an object are left as they are.
 *  - The collector goes only while its bytes are the shipped collector's.
 *  - `.openrig` and `.claude` go only if they're then empty, never recursively.
 *  - A target `isShared` names (one another seat's directory reaches through a symlink or a hardlink) is left as it is.
 *  Returns what was kept for the person to look at. */
export function cleanupOwnedClaudeCwd(cwd: string, collectorAssetPath: string | null | undefined,
  isShared: (path: string) => boolean = () => false): string[] {
  const kept: string[] = [];
  const settingsPath = nodePath.join(cwd, ".claude", "settings.local.json");
  if (fs.existsSync(settingsPath) && isShared(settingsPath)) kept.push(`${settingsPath}: ${SHARED}`);
  else if (fs.existsSync(settingsPath)) {
    const text = fs.readFileSync(settingsPath, "utf-8");
    let parsed: unknown;
    try { parsed = text.trim() === "" ? {} : JSON.parse(text); } catch { parsed = undefined; }
    if (!isPlainObject(parsed)) kept.push(`${settingsPath}: not a JSON settings object, so it was left as it is`);
    else if (removeOwnedClaudeSettings(parsed)) fs.writeFileSync(settingsPath, JSON.stringify(parsed, null, 2), "utf-8");
  }
  const collectorPath = nodePath.join(cwd, ".openrig", "context-collector.cjs");
  if (fs.existsSync(collectorPath) && isShared(collectorPath)) kept.push(`${collectorPath}: ${SHARED}`);
  else if (fs.existsSync(collectorPath)) {
    let shipped: Buffer | null = null;
    try { shipped = collectorAssetPath ? fs.readFileSync(collectorAssetPath) : null; } catch { shipped = null; }
    if (!shipped) kept.push(`${collectorPath}: couldn't be compared with the shipped collector, so it was kept`);
    else if (fs.lstatSync(collectorPath).isFile() && fs.readFileSync(collectorPath).equals(shipped)) fs.unlinkSync(collectorPath);
    else kept.push(`${collectorPath}: not the shipped collector's bytes, so it was kept`);
  }
  for (const dir of [".openrig", ".claude"]) removeIfEmpty(nodePath.join(cwd, dir), isShared);
  return kept;
}
