const NODE_HOOK_FORWARDER = "const{spawnSync}=require('node:child_process');const r=spawnSync(process.env.OPENRIG_NODE||process.execPath,process.argv.slice(1),{stdio:'inherit',windowsHide:true});if(r.error){process.stderr.write(r.error.message+'\\n');process.exit(1)}process.exit(r.status??1);";

/** Render the shipped finite Node hook vocabulary for Claude's native exec form.
 * Callers must retain source/version authority when staging this derived manifest.
 * This accepts the canonical shipped commands only, never arbitrary user shell text.
 */
export function windowsClaudePluginHooks(source: string): string {
  const manifest: unknown = JSON.parse(source);
  if (!object(manifest) || !object(manifest.hooks)) throw Error("Claude hook manifest has no hooks object");
  for (const groups of Object.values(manifest.hooks)) {
    if (!Array.isArray(groups)) throw Error("Claude hook event groups must be arrays");
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks)) throw Error("Claude hook group has no hooks array");
      for (const hook of group.hooks) {
        if (!object(hook) || hook.type !== "command" || typeof hook.command !== "string") throw Error("Unsupported Claude plugin hook");
        const match = /^"\$\{OPENRIG_NODE:-node\}" "\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+)"((?: (?:--[a-z-]+|[a-z]+))*)$/.exec(hook.command);
        if (!match || match[1]!.split("/").some(part => !part || part === "." || part === "..")) {
          throw Error("Unsupported Claude plugin hook command; native manifest was not produced");
        }
        const args = match[2]!.trim() ? match[2]!.trim().split(" ") : [];
        // Direct execution preserves Claude's JSON stdin on native Windows.
        // The fixed staging Node boots the launcher; the seat may select its
        // paired Node via OPENRIG_NODE without depending on PATH or a shell.
        hook.command = process.execPath;
        hook.args = ["-e", NODE_HOOK_FORWARDER, "--", "${CLAUDE_PLUGIN_ROOT}/" + match[1], ...args];
        delete hook.shell;
      }
    }
  }
  return JSON.stringify(manifest, null, 2) + "\n";
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Codex executes a command string; keep its plugin-root substitution but avoid POSIX shell builtins. */
export function windowsCodexPluginHooks(source: string): string {
  const manifest: unknown = JSON.parse(source);
  if (!object(manifest) || !object(manifest.hooks)) throw Error("Codex hook manifest has no hooks object");
  const prefix = 'test -n "$OPENRIG_SEAT_PROJECT_DIR" && test -f "$OPENRIG_NODE" && test -x "$OPENRIG_NODE" || exit 0; exec "$OPENRIG_NODE" ';
  const forwarder = "const fs=require('node:fs'),cp=require('node:child_process'),n=process.env.OPENRIG_NODE;if(!process.env.OPENRIG_SEAT_PROJECT_DIR||!n||!fs.existsSync(n))process.exit(0);const r=cp.spawnSync(n,process.argv.slice(1),{stdio:'inherit',windowsHide:true});process.exit(r.status??1);";
  for (const groups of Object.values(manifest.hooks)) {
    if (!Array.isArray(groups)) throw Error("Codex hook groups must be arrays");
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks)) throw Error("Codex hook group has no hooks");
      for (const hook of group.hooks) {
        if (!object(hook) || hook.type !== "command" || typeof hook.command !== "string" || !hook.command.startsWith(prefix)) throw Error("Unsupported Codex hook command");
        const tail = hook.command.slice(prefix.length);
        if (!/^"\$\{PLUGIN_ROOT\}\/hooks\/scripts\/(?:activity-relay|refocus)\.cjs" (?:--from-plugin|--runtime codex)$/.test(tail)) throw Error("Unsupported Codex hook command");
        hook.command = `"${process.execPath}" -e "${forwarder}" -- ${tail}`;
      }
    }
  }
  return JSON.stringify(manifest, null, 2) + "\n";
}

/** Exact platform projection used by staging and by the shipped-tree comparator. */
export function platformPluginFile(pluginName: string, relative: string, contents: string): string {
  if (process.platform !== "win32" || pluginName !== "openrig-core") return contents;
  const file = relative.replaceAll("\\", "/");
  if (file === "hooks/claude.json") return windowsClaudePluginHooks(contents);
  if (file === "hooks/codex.json") return windowsCodexPluginHooks(contents);
  return contents;
}
