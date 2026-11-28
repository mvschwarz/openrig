/** Shell-quote a string using single quotes (POSIX-safe). */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** Split a POSIX command line built with shellQuote (single quotes, double quotes, backslashes). */
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let has = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      current += command.slice(i + 1, end < 0 ? command.length : end);
      i = end < 0 ? command.length : end;
      has = true;
    } else if (char === '"') {
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) i += 1;
        current += command[i];
        i += 1;
      }
      has = true;
    } else if (char === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      i += 1;
      has = true;
    } else if (/\s/.test(char)) {
      if (has) words.push(current);
      current = "";
      has = false;
    } else {
      current += char;
      has = true;
    }
  }
  if (has) words.push(current);
  return words;
}

/** A word the shell reads as itself is left as it is; anything else is single-quoted (the same safe set as the tmux
 *  adapter's argv join). A name that needed no quoting prints exactly as before. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
export function shellWord(s: string): string {
  return SHELL_SAFE.test(s) ? s : shellQuote(s);
}
