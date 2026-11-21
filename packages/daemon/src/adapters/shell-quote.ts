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
