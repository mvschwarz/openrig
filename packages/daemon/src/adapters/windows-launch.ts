/** Parse only the literal word form produced by the runtime command builders.
 * No expansions, operators or substitutions are evaluated or translated. */
export function parseLiteralLaunchWords(command: string): string[] {
  const words: string[] = [];
  let word = "", quote: "'" | '"' | undefined, started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else {
        if (quote === '"' && /[$`\\]/.test(char)) throw new Error("Expanded launch word is unsupported");
        word += char;
      }
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else {
      if (/[;&|<>$`(){}\\]/.test(char)) throw new Error("Nonliteral launch syntax is unsupported");
      word += char; started = true;
    }
  }
  if (quote) throw new Error("Unterminated launch word");
  if (started) words.push(word);
  if (!words[0]) throw new Error("Empty launch command");
  return words;
}

export function powershellQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export function renderWindowsLaunch(command: string, env: Readonly<Record<string, string>> = {}): string {
  const [executable, ...args] = parseLiteralLaunchWords(command);
  const assignments = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid environment name");
    return `$env:${key}=${powershellQuote(value)}; `;
  }).join("");
  return `${assignments}& ${powershellQuote(executable!)} @(${args.map(powershellQuote).join(", ")})`;
}
