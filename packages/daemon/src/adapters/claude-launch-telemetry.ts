import path from "node:path";
import { projectRootForLocalSettings } from "../domain/claude-credential-precedence.js";
import { isOwnedCollectorCommand, isOwnedRelayCommand, stripOwnedRelayHooks } from "../domain/claude-owned-settings.js";
import { type ActivityRelayEvent, managedClaudeNodeCommand, parseManagedClaudeNodeCommand } from "../domain/claude-activity-hooks.js";
import { storedStatuslineThrottle, throttledCollectorCommand } from "../domain/claude-statusline-throttle.js";
import { contextUsageDirectory, providerUsageDirectory } from "../domain/telemetry-state-paths.js";
import { composeClaudeLaunchSettings, readSettingsFile, type ClaudeSettingsSeat } from "./claude-settings-transport.js";

export type ClaudeLaunchTelemetry = (input: {
  args: string[];
  nodeId: string;
  cwd: string;
  session: string;
  paneSession: string;
  configDir?: string;
  executable?: string;
  activitySelected?: boolean;
  warnings: string[];
}) => Promise<string[]>;

type Settings = Record<string, unknown>;
function asObject(value: unknown): Settings | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Settings : undefined;
}

function readSettings(file: string): Settings | undefined {
  try {
    // Keep following settings-layer symlinks and check the opened target before reading it.
    const text = readSettingsFile(file, { followSymlinks: true });
    return text.trim() === "" ? {} : asObject(JSON.parse(text));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? {} : undefined;
  }
}

/** Scope follows Claude's own flags. Managed settings still outrank the launch's value. */
function settingsLayers(args: string[], cwd: string, configDir: string, warnings: string[]): Array<Settings | undefined> {
  let sources = "user,project,local";
  for (const [index, arg] of args.entries()) {
    if (arg === "--setting-sources") sources = args[index + 1] ?? "";
    else if (arg.startsWith("--setting-sources=")) sources = arg.slice("--setting-sources=".length);
  }
  const enabled = sources.split(",");
  const files = [
    ...(enabled.includes("user") ? [path.join(configDir, "settings.json")] : []),
    ...(enabled.includes("project") ? [path.join(cwd, ".claude", "settings.json")] : []),
  ];
  let localRootUnreadable = false;
  if (enabled.includes("local")) {
    files.push(path.join(cwd, ".claude", "settings.local.json"));
    try {
      const localRoot = projectRootForLocalSettings(cwd);
      if (localRoot && localRoot !== cwd) files.push(path.join(localRoot, ".claude", "settings.local.json"));
    } catch {
      localRootUnreadable = true;
    }
  }
  const layers = files.map(readSettings);
  if (localRootUnreadable) {
    warnings.push("OpenRig could not read the Claude project root and left the status line to Claude.");
    layers.push(undefined);
  } else if (layers.includes(undefined)) {
    warnings.push("OpenRig could not inspect a Claude settings file and left the status line to Claude.");
  }
  return layers;
}

function hookEntries(settings: Settings | undefined, event: string): Settings[] {
  const groups = asObject(settings?.hooks)?.[event];
  if (!Array.isArray(groups)) return [];
  return groups.flatMap<Settings>((group: unknown) => {
    const values = asObject(group)?.hooks;
    return Array.isArray(values) ? values.map(asObject).filter((hook): hook is Settings => hook !== undefined) : [];
  });
}

type LaunchMaterial = ClaudeSettingsSeat & {
  openrigHome: string;
  cwd: string;
  configDir: string;
  collector: string;
  relay: string;
  events: readonly ActivityRelayEvent[];
  throttleSeconds: number | null;
};

/** Put OpenRig's telemetry in Claude's one launch-local settings value. Existing projects are read-only. */
export function withClaudeLaunchTelemetry(args: string[], material: LaunchMaterial, warnings: string[]): string[] {
  if (args.includes("--bare") || args.includes("--safe-mode")) return args;
  const layers = settingsLayers(args, material.cwd, material.configDir, warnings);
  return composeClaudeLaunchSettings(args, material, material.cwd, warnings, settings => {
    const result = { ...settings };
    const hooks = { ...asObject(settings.hooks) };
    const removedRelay = stripOwnedRelayHooks(hooks);
    const legacyHooks = [...layers, settings];
    for (const { event, timeout } of material.events) {
      const command = legacyHooks.flatMap(layer => hookEntries(layer, event))
        .map(hook => hook.command).find(command => typeof command === "string" && isOwnedRelayCommand(command)
          && parseManagedClaudeNodeCommand(command)?.args[0] === material.relay)
        ?? managedClaudeNodeCommand(process.execPath, material.relay);
      // Claude runs identical commands once across the loaded scopes. Reuse an old command while both layers coexist.
      const group = { hooks: [{ type: "command", command, ...(timeout === undefined ? {} : { timeout }) }] };
      const groups = hooks[event];
      hooks[event] = [...(Array.isArray(groups) ? groups : []), group];
    }
    if (material.events.length > 0 || removedRelay) {
      if (Object.keys(hooks).length > 0) result.hooks = hooks;
      else delete result.hooks;
    }

    const contextDir = contextUsageDirectory(material.openrigHome);
    const collector = (script: string) => managedClaudeNodeCommand(process.execPath, script, contextDir,
      providerUsageDirectory(material.openrigHome));
    const collectorCommand = collector(material.collector);
    const launchCollector = (command: string, seconds: number) => throttledCollectorCommand({
      collectorCommand: command, contextDir, sessionName: material.session, seconds,
    });
    const ownedCollector = (command: string) => {
      if (isOwnedCollectorCommand(command) || command === collectorCommand) return true;
      const seconds = storedStatuslineThrottle(Number(/ -lt (\d+) \]; then exit 0; fi;;/.exec(command)?.[1]));
      return seconds !== null && (command === launchCollector(collectorCommand, seconds)
        || command === launchCollector(collector(path.join(material.cwd, ".openrig", "context-collector.cjs")), seconds));
    };
    const statusLine = asObject(settings.statusLine);
    const customLine = [...layers, settings].some(layer => {
      const command = asObject(layer?.statusLine)?.command;
      return typeof command === "string" && command.trim() !== "" && !ownedCollector(command);
    });
    if (!customLine && !layers.includes(undefined)) {
      const command = material.throttleSeconds === null ? collectorCommand : launchCollector(collectorCommand, material.throttleSeconds);
      result.statusLine = { ...statusLine, type: "command", command };
    } else {
      if (statusLine && typeof statusLine.command === "string" && ownedCollector(statusLine.command)) {
        const { type: _type, command: _command, ...rest } = statusLine;
        if (Object.keys(rest).length) result.statusLine = rest;
        else delete result.statusLine;
      }
      if (customLine && material.throttleSeconds !== null) {
        warnings.push("OpenRig kept the configured Claude status line and skipped its context collector throttle.");
      }
    }
    return result;
  });
}
