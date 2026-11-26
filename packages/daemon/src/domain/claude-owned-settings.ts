// OpenRig's collector and activity relay live in instance state; their `statusLine` and hooks live in the seat's
// `.claude/settings.local.json`. Legacy cwd collectors remain owned for migration and cleanup. Ownership is the exact
// generated Node-command shape. The adapter's install and reconcile and rig down's cleanup (#875) share these matchers, so what
// down takes back is exactly what a launch would recognise as its own.

import fs from "node:fs";
import nodePath from "node:path";
import { CLAUDE_ACTIVITY_RELAY_RELATIVE_PATH, parseManagedClaudeNodeCommand } from "./claude-activity-hooks.js";
import { CONTEXT_COLLECTOR_RELATIVE_PATH } from "./telemetry-state-paths.js";

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
const OWNED_COLLECTOR_SUFFIXES = [
  nodePath.sep + nodePath.normalize(CONTEXT_COLLECTOR_RELATIVE_PATH),
  nodePath.sep + nodePath.join(".openrig", "context-collector.cjs"),
];

export function isOwnedCollectorCommand(cmd: string): boolean {
  if (/[\r\n]/.test(cmd)) return false;
  const parsed = parseManagedClaudeNodeCommand(cmd);
  if (parsed && (parsed.args.length === 2 || parsed.args.length === 3)) {
    return OWNED_COLLECTOR_SUFFIXES.some((suffix) => parsed.args[0]!.endsWith(suffix));
  }
  const tokens = cmd.trim().split(/\s+/);
  if ((tokens.length !== 3 && tokens.length !== 4) || tokens[0] !== "node") return false;
  if (tokens.some((token) => /[;&|<>`$()'"\\]/.test(token))) return false;
  return OWNED_COLLECTOR_SUFFIXES.some((suffix) => tokens[1]!.endsWith(suffix));
}

/** Without a repointed owned command as evidence, teardown only takes back this release's collector bytes. */
export function isShippedCollectorBytes(bytes: Buffer, shipped: Buffer): boolean {
  return bytes.equals(shipped);
}

/** The collector script a status line command runs, for OpenRig's own plain or throttled commands; null otherwise.
 *  A throttled command is a shell one-liner whose last pipe runs the collector, so its tail is parsed, not the whole
 *  line. A user command that merely contains the path is not an owned command and returns null. */
export function collectorCommandScriptPath(command: string): string | null {
  const parsed = parseManagedClaudeNodeCommand(command);
  if (parsed && (parsed.args.length === 2 || parsed.args.length === 3)
    && OWNED_COLLECTOR_SUFFIXES.some((suffix) => parsed.args[0]!.endsWith(suffix))) return parsed.args[0]!;
  const pipe = command.lastIndexOf("| ");
  if (pipe < 0) return null;
  const tail = parseManagedClaudeNodeCommand(command.slice(pipe + 2).trim());
  if (tail && (tail.args.length === 2 || tail.args.length === 3)
    && OWNED_COLLECTOR_SUFFIXES.some((suffix) => tail.args[0]!.endsWith(suffix))) return tail.args[0]!;
  return null;
}

/** After repointing an owned command, take back the legacy cwd file it named, regardless of its bytes.
 *  User wrappers, other folders' collectors and symlinks are left alone. Cleanup is best-effort and never recursive. */
export function removeRepointedLegacyCollector(cwd: string, command: unknown): void {
  if (typeof command !== "string" || !isOwnedCollectorCommand(command)) return;
  const script = collectorCommandScriptPath(command);
  const legacy = nodePath.resolve(cwd, ".openrig", "context-collector.cjs");
  if (!script || nodePath.resolve(cwd, script) !== legacy) return;
  try {
    const stat = fs.lstatSync(legacy);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    fs.unlinkSync(legacy);
    removeIfEmpty(nodePath.dirname(legacy), () => false);
  } catch {
    // Missing or inaccessible: leave it without failing provisioning.
  }
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
 *  - A legacy cwd collector goes while its bytes are this release's shipped collector's. Other bytes are kept;
 *    migration removes older copies when repointing their owned commands. The instance copy stays.
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
    else if (fs.lstatSync(collectorPath).isFile()
      && isShippedCollectorBytes(fs.readFileSync(collectorPath), shipped)) fs.unlinkSync(collectorPath);
    else kept.push(`${collectorPath}: not the shipped collector's bytes, so it was kept`);
  }
  for (const dir of [".openrig", ".claude"]) removeIfEmpty(nodePath.join(cwd, dir), isShared);
  return kept;
}
