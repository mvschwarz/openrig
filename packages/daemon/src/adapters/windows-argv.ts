/** Microsoft CRT argument quoting, with literal backslashes and empty arguments. */
export function windowsArguments(args: readonly string[]): string {
  return args.map(value => {
    if (value.includes("\0")) throw new Error("NUL is not a native argument");
    return '"' + value.replace(/(\\*)"/g, (_match, slashes: string) => slashes + slashes + '\\"')
      .replace(/(\\+)$/g, (slashes: string) => slashes + slashes) + '"';
  }).join(" ");
}

/** Decode observed native argv without treating JSON/string contents as options. */
export function parseWindowsCommandLine(command: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (/[ \t]/.test(command[i] ?? "") && i < command.length) i++;
    if (i === command.length) break;
    let value = "", quoted = false;
    while (i < command.length) {
      const char = command[i]!;
      if (!quoted && /[ \t]/.test(char)) break;
      if (char === "\\") {
        const start = i;
        while (command[i] === "\\") i++;
        const length = i - start;
        if (command[i] !== '"') { value += "\\".repeat(length); continue; }
        value += "\\".repeat(Math.floor(length / 2));
        if (length % 2) { value += '"'; i++; continue; }
      }
      if (command[i] === '"') {
        if (quoted && command[i + 1] === '"') { value += '"'; i += 2; }
        else { quoted = !quoted; i++; }
      } else { value += command[i]!; i++; }
    }
    args.push(value);
  }
  return args;
}
