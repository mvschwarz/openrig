import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

const RESERVED = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
const UNSAFE = /[%<>:"/\\|?*\x00-\x1f]|[. ]$/;

/** Resource identity stays unchanged in specs/records; only its local directory
 * component is escaped on Windows. Escape percent too, so an encoded qualified
 * id cannot collide with a literal percent spelling. POSIX paths stay stable. */
export function resourceDirectoryName(id: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return id;
  return encodeNativeName(id);
}

function encodeNativeName(id: string, forceFirst = false): string {
  const escape = (value: string) => [...Buffer.from(value)].map(byte => "%" + byte.toString(16).toUpperCase().padStart(2, "0")).join("");
  // Win32 also reserves the ISO-8859-1 superscript digits in COM/LPT names,
  // including when followed by an extension (Microsoft file naming rules).
  if (!forceFirst && /^[a-z0-9._-]+$/.test(id) && !UNSAFE.test(id) && !RESERVED.test(id)) return id;
  // Encode case/Unicode for ordinary IDs too, not just qualified IDs.
  let name = Array.from(id, (char, index) => /^[a-z0-9._-]$/.test(char) && !(forceFirst && index === 0) ? char : escape(char)).join("").replace(/[. ]+$/, escape);
  if (RESERVED.test(name)) name = escape(name[0]!) + name.slice(1);
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

/** Preserve an exact legacy directory in place, including operator edits. A
 * different legacy case spelling cannot claim this ID: use a reversible alias
 * for an otherwise lowercase canonical name that would collide with it. No
 * directory is renamed, linked, overwritten or treated as another identity. */
export function resourceDirectoryPath(root: string, id: string, platform: NodeJS.Platform = process.platform): string {
  const canonical = resourceDirectoryName(id, platform);
  if (platform !== "win32") return join(root, canonical);
  let entries: Dirent[];
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return join(root, canonical); throw error; }
  const alias = encodeNativeName(id, true);
  const legacy = !UNSAFE.test(id) && !RESERVED.test(id) ? id : undefined;
  const candidates = new Set([canonical, alias, ...(legacy === undefined ? [] : [legacy])]);
  const existing = entries.filter(entry => candidates.has(entry.name));
  if (existing.length > 1) throw new Error(`Ambiguous resource directories for ${id}; preserve and reconcile the existing spellings before projection`);
  if (existing.length === 1) {
    if (!existing[0]!.isDirectory()) throw new Error(`Resource directory for ${id} is not an ordinary directory`);
    return join(root, existing[0]!.name);
  }
  // Uppercase comparison is conservative for Unicode legacy names such as
  // long-s, which can alias an ASCII letter on Windows volumes.
  const collision = entries.some(entry => entry.name.toUpperCase() === canonical.toUpperCase());
  if (collision && alias === canonical) throw new Error(`Resource directory spelling for ${id} collides with an existing entry`);
  return join(root, collision ? alias : canonical);
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
    try { if (resourceDirectoryName(id, platform) === name || encodeNativeName(id, true) === name) return id; } catch { /* Not a canonical encoded identity. */ }
    return name;
  }
  try { return decodeURIComponent(name); } catch { return name; }
}
