import fs from "node:fs";
import path from "node:path";

interface RestoreReadContext {
  openrigHome: string | null | undefined;
  session: string;
  cwd: string;
  nativeSessionId: string;
}

// These are permission patterns, not shell arguments. Keep literal path components
// literal; only the attempt/timestamp segment below is a wildcard.
function literalPath(value: string): string {
  return value.replaceAll(path.sep, "/").replace(/[\\*?\[\]()!{}]/g, "\\$&");
}

/** A directory as resolved and as it really is. Claude Code applies an allow rule to a read through a symlink only when
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
  const files = [
    ...spellings(context.openrigHome).flatMap(home => [
      `${home}/compaction/restore-pending/${seat}.json`,
      `${home}/plugins/openrig-core/skills/refocusing/SKILL.md`,
      `${home}/plugins/openrig-core/skills/claude-compaction-restore/SKILL.md`,
      `${home}/compaction/post-compact-extra/${seat}.md`,
      `${home}/compaction/preparation/${seat}/*/RESTORE-MAP.md`,
    ]),
    ...spellings(context.cwd).map(cwd => `${cwd}/.openrig/compaction/preparation/${seat}/*/RESTORE-MAP.md`),
  ];
  // Fresh/fork launches know their own UUID. Never grant the fork parent's or
  // another seat's packet directory; a legacy name is not a packet identity.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.nativeSessionId)) {
    for (const packets of spellings(process.env.OPENRIG_COMPACTION_OUT_ROOT || "/tmp/claude-compaction-restore")) {
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
