// REGISTRY I1 (ruling 64f1dbdf) — the ONE command registry, sole source of the TUI's
// command surface. A UI action cannot exist without an entry here: the grammar
// (grammar.ts) DERIVES its verb table, arg validation, and error listings from this
// registry, so an undocumented action is impossible BY CONSTRUCTION (PM pin 1's parity
// suite enforces it at CI). Render surfaces (the CLI dump, the palette, the socket
// query — I2-I4) are SERIALIZED projections of these entries, never hand-maintained
// (PM pin 2). `context` is the honest-availability qualifier (PM pin 3): "always"
// renders in every state; "standard" requires the normal daemon-up shell.
import type { Action, ResourceKind, SectionDef, FleetSnapshot, ViewState, ViewTab } from "../types.js";

import { CONFIG_CATEGORIES } from "../config/config-model.js";
import { GRAPH_STYLE_NAMES } from "../topology/render-graph.js";

export interface CompletionContext { state: ViewState; snapshot: FleetSnapshot }

export function availableTabs(state: ViewState, snap: FleetSnapshot): ViewTab[] {
  const rigSpec = state.section === "specs" && state.drill.at(-1)?.kind === "spec"
    && snap.specs.find((s) => s.name === state.drill.at(-1)?.name)?.kind === "rig";
  return [...(rigSpec ? ["graph", "topology", "configuration", "yaml"] : state.section === "topology" ? ["table", "recent", "overview", "graph", "health"] : []), "pulse"] as ViewTab[];
}

function resourceNames(resource: ResourceKind, snap: FleetSnapshot): string[] {
  if (resource === "spec") return snap.specs.map((s) => s.name);
  if (resource === "host") return snap.hosts.map((h) => h.name);
  const entries: Array<{ name: string; qualified: string }> = [];
  for (const h of snap.hosts) for (const r of h.rigs) {
    if (resource === "rig") entries.push({ name: r.name, qualified: `${h.name}/${r.name}` });
    for (const p of r.pods) {
      if (resource === "pod") entries.push({ name: p.name, qualified: `${h.name}/${r.name}/${p.name}` });
      if (resource === "agent") for (const a of p.agents) entries.push({ name: a.name, qualified: `${h.name}/${r.name}/${p.name}/${a.name}` });
    }
  }
  return entries.map((entry) => entries.filter((e) => e.name === entry.name).length > 1 ? entry.qualified : entry.name);
}

function workflowArgs(ctx: CompletionContext, packets: boolean): string[] {
  const ex = ctx.snapshot.execution;
  if (!ctx.state.scopesMission || ex?.mission !== ctx.state.scopesMission) return [];
  return (ex.lifecycle_instances ?? []).flatMap((instance) => packets
    ? (Array.isArray(instance.frontier_packets) ? instance.frontier_packets : []).map((p: { packet_id?: unknown }) => p.packet_id).filter((v): v is string => typeof v === "string")
    : typeof instance.instance_id === "string" ? [instance.instance_id] : []);
}

export interface CommandEntry {
  /** Canonical verb (or prefix glyph for prefix-form commands). */
  name: string;
  /** First-class alternatives — the palette and grammar match these equally (PM pin 5). */
  aliases: string[];
  /** Human-readable argument shape, e.g. "<view>" — serialized verbatim to every surface. */
  args: string;
  description: string;
  /** Availability context (PM pin 3): composes with the C3 detector states downstream. */
  context: "standard" | "always";
  /** Prefix-form commands (`:` jump, `/` filter) parse structurally, not by verb token. */
  prefix?: boolean;
  /** A canonical parseable invocation — the parity suite proves it yields a non-error action. */
  sample: string;
  /** Build the action from the argument remainder (verb commands only). */
  build?: (name: string, ctx: BuildCtx) => Action;
  complete?: (ctx: CompletionContext) => readonly string[];
}

export interface BuildCtx {
  sections: readonly SectionDef[];
}

const RESOURCES: ResourceKind[] = ["host", "rig", "pod", "agent", "spec"];
const TABS = ["table", "recent", "overview", "graph", "health", "topology", "configuration", "yaml", "pulse"] as const;

function drillEntry(resource: ResourceKind): CommandEntry {
  return {
    name: resource,
    aliases: [],
    args: "<name>",
    description: `drill into the named ${resource}`,
    context: "standard",
    sample: `${resource} x`,
    complete: ({ snapshot }) => resourceNames(resource, snapshot),
    build: (name) =>
      name
        ? { type: "drill", resource, name }
        : { type: "error", message: `${resource} drill needs a name (e.g. "${resource} <name>")` },
  };
}

