/** The slice a seat scope goes in: seats with process limits leave the terminal server's scope (and any limit an
 *  operator put on it) for this slice. No dash: systemd reads a dash in a slice name as nesting, which would put the
 *  seats under `openrig.slice` and any limit on it. */
export const SEAT_SCOPE_SLICE = "openrigseats.slice";

/** A unit name's longest length (systemd's UNIT_NAME_MAX less its terminating NUL). */
const UNIT_NAME_MAX = 255;

/** The per-rig slice of a rig that groups its seats (#80), or why its name can't make one. */
export type RigSeatSlice = { kind: "slice"; name: string } | { kind: "unusable"; reason: string };

/** `openrigseats-<rig>.slice`: a child of `openrigseats.slice` (the dash after `openrigseats` is the nesting). The rig
 *  name is escaped as systemd escapes a string for a unit name (systemd.unit(5), "String escaping"): every byte that is
 *  not an ASCII letter or digit, ":", "_" or "." becomes `\xNN`, and so does a leading ".". Unlike systemd-escape
 *  without --path, "/" is escaped too rather than turned into "-": a rig name never adds a nesting level or reaches
 *  another rig's slice. OpenRig sets no property on the slice; weights stay in the user manager's configuration. */
export function rigSeatSlice(rig: string): RigSeatSlice {
  if (!rig) return { kind: "unusable", reason: "the rig has no name" };
  const bytes = Buffer.from(rig, "utf8");
  let escaped = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    const ch = String.fromCharCode(byte);
    const plain = /[A-Za-z0-9:_.]/.test(ch) && byte < 0x80 && !(i === 0 && ch === ".");
    escaped += plain ? ch : `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  const name = `openrigseats-${escaped}.slice`;
  if (name.length > UNIT_NAME_MAX) {
    return { kind: "unusable", reason: `the rig's slice name would be ${name.length} characters; systemd allows ${UNIT_NAME_MAX}` };
  }
  return { kind: "slice", name };
}
