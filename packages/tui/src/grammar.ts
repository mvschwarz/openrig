// Safe-core command grammar (§4.B / FR-1): :section jump · /text filter ·
// <resource> <name> drill · spec-of / running cross-nav. k9s-primary taxonomy.
// parseCommand is pure text → action; target existence is validated by
// dispatch, so every input adapter shares one failure surface.
// Richer grammar (compound commands, prefixes, history/completion) was
// RETIRED by the Phase-0 kill-criterion — see the spike verdict.
//
// REGISTRY I1 (ruling 64f1dbdf): the verb table is DERIVED from the ONE command
// registry (commands/registry.ts) — an unregistered verb cannot parse, so an
// undocumented action is impossible by construction. Prefix forms (`:`, `/`)
// are registered prefix entries and parse structurally here.
import { SECTION_REGISTRY } from "./sections.js";
import { VERB_TABLE, unknownCommandMessage } from "./commands/registry.js";
import type { Action, SectionDef } from "./types.js";

export function parseCommand(raw: string, sections: readonly SectionDef[] = SECTION_REGISTRY): Action {
  const input = raw.trim();
  if (input === "") return { type: "noop" };

  if (input.startsWith(":")) {
    const section = input.slice(1).trim();
    const names = sections.map((entry) => entry.name);
    if (names.includes(section)) return { type: "jump", section };
    return {
      type: "error",
      message: `unknown section ":${section}" — known: ${names.map((s) => ":" + s).join(" ")}`,
    };
  }

  if (input.startsWith("/")) {
    return { type: "filter", text: input.slice(1).trim() };
  }

  const [verb = "", ...rest] = input.split(/\s+/);
  const name = rest.join(" ");

  const entry = VERB_TABLE.get(verb);
  if (entry?.build) return entry.build(name, { sections });

  return { type: "error", message: unknownCommandMessage(verb) };
}
