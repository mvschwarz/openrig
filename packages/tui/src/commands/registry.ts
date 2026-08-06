// REGISTRY I1 (ruling 64f1dbdf) — the ONE command registry, sole source of the TUI's
// command surface. A UI action cannot exist without an entry here: the grammar
// (grammar.ts) DERIVES its verb table, arg validation, and error listings from this
// registry, so an undocumented action is impossible BY CONSTRUCTION (PM pin 1's parity
// suite enforces it at CI). Render surfaces (the CLI dump, the palette, the socket
// query — I2-I4) are SERIALIZED projections of these entries, never hand-maintained
// (PM pin 2). `context` is the honest-availability qualifier (PM pin 3): "always"
// renders in every state; "standard" requires the normal daemon-up shell.
import type { Action, ResourceKind, SectionDef } from "../types.js";

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
}

export interface BuildCtx {
  sections: readonly SectionDef[];
}

const RESOURCES: ResourceKind[] = ["host", "rig", "pod", "agent", "spec"];
const TABS = ["table", "overview", "graph", "topology", "configuration", "yaml", "pulse"] as const;

function drillEntry(resource: ResourceKind): CommandEntry {
  return {
    name: resource,
    aliases: [],
    args: "<name>",
    description: `drill into the named ${resource}`,
    context: "standard",
    sample: `${resource} x`,
    build: (name) =>
      name
        ? { type: "drill", resource, name }
        : { type: "error", message: `${resource} drill needs a name (e.g. "${resource} <name>")` },
  };
}

export const COMMAND_REGISTRY: readonly CommandEntry[] = [
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
    aliases: [],
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
    build: (name) =>
      name === "up" || name === "down"
        ? { type: "content-scroll", delta: name === "down" ? 10 : -10 }
        : { type: "error", message: `unknown scroll direction "${name}" — known: scroll up, scroll down` },
  },
  {
    name: "spec-of",
    aliases: [],
    args: "<agent>",
    description: "cross-navigate to the spec of the named agent",
    context: "standard",
    sample: "spec-of dev.driver",
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
    build: (name) =>
      name
        ? { type: "cross", kind: "running", name }
        : { type: "error", message: `running needs a target name (e.g. "running driver-agent")` },
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
  const verbs = COMMAND_REGISTRY.filter((e) => !e.prefix)
    .map((e) => (e.args ? `${e.name} ${e.args}` : e.name))
    .join(", ");
  return `unknown command "${verb}" — known: :<section> /<filter> ${verbs}`;
}
