import nodePath from "node:path";
import { parse as parseToml } from "smol-toml";

// Codex loads the openrig-core plugin's hooks only from a plugin installed through its own marketplace path and enabled
// in its config. OpenRig installs it with Codex's own commands (`codex plugin marketplace add`, `codex plugin add`), which
// write `[plugins."openrig-core@openrig"] enabled = true` into the user config.toml. Before any install or reinstall,
// OpenRig reads the person's choice and never overrides it:
// - an explicit `enabled = false` for the plugin keeps it disabled;
// - with no explicit value for the plugin, an effective `[plugins._default] enabled = false` keeps it disabled too (Codex
//   applies that default to an entry without its own `enabled`, and an install would replace it with an explicit true);
//   like Codex, a higher layer's `_default` overrides a lower one's;
// - an explicit `enabled = true` is the person's choice and allows it;
// - a layer that exists but can't be read or parsed leaves the answer unknown, so nothing is installed.
// The layers read are the config files Codex reads at fixed paths: the system config, the user config, and the legacy
// managed config, in Codex's precedence order. Profiles, project config, session flags, MDM and cloud-managed config are
// not visible here; the report says so.

export const CODEX_CORE_MARKETPLACE = "openrig";
export const CODEX_CORE_PLUGIN = "openrig-core";
export const CODEX_CORE_PLUGIN_KEY = `${CODEX_CORE_PLUGIN}@${CODEX_CORE_MARKETPLACE}`;

/** The config files Codex reads at fixed paths, lowest precedence first, as `{ name, path }`. */
export function codexReadableConfigLayers(codexHome: string, systemDir = "/etc/codex"): Array<{ name: string; path: string }> {
  return [
    { name: "system config", path: nodePath.join(systemDir, "config.toml") },
    { name: "user config", path: nodePath.join(codexHome, "config.toml") },
    { name: "legacy managed config", path: nodePath.join(systemDir, "managed_config.toml") },
  ];
}

/** One layer's text: absent (no file), its contents, or why it couldn't be read. */
export type CodexConfigLayerRead = { name: string; path: string } & ({ state: "absent" } | { state: "read"; content: string } | { state: "unreadable"; reason: string });

export type CodexCorePluginEnablement =
  | { decision: "allow"; reason: string }
  | { decision: "disabled"; reason: string }
  | { decision: "unknown"; reason: string };

const NOT_VISIBLE = "profile, project, session-flag, MDM and cloud-managed config aren't visible to OpenRig";

/** Whether OpenRig may run Codex's install for the plugin, from the layers it can read. */
export function codexCorePluginEnablement(layers: CodexConfigLayerRead[]): CodexCorePluginEnablement {
  let explicit: { enabled: boolean; layer: string } | undefined;
  let defaultOff: string | undefined;
  for (const layer of layers) {
    if (layer.state === "absent") continue;
    if (layer.state === "unreadable") return { decision: "unknown", reason: `${layer.name} at ${layer.path} can't be read (${layer.reason})` };
    let doc: Record<string, unknown>;
    try { doc = parseToml(layer.content) as Record<string, unknown>; }
    catch (error) { return { decision: "unknown", reason: `${layer.name} at ${layer.path} can't be parsed (${(error as Error).message.split("\n")[0]})` }; }
    const plugins = doc["plugins"];
    if (plugins === undefined) continue;
    if (!isTable(plugins)) return { decision: "unknown", reason: `${layer.name} has a plugins value that isn't a table` };
    const entry = plugins[CODEX_CORE_PLUGIN_KEY];
    if (entry !== undefined) {
      if (!isTable(entry)) return { decision: "unknown", reason: `${layer.name} has a ${CODEX_CORE_PLUGIN_KEY} value that isn't a table` };
      if (entry["enabled"] !== undefined) {
        if (typeof entry["enabled"] !== "boolean") return { decision: "unknown", reason: `${layer.name} sets ${CODEX_CORE_PLUGIN_KEY}.enabled to a non-boolean` };
        explicit = { enabled: entry["enabled"], layer: layer.name };
      }
    }
    const fallback = plugins["_default"];
    if (fallback !== undefined) {
      if (!isTable(fallback) || (fallback["enabled"] !== undefined && typeof fallback["enabled"] !== "boolean")) {
        return { decision: "unknown", reason: `${layer.name} has a plugins._default that this reader doesn't recognise` };
      }
      // Layers come lowest precedence first, as Codex merges them: a higher layer's _default replaces a lower one's.
      if (fallback["enabled"] === false) defaultOff = layer.name;
      else if (fallback["enabled"] === true) defaultOff = undefined;
    }
  }
  if (explicit) {
    return explicit.enabled
      ? { decision: "allow", reason: `${CODEX_CORE_PLUGIN_KEY} is explicitly enabled in the ${explicit.layer}` }
      : { decision: "disabled", reason: `${CODEX_CORE_PLUGIN_KEY} is explicitly disabled in the ${explicit.layer}; it stays disabled` };
  }
  if (defaultOff) return { decision: "disabled", reason: `plugins._default disables plugins in the ${defaultOff}; ${CODEX_CORE_PLUGIN_KEY} stays disabled` };
  return { decision: "allow", reason: `no layer OpenRig can read disables ${CODEX_CORE_PLUGIN_KEY} (${NOT_VISIBLE})` };
}

/** The `[marketplaces.openrig]` source recorded in the user config, if any. */
export function recordedMarketplaceSource(userConfig: string | null): string | null | undefined {
  if (userConfig === null) return undefined;
  let doc: Record<string, unknown>;
  try { doc = parseToml(userConfig) as Record<string, unknown>; } catch { return null; }
  const marketplaces = doc["marketplaces"];
  if (!isTable(marketplaces)) return undefined;
  const entry = marketplaces[CODEX_CORE_MARKETPLACE];
  if (entry === undefined) return undefined;
  return isTable(entry) && typeof entry["source"] === "string" ? entry["source"] : null;
}

/** Whether the user config sets an explicit `enabled = true` for the plugin (what Codex's install writes there). */
export function userLayerEnablesCorePlugin(userConfig: string | null): boolean {
  if (userConfig === null) return false;
  let doc: Record<string, unknown>;
  try { doc = parseToml(userConfig) as Record<string, unknown>; } catch { return false; }
  const plugins = doc["plugins"];
  const entry = isTable(plugins) ? plugins[CODEX_CORE_PLUGIN_KEY] : undefined;
  return isTable(entry) && entry["enabled"] === true;
}

/** The local marketplace manifest that lists the vendored plugin, in a layout Codex reads (`.agents/plugins/marketplace.json`). */
export function codexCoreMarketplaceManifest(): string {
  return `${JSON.stringify({
    name: CODEX_CORE_MARKETPLACE,
    interface: { displayName: "OpenRig" },
    plugins: [{ name: CODEX_CORE_PLUGIN, source: `./${CODEX_CORE_PLUGIN}` }],
  }, null, 2)}\n`;
}

export const CODEX_MARKETPLACE_MANIFEST_PATH = nodePath.join(".agents", "plugins", "marketplace.json");

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