export const COMMAND_REGISTRY: readonly CommandEntry[] = [
  { name: "launch", aliases: [], args: "", description: "prepare Launch for the selected rig spec; choose its working folder before confirming", context: "standard", sample: "launch", build: () => ({ type: "spec-launch" }) },
  { name: "launch-folder", aliases: [], args: "<absolute path>", description: "set the launch working folder (spaces are literal; no quotes needed)", context: "standard", sample: "launch-folder /work/team", build: folder => ({ type: "launch-folder", folder }) },
  { name: "launch-host", aliases: [], args: "<host|local>", description: "choose a launch host; no argument restores rig up's selected host", context: "standard", sample: "launch-host local", build: host => ({ type: "launch-host", host }) },
  { name: "terminals", aliases: [], args: "", description: "browse Saved and Derived terminal views; preview before explicit Open", context: "standard", sample: "terminals", build: () => ({ type: "jump", section: "terminals" }) },
  { name: "terminal-preview", aliases: [], args: "<view>", description: "passively preview a saved:id or rig:name terminal view", context: "standard", sample: "terminal-preview rig:example", build: view => view ? ({ type: "terminal-preview", view }) : ({ type: "error", message: "terminal-preview needs a view" }) },
  { name: "terminal", aliases: [], args: "<view>", description: "open a rig:name, pod:rig/pod, mission:id, slice:id or saved:id view as tiles in the default provider (herdr)", context: "standard", sample: "terminal rig:example",
    complete: ({ snapshot }) => snapshot.hosts.flatMap((h) => h.rigs.map((r) => `rig:${r.name}`)),
    build: view => view ? ({ type: "act", act: "open-terminal", view }) : ({ type: "error", message: "terminal needs a view, for example rig:<name>" }) },
  { name: "attention", aliases: ["needs", "feed"], args: "", description: "inspect human requests and outcome/health updates", context: "standard", sample: "attention", build: () => ({ type: "jump", section: "needs" }) },
  { name: "read", aliases: [], args: "<root>/<path>[#heading]", description: "read a current file within an explicitly configured root", context: "standard", sample: "read workspace/README.md", complete: ({ snapshot }) => (snapshot.fileRoots ?? []).map((root) => `${root.name}/`), build: (value) => {
    const slash = value.indexOf("/");
    if (slash < 1 || slash === value.length - 1) return { type: "error", message: "read needs <root>/<path>[#heading] from the configured readable roots" };
    const hash = value.indexOf("#", slash);
    return { type: "file-open", target: { root: value.slice(0, slash), path: value.slice(slash + 1, hash < 0 ? undefined : hash), ...(hash < 0 ? {} : { anchor: value.slice(hash + 1) }) } };
  } },
  { name: "system", aliases: [], args: "", description: "instance Health, Configuration and Connections", context: "standard", sample: "system", build: () => ({ type: "jump", section: "system" }) },
  { name: "config", aliases: [], args: "[category]", description: "browse instance settings; Slack is one category", context: "standard", sample: "config", complete: () => CONFIG_CATEGORIES.map((c) => c.id), build: (category) => category ? { type: "config-category", category } : { type: "jump", section: "config" } },
  { name: "setting", aliases: [], args: "<key>", description: "open a setting with its full value, source and scope", context: "standard", sample: "setting workspace.root", complete: ({ snapshot }) => (snapshot.config?.entries ?? []).map((e) => e.key), build: (key) => key ? { type: "config-setting", key } : { type: "error", message: "setting needs a key" } },
  { name: "refresh", aliases: [], args: "", description: "read the current view again; stored values do not prove runtime adoption", context: "standard", sample: "refresh", build: () => ({ type: "noop" }) },
  { name: "timezone", aliases: [], args: "", description: "show local time setting and persistent rig config instructions", context: "standard", sample: "timezone", build: () => ({ type: "timezone" }) },
  { name: "recent", aliases: [], args: "<transition-id>", description: "inspect an original event from the served Recent window", context: "standard", sample: "recent 1", complete: ({ snapshot }) => (snapshot.recentTransitions ?? []).map((r) => String(r.transitionId)), build: (id) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? { type: "recent-open", transitionId: Number(id) } : { type: "error", message: "recent needs a transition id from the served window" } },
  { name: "connections", aliases: [], args: "", description: "System Connections: gateway, recipients and routes", context: "standard", sample: "connections", build: () => ({ type: "jump", section: "connections" }) },
  { name: "back", aliases: [], args: "", description: "return to the previous view, selection and scroll", context: "standard", sample: "back", build: () => ({ type: "back" }) },
  { name: "projects", aliases: [], args: "", description: "choose a project from the workspace catalog", context: "standard", sample: "projects", build: () => ({ type: "jump", section: "scopes" }) },
  { name: "project", aliases: [], args: "<id>", description: "select an exact catalog project", context: "standard", sample: "project example", complete: ({ snapshot }) => (snapshot.projects?.projects ?? []).map(p => p.id), build: id => id ? { type: "project-select", id } : { type: "error", message: "project needs a catalog ID" } },
  { name: "source", aliases: [], args: "", description: "read the selected project, mission or slice source", context: "standard", sample: "source", build: () => ({ type: "project-source" }) },
  { name: "mission", aliases: [], args: "<name>", description: "open a mission's work and workflows", context: "standard", sample: "mission release-demo", complete: ({ snapshot }) => (snapshot.scopes ?? []).map((m) => m.mission), build: (name) => name ? { type: "scopes-mission-open", mission: name } : { type: "error", message: "mission needs a name" } },
  { name: "workflow", aliases: [], args: "<instance-id>", description: "open a workflow in the selected mission", context: "standard", sample: "workflow example", complete: (ctx) => workflowArgs(ctx, false), build: (name) => name ? { type: "execution-open", key: `workflow:${name}` } : { type: "error", message: "workflow needs an instance id" } },
  { name: "packet", aliases: [], args: "<qitem-id>", description: "open current workflow work in the selected mission", context: "standard", sample: "packet example", complete: (ctx) => workflowArgs(ctx, true), build: (name) => name ? { type: "execution-open", key: `packet:${name}` } : { type: "error", message: "packet needs a queue id" } },
  {
    name: ":",
    aliases: [],
    args: "<section>",
    description: "jump to a section",
    context: "standard",
    prefix: true,
    sample: ":topology",
  },
  {
    name: "/",
    aliases: [],
    args: "<text>",
    description: "filter rows by text",
    context: "standard",
    prefix: true,
    sample: "/dev",
  },
  {
    name: "tab",
    aliases: [],
    args: `<${TABS.join("|")}>`,
    description: "switch the content-pane view tab",
    context: "standard",
    sample: "tab table",
    complete: ({ state, snapshot }) => availableTabs(state, snapshot),
    build: (name) =>
      (TABS as readonly string[]).includes(name)
        ? { type: "tab", tab: name as Extract<Action, { type: "tab" }>["tab"] }
        : { type: "error", message: `unknown tab "${name}" — known: ${TABS.join(", ")}` },
  },
  {
    // P10 (founder-caught) — the registry's FIRST MIGRANT (PM pin 4): previously a bare
    // grammar special-case, now a registered first-class command. Same action as `tab graph`;
    // the view renders honest-empty when no graph is served (honest-degraded rail).
    name: "graph",
    // "g" — the first REAL alias (I1-review nit 2): exercises the alias parity leg for real.
    aliases: ["g"],
    args: "",
    description: "open the topology graph view",
    context: "standard",
    sample: "graph",
    build: () => ({ type: "tab", tab: "graph" }),
  },
  {
    name: "style",
    aliases: [],
    args: "<name>",
    description: "set the graph render style (validated by dispatch against the style registry)",
    context: "standard",
    sample: "style hatchet",
    complete: () => GRAPH_STYLE_NAMES,
    build: (name) =>
      name ? { type: "style", name } : { type: "error", message: 'style needs a name (e.g. "style hatchet")' },
  },
  {
    name: "scroll",
    aliases: [],
    args: "<up|down>",
    description: "scroll the content pane",
    context: "standard",
    sample: "scroll down",
    complete: () => ["up", "down"],
    build: (name) =>
      name === "up" || name === "down"
        ? { type: "content-scroll", delta: name === "down" ? 10 : -10 }
        : { type: "error", message: `unknown scroll direction "${name}" — known: scroll up, scroll down` },
  },
  {
    name: "select-text",
    aliases: ["copy"],
    args: "",
    description: "toggle terminal-native drag selection and copy",
    context: "standard",
    sample: "select-text",
    build: () => ({ type: "copy-mode" }),
  },
  {
    // TUI scroll (ruling cfec754f): jump the content pane to the extremes. Registered as a VERB
    // (`top`), NOT `:top` — `:` is the section-jump prefix (would parse as an unknown section). Reuses
    // content-scroll: the reducer clamps `contentOffset + delta` to [0, max], so an extreme negative
    // delta lands at the top (no new action/reducer).
    name: "top",
    aliases: [],
    args: "",
    description: "scroll the content pane to the top",
    context: "standard",
    sample: "top",
    build: () => ({ type: "content-scroll", delta: -Number.MAX_SAFE_INTEGER }),
  },
  {
    name: "bottom",
    aliases: [],
    args: "",
    description: "scroll the content pane to the bottom",
    context: "standard",
    sample: "bottom",
    build: () => ({ type: "content-scroll", delta: Number.MAX_SAFE_INTEGER }),
  },
  {
    // `find <text>` — the discoverable verb form of the `/` filter prefix (same filter action).
    name: "find",
    aliases: [],
    args: "<text>",
    description: "filter rows by text (verb form of the / prefix)",
    context: "standard",
    sample: "find dev",
    build: (name) =>
      name ? { type: "filter", text: name } : { type: "error", message: 'find needs text (e.g. "find dev")' },
  },
  {
    name: "spec-of",
    aliases: [],
    args: "<agent>",
    description: "cross-navigate to the spec of the named agent",
    context: "standard",
    sample: "spec-of dev.driver",
    complete: ({ snapshot }) => resourceNames("agent", snapshot),
    build: (name) =>
      name
        ? { type: "cross", kind: "spec-of", name }
        : { type: "error", message: `spec-of needs a target name (e.g. "spec-of dev.driver")` },
  },
  {
    name: "running",
    aliases: [],
    args: "<spec>",
    description: "cross-navigate to agents running the named spec",
    context: "standard",
    sample: "running driver-agent",
    complete: ({ snapshot }) => resourceNames("spec", snapshot),
    build: (name) =>
      name
        ? { type: "cross", kind: "running", name }
        : { type: "error", message: `running needs a target name (e.g. "running driver-agent")` },
  },
  {
    // I3 — the palette trigger is itself a REGISTERED command ('?' the founder-ergonomic
    // alias); context "always": help must work in every state.
    name: "help",
    aliases: ["?"],
    args: "",
    description: "open the command palette (fuzzy-find every command)",
    context: "always",
    sample: "help",
    build: () => ({ type: "palette-open" }),
  },
  {
    // SCOPES view (d64d2f5c): the m-key accelerator's command form.
    name: "reqs",
    aliases: [],
    args: "",
    description: "toggle mini-requirements collapse (scopes view)",
    context: "standard",
    sample: "reqs",
    build: () => ({ type: "scopes-reqs" }),
  },
  {
    // SCOPES view: PROGRESS.md as the human narrative log — DISPLAY only, never data.
    name: "narrative",
    aliases: [],
    args: "",
    description: "toggle the PROGRESS.md narrative panel (scopes view)",
    context: "standard",
    sample: "narrative",
    build: () => ({ type: "scopes-narrative" }),
  },
  ...RESOURCES.map(drillEntry),
];

