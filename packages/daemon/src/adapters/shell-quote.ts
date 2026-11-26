/** Shell-quote a string using single quotes (POSIX-safe). */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** A word in human-facing POSIX/PowerShell guidance. This is shell parsing,
 * not a replacement for the native Windows argv bridge for embedded quotes. */
export function operatorShellWord(value: string, platform: NodeJS.Platform = process.platform): string {
  if (value.includes("\0")) throw new Error("Invalid guidance argument");
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return platform === "win32" ? "'" + value.replace(/'/g, "''") + "'" : shellQuote(value);
}

/** A word the shell reads as itself is left as it is; anything else is single-quoted (the same safe set as the tmux
 *  adapter's argv join). A name that needed no quoting prints exactly as before. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;
export function shellWord(s: string): string {
  return SHELL_SAFE.test(s) ? s : shellQuote(s);
}
