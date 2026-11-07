/** Current interactive Claude 2.1.312 theme picker, including its tall preview.
 * This establishes a dialog for the native send guard, never permission to cancel
 * it. A later composer, quoted frame, partial menu or editor is not this surface. */
export function currentClaudeThemeMenu(pane: string): string | null {
  const lines = pane.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  // OpenRig-launched Claude may draw its named seat rule below the menu footer.
  if (/^─{3,} [\w.-]+@[\w.-]+ ─+$/.test(lines.at(-1) ?? "")) lines.pop();
  if (lines.at(-1) !== "Enter to select · Esc to cancel") return null;
  const header = lines.lastIndexOf("Theme");
  if (header < 1 || !/^─{3,}$/.test(lines[header - 1]!)
    || lines[header + 1] !== "Choose the text style that looks best with your terminal") return null;
  const body = lines.slice(header + 2, -1);
  const labels = ["Auto (match terminal)", "Dark mode", "Light mode", "Dark mode (colorblind-friendly)",
    "Light mode (colorblind-friendly)", "Dark mode (ANSI colors only)", "Light mode (ANSI colors only)", "New custom theme…"];
  if (body.length !== 15) return null;
  let pointers = 0, checks = 0;
  const choices = body.slice(0, labels.length).map(line => {
    if (/^❯\s+/.test(line)) { pointers++; line = line.replace(/^❯\s+/, ""); }
    if (/^✔\s+/.test(line)) { checks++; line = line.replace(/^✔\s+/, ""); }
    return line;
  });
  if (pointers !== 1 || checks !== 1 || !choices.every((line, i) => line === labels[i])) return null;
  if (!/^╌{3,}$/.test(body[8]!) || !/^╌{3,}$/.test(body[13]!)) return null;
  const preview = [/^1\s+function greet\(\) \{$/, /^2\s*-\s+console\.log\("Hello, World!"\);$/,
    /^2\s*\+\s+console\.log\("Hello, Claude!"\);$/, /^3\s+\}$/];
  if (!preview.every((pattern, i) => pattern.test(body[9 + i]!))
    || !/^Syntax theme: .+ \(ctrl\+t to disable\)$/.test(body[14]!)) return null;
  return lines[header]!;
}
