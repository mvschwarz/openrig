import { COMMAND_REGISTRY, evaluateAvailability, VERB_TABLE, type CompletionContext } from "./registry.js";

/** Completion proposes text; execution still goes through parseCommand and dispatch. */
export function completeCommand(line: string, ctx: CompletionContext, context = "standard") {
  const input = line.trimStart();
  const leading = line.slice(0, line.length - input.length);
  let head = "";
  let prefix = input;
  let choices: string[];
  if (input.startsWith(":")) {
    const section = input.slice(1);
    prefix = section.trimStart();
    head = input.slice(0, input.length - prefix.length);
    choices = ctx.state.sections.map((s) => s.name);
  } else {
    const match = /^(\S+)(\s+)(.*)$/.exec(input);
    if (match) {
      const entry = VERB_TABLE.get(match[1]!);
      head = match[1]! + match[2]!;
      prefix = match[3]!;
      choices = [...(entry && evaluateAvailability(entry, context).available ? entry.complete?.(ctx) ?? [] : [])];
    } else {
      choices = COMMAND_REGISTRY.filter((e) => evaluateAvailability(e, context).available)
        .flatMap((e) => [e.name, ...e.aliases]);
    }
  }
  const candidates = [...new Set(choices)].filter((c) => c.startsWith(prefix)).sort();
  if (!candidates.length) return { line, candidates, message: "No completion match; edit the text or use ? for help" };
  let common = candidates[0]!;
  for (const candidate of candidates) while (!candidate.startsWith(common)) common = common.slice(0, -1);
  let completed = leading + head + common;
  if (!head && candidates.length === 1 && VERB_TABLE.get(common)?.args) completed += " ";
  return { line: completed, candidates, message: candidates.length === 1 ? "Completed · Enter runs · Esc clears" : `${candidates.length} matches · keep typing, then Tab` };
}
