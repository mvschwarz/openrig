// Safe-core command grammar (§4.B / FR-1): :section jump · /text filter ·
// <resource> <name> drill · spec-of / running cross-nav. k9s-primary taxonomy.
// parseCommand is pure text → action; target existence is validated by
// dispatch, so every input adapter shares one failure surface.
// Richer grammar (compound commands, prefixes, history/completion) was
// RETIRED by the Phase-0 kill-criterion — see the spike verdict.
import type { Action, ResourceKind } from "./types.js";

const SECTIONS = ["topology", "specs", "needs"] as const;
const RESOURCES: ResourceKind[] = ["host", "rig", "pod", "agent", "spec"];

export function parseCommand(raw: string): Action {
  const input = raw.trim();
  if (input === "") return { type: "noop" };

  if (input.startsWith(":")) {
    const section = input.slice(1).trim();
    if ((SECTIONS as readonly string[]).includes(section)) return { type: "jump", section };
    return {
      type: "error",
      message: `unknown section ":${section}" — known: ${SECTIONS.map((s) => ":" + s).join(" ")}`,
    };
  }

  if (input.startsWith("/")) {
    return { type: "filter", text: input.slice(1).trim() };
  }

  const [verb = "", ...rest] = input.split(/\s+/);
  const name = rest.join(" ");

  if (verb === "tab") {
    // FR-3 content-pane view tabs; command path keeps R1.2 (every view
    // reachable by a command). Same <verb> <name> shape as drill — not
    // the retired richer grammar.
    if (["table", "overview", "topology", "configuration", "yaml"].includes(name))
      return { type: "tab", tab: name as Extract<Action, { type: "tab" }>["tab"] };
    return { type: "error", message: `unknown tab "${name}" — known: table, overview, topology, configuration, yaml` };
  }

  if (verb === "scroll") {
    if (name === "up" || name === "down") return { type: "content-scroll", delta: name === "down" ? 10 : -10 };
    return { type: "error", message: `unknown scroll direction "${name}" — known: scroll up, scroll down` };
  }

  if (verb === "spec-of" || verb === "running") {
    if (!name) {
      const example = verb === "spec-of" ? "spec-of dev.driver" : "running driver-agent";
      return { type: "error", message: `${verb} needs a target name (e.g. "${example}")` };
    }
    return { type: "cross", kind: verb, name };
  }

  if ((RESOURCES as string[]).includes(verb)) {
    if (!name) return { type: "error", message: `${verb} drill needs a name (e.g. "${verb} <name>")` };
    return { type: "drill", resource: verb as ResourceKind, name };
  }

  return {
    type: "error",
    message: `unknown command "${verb}" — known: :<section> /<filter> ${RESOURCES.join("|")} <name>, spec-of <agent>, running <spec>`,
  };
}
