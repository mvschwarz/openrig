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

/** Exact platform projection used by staging and by the shipped-tree comparator. */
export function platformPluginFile(pluginName: string, relative: string, contents: string): string {
  return process.platform === "win32" && pluginName === "openrig-core" && relative.replaceAll("\\", "/") === "hooks/claude.json"
    ? windowsClaudePluginHooks(contents) : contents;
}
