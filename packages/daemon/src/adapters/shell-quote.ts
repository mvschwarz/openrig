/** Shell-quote a string using single quotes (POSIX-safe). */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** A word the shell reads as itself is left as it is; anything else is single-quoted (the same safe set as the tmux
 *  adapter's argv join). A name that needed no quoting prints exactly as before. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
export function shellWord(s: string): string {
  return SHELL_SAFE.test(s) ? s : shellQuote(s);
}
