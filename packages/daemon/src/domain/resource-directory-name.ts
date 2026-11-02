/** Resource identity stays unchanged in specs/records; only its local directory
 * component is escaped on Windows. Escape percent too, so an encoded qualified
 * id cannot collide with a literal percent spelling. POSIX paths stay stable. */
export function resourceDirectoryName(id: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return id;
  const escape = (value: string) => [...Buffer.from(value)].map(byte => "%" + byte.toString(16).toUpperCase().padStart(2, "0")).join("");
  // Win32 also reserves the ISO-8859-1 superscript digits in COM/LPT names,
  // including when followed by an extension (Microsoft file naming rules).
  const reserved = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
  if (!/[%<>:"/\\|?*\x00-\x1f]|[. ]$/.test(id) && !reserved.test(id)) return id;
  // Newly representable IDs also encode case and Unicode differences, which
  // otherwise alias each other on a case-insensitive Windows volume.
  let name = Array.from(id, char => /^[a-z0-9._-]$/.test(char) ? char : escape(char)).join("").replace(/[. ]+$/, escape);
  if (reserved.test(name)) name = escape(name[0]!) + name.slice(1);
  if (name.length > 255) {
    // Three hex digits per caseless CJK character keep every POSIX-sized
    // UTF-8 component (<=255 bytes) within 173 UTF-16 units on Windows.
    // %_ cannot occur in the ordinary percent encoding. Its digit records
    // trailing hex padding, so the complete identity remains reversible.
    const hex = Buffer.from(id).toString("hex"), padding = (3 - hex.length % 3) % 3;
    const packed = hex.padEnd(hex.length + padding, "0").match(/.{3}/g)!
      .map(group => String.fromCharCode(0x4e00 + parseInt(group, 16))).join("");
    name = `%_${padding}${packed}`;
    if (name.length > 255) throw new Error("Resource identity exceeds native directory component capacity");
  }
  return name;
}

export function resourceIdFromDirectoryName(name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return name;
  if (/^%_[012][\u4e00-\u5dff]+$/.test(name)) {
    const padding = Number(name[2]);
    const hex = Array.from(name.slice(3), char => (char.charCodeAt(0) - 0x4e00).toString(16).padStart(3, "0")).join("");
    if (padding && !hex.endsWith("0".repeat(padding))) return name;
    const unpadded = padding ? hex.slice(0, -padding) : hex;
    if (unpadded.length % 2) return name;
    const id = Buffer.from(unpadded, "hex").toString("utf8");
    try { if (resourceDirectoryName(id, platform) === name) return id; } catch { /* Not a canonical encoded identity. */ }
    return name;
  }
  try { return decodeURIComponent(name); } catch { return name; }
}
