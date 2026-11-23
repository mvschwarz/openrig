/** Shell-quote a string using single quotes (POSIX-safe). */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** One argument of a command printed for a person to copy into a shell: as it is when it's plain, quoted otherwise. */
export function shellArg(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : shellQuote(s);
}
