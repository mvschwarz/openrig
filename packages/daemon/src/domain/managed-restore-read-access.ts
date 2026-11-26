import fs from "node:fs";
import path from "node:path";
import { runningShippedSpecsRoot } from "./builtin-startup-files.js";

export interface RestoreReadContext {
  openrigHome: string | null | undefined;
  session: string;
  cwd: string;
  nativeSessionId: string;
  /** `policies.claude_compaction.message_file_path`: the extra the restore request names when the seat has no per-seat one. */
  extraInstructionFile?: string | null;
  /** `policies.claude_compaction.preparation_root`: where restore maps go instead of the home's, when set. */
  preparationRoot?: string | null;
}

/** The two compaction settings a launch passes so the restore can read the files they name. */
export type RestoreReadPolicy = Pick<RestoreReadContext, "extraInstructionFile" | "preparationRoot">;

/** The configured extra instruction file as the restore request names it: trimmed, or none when blank. The enforcer's
 *  resolver reads the setting through this too, so the grant and the request name the same file. */
export function postCompactExtraSetting(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/** Where Claude's PreCompact hook writes restore packets: the OpenRig home's runtime folder, created owner-only.
 *  OPENRIG_COMPACTION_OUT_ROOT overrides it. The read grant and the enforcer's restore request name it through this, and a
 *  launch whose grant covers it hands it to the seat's hooks in OPENRIG_COMPACTION_PACKET_ROOT. */
export function compactionPacketRoot(openrigHome: string): string {
  return path.resolve(process.env.OPENRIG_COMPACTION_OUT_ROOT || path.join(openrigHome, "run", "compaction-restore"));
}

/** The launch variable that names the packet folder a seat's launch grants it reads in. `restore-from-jsonl.mjs` writes
 *  the seat's packets there. A seat without it (launched before packets moved into the OpenRig home, or with no packet
 *  grant) gets them beside its restore maps in its launch project, which it reads without a grant. It's set by the
 *  launch, not a setting, and its value is absolute, so the seat writes where the grant names whatever its working
 *  directory. */
export const COMPACTION_PACKET_ROOT_ENV = "OPENRIG_COMPACTION_PACKET_ROOT";

/** The packet variable for a launch whose one --settings value, as sent, grants this conversation's packet files in the
 *  packet folder at every spelling; otherwise none. Read from the arguments actually sent: a relaunch that keeps the
 *  running Claude's arguments keeps that Claude's grant, which may predate the folder. A --settings file reads as no
 *  grant, so that seat gets its packets in its launch project, which needs none. */
export function compactionPacketLaunchEnv(args: readonly string[], context: { openrigHome: string | null | undefined; nativeSessionId: string }): Record<string, string> {
  if (!context.openrigHome) return {};
  const at = args.findIndex(arg => arg === "--settings" || arg.startsWith("--settings="));
  const value = at < 0 ? undefined : args[at] === "--settings" ? args[at + 1] : args[at]!.slice("--settings=".length);
  let allow: unknown;
  try { allow = (JSON.parse(value ?? "") as { permissions?: { allow?: unknown } }).permissions?.allow; } catch { return {}; }
  if (!Array.isArray(allow)) return {};
  const root = compactionPacketRoot(context.openrigHome);
  const granted = spellings(root)
    .every(packets => allow.includes(`Read(/${packets}/${context.nativeSessionId}-*/restore-instructions.md)`));
  return granted ? { [COMPACTION_PACKET_ROOT_ENV]: root } : {};
}

/** Where restore packets went by default before they moved into the OpenRig home. With no OPENRIG_COMPACTION_OUT_ROOT, a
 *  seat whose restore marker still names a packet there keeps reading its own packet's files without a new approval; an
 *  explicit root was used before as it is now. */
const PREVIOUS_PACKET_ROOT = "/tmp/claude-compaction-restore";

// These are permission patterns, not shell arguments. Keep literal path components
// literal; the attempt/timestamp segment and the packaged Markdown subtree below are wildcards.
function literalPath(value: string): string {
  return value.replaceAll(path.sep, "/").replace(/[\\*?\[\]()!{}]/g, "\\$&");
}

/** A path as resolved and as it really is. Claude Code applies an allow rule to a read through a symlink only when
 *  the requested path and the file it resolves to both match, so a seat whose restore files sit under a symlink (macOS's
 *  /tmp is /private/tmp) needs both. A part that doesn't exist yet keeps its name under its nearest real parent. */
function spellings(value: string): string[] {
  const resolved = path.resolve(value);
  let real = resolved;
  const rest: string[] = [];
  for (;;) {
    try { real = path.join(fs.realpathSync.native(real), ...rest); break; }
    catch {
      const parent = path.dirname(real);
      if (parent === real) { real = resolved; break; }
      rest.unshift(path.basename(real));
      real = parent;
    }
  }
  return [...new Set([resolved, real])].map(literalPath);
}

/** Merge seat-local restore reads into the launch's ONE settings value. Native
 * deny/ask rules still win; nothing is written to shared project/user settings.
 * Arbitrary operator-selected sources keep their ordinary permission checks. */
export function withManagedRestoreReads(args: string[], context: RestoreReadContext): string[] {
  if (!context.openrigHome) return args;
  const seat = context.session.replace(/[^a-zA-Z0-9_.@-]/g, "_");
  const extra = postCompactExtraSetting(context.extraInstructionFile);
  const files = [
    // A restore map may name its original installed role file, else the restore stops at a native Read prompt. Read the
    // package's own Markdown specs, the root seats' role paths are re-anchored to (runningShippedSpecsRoot), without moving
    // that file or changing saved maps; native deny/ask still wins, and no other install files or writes are granted.
    ...spellings(runningShippedSpecsRoot()).map(root => `${root}/**/*.md`),
    ...spellings(context.openrigHome).flatMap(home => [
      `${home}/compaction/restore-pending/${seat}.json`,
      `${home}/plugins/openrig-core/skills/refocusing/SKILL.md`,
      `${home}/plugins/openrig-core/skills/claude-compaction-restore/SKILL.md`,
      `${home}/compaction/post-compact-extra/${seat}.md`,
      // The generic extra the restore falls back to without a per-seat one; named even before it exists, so granted always.
      `${home}/compaction/post-compact-extra.md`,
      `${home}/compaction/preparation/${seat}/*/RESTORE-MAP.md`,
    ]),
    ...spellings(context.cwd).map(cwd => `${cwd}/.openrig/compaction/preparation/${seat}/*/RESTORE-MAP.md`),
    // The exact file, where it's named and where it resolves (a symlink at the file itself included).
    ...(extra ? spellings(extra) : []),
    ...(context.preparationRoot ? spellings(context.preparationRoot).map(root => `${root}/${seat}/*/RESTORE-MAP.md`) : []),
  ];
  // Fresh/fork launches know their own UUID. Never grant the fork parent's or
  // another seat's packet directory; a legacy name is not a packet identity.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.nativeSessionId)) {
    const previous = process.env.OPENRIG_COMPACTION_OUT_ROOT ? [] : spellings(PREVIOUS_PACKET_ROOT);
    for (const packets of [...spellings(compactionPacketRoot(context.openrigHome)), ...previous]) {
      for (const file of ["restore-instructions.md", "restore-summary.json", "transcript.txt", "transcript-narrative.txt", "touched-files.md"]) {
        files.push(`${packets}/${context.nativeSessionId}-*/${file}`);
      }
    }
  }
  const at = args.indexOf("--settings");
  const settings = at < 0 ? {} : JSON.parse(args[at + 1]!);
  const permissions = settings.permissions ?? {};
  const allow = [...new Set([...(permissions.allow ?? []), ...files.map(file => `Read(/${file})`)])];
  const value = JSON.stringify({ ...settings, permissions: { ...permissions, allow } });
  return at < 0 ? [...args, "--settings", value]
    : [...args.slice(0, at + 1), value, ...args.slice(at + 2)];
}
