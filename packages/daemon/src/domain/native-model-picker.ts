/** The program's own model picker (`/model`), open now at the bottom of the pane. A positive reading establishes a
 * dialog for the native send guard, never permission to answer or cancel it: an Enter there confirms the highlighted
 * model. A later composer, quoted or fenced text, a partial menu or an unknown footer is not this surface. */

const CLAUDE_MODEL_FOOTERS = ["Enter to set as default · s to use this session only · Esc to cancel"];
const CODEX_MODEL_FOOTERS = ["enter select · esc back", "enter default · s session · esc back"];

/** The choice rows between a picker's instruction and its footer hold exactly one highlighted, numbered row. */
function oneHighlightedChoice(body: string[], pointer: string): boolean {
  const choice = new RegExp(`^(?:[↑↓]\\s*)?(?:${pointer}\\s*)?\\d+\\.\\s+\\S`);
  const highlighted = new RegExp(`^(?:[↑↓]\\s*)?${pointer}\\s*\\d+\\.\\s+\\S`);
  return body.some(line => choice.test(line)) && body.filter(line => highlighted.test(line)).length === 1;
}

/** Claude Code's current model picker (as drawn by 2.1.282 and 2.1.322). */
export function currentClaudeModelMenu(pane: string): string | null {
  const lines = pane.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // OpenRig-launched Claude may draw its named seat rule below the menu footer.
  if (/^─{3,} [\w.-]+@[\w.-]+ ─+$/.test(lines.at(-1) ?? "")) lines.pop();
  if (!CLAUDE_MODEL_FOOTERS.includes(lines.at(-1) ?? "")) return null;
  const header = lines.lastIndexOf("Select model");
  if (header < 1 || !/^─{3,}$/.test(lines[header - 1]!) || !lines[header + 1]?.startsWith("Switch between Claude models.")) return null;
  return oneHighlightedChoice(lines.slice(header + 2, -1), "❯") ? lines[header]! : null;
}

/** Codex's current model picker and the reasoning-level step it leads to (as drawn by 0.167.2). */
export function currentCodexModelPicker(pane: string): string | null {
  const lines = pane.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!CODEX_MODEL_FOOTERS.includes(lines.at(-1) ?? "")) return null;
  const header = lines.map(line => line === "Select Model and Effort" || /^Select Reasoning Level for \S.*$/.test(line)).lastIndexOf(true);
  if (header < 0) return null;
  return oneHighlightedChoice(lines.slice(header + 1, -1), "›") ? lines[header]! : null;
}
