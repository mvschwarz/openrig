/** Complete current MCP approval menus from supplied Claude captures. This is not
 * a general checkbox detector: heading, instruction, warning, items and terminal
 * footer must agree. A later composer (including a draft) ends this menu. */
export function currentClaudeMcpMenu(pane: string): string | null {
  const lines = pane.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const footer = lines.at(-1);
  if (footer !== "Space to select · Enter to confirm · Esc to reject all"
    && footer !== "Space to select · Esc to reject all") return null;
  const header = lines.map(line => /^\d+ new MCP servers found in (?:\.mcp\.json|this project)$/.test(line)).lastIndexOf(true);
  if (header < 0 || lines[header + 1] !== "Select any you wish to enable.") return null;
  const item = /^(?:❯\s+)?\[(?:✔| )\]\s+\S.*$/;
  const firstItem = lines.findIndex((line, i) => i > header + 1 && item.test(line));
  if (firstItem < 0 || lines.slice(header + 2, firstItem).join(" ") !==
    "MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP documentation.") return null;
  const choices = lines.slice(firstItem, -1);
  if (/^(?:❯\s+)?Enable selected$/.test(choices.at(-1) ?? "")) choices.pop();
  if (!choices.length || !choices.every(line => item.test(line))) return null;
  return lines[header]!;
}
