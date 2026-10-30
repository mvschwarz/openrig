/** Resource identity stays unchanged in specs/records; only its local directory
 * component is escaped on Windows. Escape percent too, so an encoded qualified
 * id cannot collide with a literal percent spelling. POSIX paths stay stable. */
export function resourceDirectoryName(id: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return id;
  const escape = (value: string) => [...Buffer.from(value)].map(byte => "%" + byte.toString(16).toUpperCase().padStart(2, "0")).join("");
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  if (!/[%<>:"/\\|?*\x00-\x1f]|[. ]$/.test(id) && !reserved.test(id)) return id;
  // Newly representable IDs also encode case and Unicode differences, which
  // otherwise alias each other on a case-insensitive Windows volume.
  let name = Array.from(id, char => /^[a-z0-9._-]$/.test(char) ? char : escape(char)).join("").replace(/[. ]+$/, escape);
  if (reserved.test(name)) name = escape(name[0]!) + name.slice(1);
  return name;
}

export function resourceIdFromDirectoryName(name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return name;
  try { return decodeURIComponent(name); } catch { return name; }
}