/** Verb → entry map with aliases first-class (PM pin 5). */
export const VERB_TABLE: ReadonlyMap<string, CommandEntry> = new Map(
  COMMAND_REGISTRY.filter((e) => !e.prefix).flatMap((e) => [
    [e.name, e] as const,
    ...e.aliases.map((a) => [a, e] as const),
  ]),
);

/** The unknown-verb error listing — SERIALIZED from the registry (never hand-maintained). */
export function unknownCommandMessage(verb: string): string {
  // I1-review nit 1: the prefix fragment is serialized from the prefix entries too —
  // ZERO hand-written command listings anywhere (mirror-law, whole message).
  const prefixes = COMMAND_REGISTRY.filter((e) => e.prefix)
    .map((e) => `${e.name}${e.args}`)
    .join(" ");
  const verbs = COMMAND_REGISTRY.filter((e) => !e.prefix)
    .map((e) => (e.args ? `${e.name} ${e.args}` : e.name))
    .join(", ");
  return `unknown command "${verb}" — known: ${prefixes} ${verbs}`;
}

/** ONE availability rule (I3 palette + I4 socket share it): "always" satisfies any
 *  context; otherwise the entry's context must equal the current one. */
export function evaluateAvailability(entry: CommandEntry, currentContext: string): { available: boolean; reason?: string } {
  const available = entry.context === "always" || entry.context === currentContext;
  return available ? { available } : { available: false, reason: `needs ${entry.context} context` };
}

/** I4 — the socket "commands" OBSERVE projection: the data contract + LIVE availability.
 *  Serialized from the ONE registry (PM pin 2), evaluated per-session (PM pin 3). */
export function serializeCommands(currentContext: string): Array<{
  name: string; aliases: string[]; args: string; description: string; context: string;
  sample: string; available: boolean; reason?: string;
}> {
  return COMMAND_REGISTRY.map((e) => ({
    name: e.name, aliases: e.aliases, args: e.args, description: e.description,
    context: e.context, sample: e.sample, ...evaluateAvailability(e, currentContext),
  }));
}

/** I5 — the C3 detector state → command context mapping (composes PM pin 3 with the
 *  crash-cart detector): up/absent = the standard shell; down = the crash-cart cockpit;
 *  unverified = its own honest context (nothing pretends the daemon is up OR down). */
export function currentCommandContext(daemonState: "up" | "down" | "unverified" | null | undefined): string {
  if (daemonState === "down") return "crash-cart";
  if (daemonState === "unverified") return "unverified";
  return "standard";
}
