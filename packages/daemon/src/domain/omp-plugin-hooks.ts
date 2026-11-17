// Compile selected Claude/Codex plugin manifests for the native OMP hook bridge.
import path from "node:path";
import type { OmpLaunchFsOps } from "../adapters/omp-seat-launch.js";

export const OMP_PLUGIN_HOOK_EVENTS = new Set([
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "PermissionRequest", "PostToolBatch", "Stop", "StopFailure", "Notification", "PreCompact", "PostCompact",
  "SubagentStart", "SubagentStop",
]);

export interface OmpPluginHook {
  event: string;
  matcher?: string;
  type?: "command" | "http" | "prompt" | "agent";
  command?: string;
  args?: string[];
  shell?: "bash" | "powershell";
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  prompt?: string;
  model?: string;
  async?: boolean;
  asyncRewake?: boolean;
  onFailure?: "continue" | "block";
  timeout: number;
}
export interface OmpPluginHookPlan {
  id: string;
  root: string;
  format: "claude" | "codex";
  hooks: OmpPluginHook[];
  warnings?: string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Auto prefers Claude's richer manifest; never execute both copies of a dual-runtime plugin. Native OMP
 * extensions are selected by the caller first, and never run alongside this compatibility bridge. */
export function compileOmpPluginHooks(
  fs: OmpLaunchFsOps, root: string, id: string, pluginType: "claude" | "codex" | "auto" = "auto",
): OmpPluginHookPlan {
  const format = pluginType === "auto"
    ? (fs.exists(path.join(root, ".claude-plugin/plugin.json")) ? "claude" : "codex") : pluginType;
  const manifestFile = path.join(root, `.${format}-plugin/plugin.json`);
  const readObject = (file: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(fs.readFile(file));
    if (!object(parsed)) throw new Error(`Invalid plugin hook manifest: ${file}`);
    return parsed;
  };
  const manifest = fs.exists(manifestFile) ? readObject(manifestFile) : {};
  const sources: Record<string, unknown>[] = [];
  const files = new Set<string>();
  const addFile = (relative: string) => {
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error(`Plugin hook path escapes plugin: ${relative}`);
    if (files.has(file)) return;
    files.add(file);
    sources.push(readObject(file));
  };
  // The conventional hook file is loaded in addition to explicit manifest declarations, without duplicates.
  if (fs.exists(path.join(root, "hooks/hooks.json"))) addFile("hooks/hooks.json");
  if (manifest.hooks !== undefined) {
    if (typeof manifest.hooks === "string") addFile(manifest.hooks);
    else if (object(manifest.hooks)) sources.push(manifest.hooks);
    else throw new Error(`Plugin ${id}: hooks must be a file path or hook registry`);
  } else if (fs.exists(path.join(root, `hooks/${format}.json`))) addFile(`hooks/${format}.json`);
  const hooks: OmpPluginHook[] = [];
  const warnings: string[] = [];
  for (const source of sources) {
    if (!object(source.hooks)) throw new Error(`Plugin ${id}: hook registry must contain a hooks object`);
    for (const [event, groups] of Object.entries(source.hooks)) {
      if (!Array.isArray(groups)) throw new Error(`Plugin ${id}: ${event} must be an array`);
      if (groups.length && !OMP_PLUGIN_HOOK_EVENTS.has(event)) {
        warnings.push(`Plugin ${id}: skipped ${event}; OMP has no equivalent`);
        continue;
      }
      for (const group of groups) {
        if (!object(group) || !Array.isArray(group.hooks)) throw new Error(`Plugin ${id}: invalid ${event} hook group`);
        const matcher = group.matcher;
        if (matcher !== undefined && typeof matcher !== "string") throw new Error(`Plugin ${id}: matcher must be a regex string`);
        if (matcher && matcher !== "*") new RegExp(matcher);
        for (const handler of group.hooks) {
          if (object(handler) && (handler.type === "mcp_tool" || handler.if !== undefined)) {
            warnings.push(`Plugin ${id}: skipped ${event} ${handler.type} handler; conditional and MCP-tool hooks need a native OMP extension`);
            continue;
          }
          if (!object(handler) || !["command", "http", "prompt", "agent"].includes(String(handler.type))) {
            throw new Error(`Plugin ${id}: ${event} has an unsupported hook type`);
          }
          for (const key of ["async", "asyncRewake", "once"]) {
            if (handler[key] !== undefined && typeof handler[key] !== "boolean") throw new Error(`Plugin ${id}: ${key} must be boolean`);
          }
          if (handler.model !== undefined && typeof handler.model !== "string") throw new Error(`Plugin ${id}: model must be a string`);
          const type = handler.type as NonNullable<OmpPluginHook["type"]>;
          const field = type === "command" ? "command" : type === "http" ? "url" : "prompt";
          if (typeof handler[field] !== "string" || !(handler[field] as string).trim()) throw new Error(`Plugin ${id}: ${type} requires ${field}`);
          if (type === "http" && !/^https?:/.test(handler.url as string)) throw new Error(`Plugin ${id}: invalid hook URL`);
          if ((handler.async || handler.asyncRewake) && type !== "command") throw new Error(`Plugin ${id}: only command hooks run asynchronously`);
          if (handler.args !== undefined && (!Array.isArray(handler.args) || handler.args.some(a => typeof a !== "string"))) throw new Error(`Plugin ${id}: args must be strings`);
          if (handler.shell !== undefined && !["bash", "powershell"].includes(String(handler.shell))) throw new Error(`Plugin ${id}: invalid hook shell`);
          if (handler.onFailure !== undefined && !["continue", "block"].includes(String(handler.onFailure))) throw new Error(`Plugin ${id}: invalid onFailure`);
          if (handler.headers !== undefined && (!object(handler.headers) || Object.values(handler.headers).some(v => typeof v !== "string"))) throw new Error(`Plugin ${id}: invalid HTTP headers`);
          if (handler.allowedEnvVars !== undefined && (!Array.isArray(handler.allowedEnvVars) || handler.allowedEnvVars.some(v => typeof v !== "string"))) throw new Error(`Plugin ${id}: invalid allowedEnvVars`);
          const timeout = handler.timeout ?? (type === "prompt" ? 30 : type === "agent" ? 60 : event === "UserPromptSubmit" ? 30 : event === "SessionEnd" ? 1.5 : 600);
          if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) throw new Error(`Plugin ${id}: invalid hook timeout`);
          const hook: OmpPluginHook = { event, type, ...(matcher && matcher !== "*" ? { matcher } : {}), timeout };
          // once is ignored in settings/plugin registries by Claude; it applies only to skill frontmatter.
          for (const key of ["command", "args", "shell", "url", "headers", "allowedEnvVars", "prompt", "model", "async", "asyncRewake", "onFailure"] as const) {
            if (handler[key] !== undefined) Object.assign(hook, { [key]: handler[key] });
          }
          hooks.push(hook);
        }
      }
    }
  }
  return { id, root, format, hooks, ...(warnings.length ? { warnings } : {}) };
}
