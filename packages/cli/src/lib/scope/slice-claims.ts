import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA = "openrig.slice-claim/v1";
interface SliceClaim { schema: typeof SCHEMA; ref: string; state: "pending" | "verified" }

/** One persistent claim reserves the ordinal and records unfinished registration. */
export function tryClaimSliceNN(missionPath: string, nn: number, ref: string): boolean {
  const slices = path.join(missionPath, "slices");
  fs.mkdirSync(slices, { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(path.join(slices, `.nn-${String(nn).padStart(2, "0")}`), "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ schema: SCHEMA, ref, state: "pending" } satisfies SliceClaim) + "\n");
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function readClaim(missionPath: string, marker: string): SliceClaim | null {
  const ordinal = /^\.nn-(\d+)$/.exec(marker);
  if (!ordinal) return null;
  const file = path.join(missionPath, "slices", marker);
  if (!fs.lstatSync(file).isFile()) return null;
  let claim: unknown;
  try { claim = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) return null; // Legacy/partial marker reserves only a number.
    throw error;
  }
  if (!claim || typeof claim !== "object") return null;
  const value = claim as Partial<SliceClaim>;
  if (value.schema !== SCHEMA || (value.state !== "pending" && value.state !== "verified") || typeof value.ref !== "string") return null;
  const folder = /^slices\/(\d+)-[^/\\]+\/slice\.yaml$/.exec(value.ref);
  if (!folder || Number(folder[1]) !== Number(ordinal[1])) return null;
  return value as SliceClaim;
}

/** Older unlisted folders and verified registrations are never adopted. */
export function pendingCompletedSliceRefs(missionPath: string): string[] {
  const slices = path.join(missionPath, "slices");
  if (!fs.existsSync(slices)) return [];
  const refs: string[] = [];
  for (const marker of fs.readdirSync(slices)) {
    const claim = readClaim(missionPath, marker);
    if (claim?.state !== "pending") continue;
    const slice = path.dirname(path.join(missionPath, claim.ref));
    if (fs.existsSync(path.join(slice, "PROOF.md")) && fs.existsSync(path.join(slice, "slice.yaml"))) refs.push(claim.ref);
  }
  return refs.sort();
}

/** Retire pending evidence after observing registration, including a repaired peer.
 * A stale manifest rename after this observation is not automatically repaired. */
export function markSliceRegistrationsVerified(missionPath: string, refs: string[]): void {
  const registered = new Set(refs.map((ref) => path.normalize(ref)));
  const slices = path.join(missionPath, "slices");
  for (const marker of fs.readdirSync(slices)) {
    const claim = readClaim(missionPath, marker);
    if (claim?.state !== "pending" || !registered.has(path.normalize(claim.ref))) continue;
    const file = path.join(slices, marker);
    const temporary = `${file}.${process.pid}-${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...claim, state: "verified" }) + "\n", { flag: "wx" });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
