import fs from "node:fs";
import path from "node:path";
import { compactionPacketRoot } from "./managed-restore-read-access.js";
import { RESTART_RECOVERY_WINDOW_MS_DEFAULT } from "./claude-compaction-enforcer.js";

/** A packet folder as restore-from-jsonl.mjs names it, `<session id>-<ISO time with : and . as ->`, and its staging folder. */
const PACKET_NAME = /^.+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const STAGING_NAME = /^\.partial-.+$/;
/** The folder beside a seat's restore maps where a seat launched before packets moved into the OpenRig home gets them. */
const PROJECT_PACKETS = path.join(".openrig", "compaction", "packets");

export interface CompactionPacketSweep {
  /** The packet folders removed, absolute. */
  removed: string[];
  /** The packet folders looked at and kept. */
  kept: number;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function list(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** A path as it really is, so a marker and a listing that spell one folder differently (a symlinked home) still match. */
function real(value: string): string {
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * Removes the restore packets no restore can still need, from what the OpenRig home records. A packet folder is kept when:
 * - a seat's restore marker names it, pending or delivered, or the marker an earlier compaction moved aside (the packet a
 *   restore falls back to when the current build fails);
 * - a seat's current packet build names it. While that build is still running, nothing of its session is touched, and
 *   no staging folder anywhere;
 * - it is younger than the daemon's restart recovery window, the age past which a restarted daemon no longer resumes a
 *   compaction's restore. That covers a packet written before its marker, and one an agent rebuilt by hand.
 * It looks in the OpenRig home's packet folder and in each launch project's packet folder (beside its restore maps) that a marker or a
 * build has named, and touches only folders with a packet's name.
 */
export function sweepCompactionPackets(opts: {
  openrigHome: string;
  now?: number;
  windowMs?: number;
  isAlive?: (pid: number) => boolean;
}): CompactionPacketSweep {
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? RESTART_RECOVERY_WINDOW_MS_DEFAULT;
  const isAlive = opts.isAlive ?? alive;
  const pending = path.join(opts.openrigHome, "compaction", "restore-pending");
  const keep = new Set<string>();
  const roots = new Set<string>([real(compactionPacketRoot(opts.openrigHome))]);
  const named = (outputDir: unknown): void => {
    if (typeof outputDir !== "string" || !path.isAbsolute(outputDir)) return;
    const dir = path.resolve(outputDir);
    keep.add(real(dir));
    if (path.dirname(dir).endsWith(`${path.sep}${PROJECT_PACKETS}`)) roots.add(real(path.dirname(dir)));
  };
  const runningSessions = new Set<string>();
  let runningUnknown = false;
  for (const name of list(pending)) {
    if (!name.endsWith(".json")) continue;
    const record = readJson(path.join(pending, name));
    if (!record) continue;
    if (!name.endsWith(".expected.json")) { named(record.outputDir); continue; }
    // A sentinel: the seat's current build.
    const job = record.packetJob as { jobId?: unknown; pid?: unknown; resultPath?: unknown } | undefined;
    if (!job || typeof job.jobId !== "string" || typeof job.resultPath !== "string") continue;
    const result = readJson(job.resultPath);
    if (result && result.jobId === job.jobId) { named(result.outputDir); continue; }
    // No result yet: running, or its pid isn't recorded yet. Only a finisher known to be gone isn't.
    if (Number.isInteger(job.pid) && !isAlive(job.pid as number)) continue;
    if (typeof record.sessionId === "string" && record.sessionId) runningSessions.add(record.sessionId);
    else runningUnknown = true;
  }
  // Earlier builds' results name the launch-project folders too, so one is still swept after its seat moves on.
  const jobs = path.join(opts.openrigHome, "compaction", "packet-jobs");
  for (const name of list(jobs)) {
    if (!name.endsWith(".result.json")) continue;
    const outputDir = readJson(path.join(jobs, name))?.outputDir;
    if (typeof outputDir !== "string" || !path.isAbsolute(outputDir)) continue;
    const root = path.dirname(path.resolve(outputDir));
    if (root.endsWith(`${path.sep}${PROJECT_PACKETS}`)) roots.add(real(root));
  }
  const building = runningUnknown || runningSessions.size > 0;
  const removed: string[] = [];
  let kept = 0;
  for (const root of roots) {
    for (const name of list(root)) {
      const staging = STAGING_NAME.test(name);
      if (!staging && !PACKET_NAME.test(name)) continue;
      const dir = path.join(root, name);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const needed = keep.has(real(dir)) || now - stat.mtimeMs < windowMs
        || (staging ? building : runningUnknown || [...runningSessions].some(session => name.startsWith(`${session}-`)));
      if (needed) { kept++; continue; }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch { kept++; }
    }
  }
  return { removed, kept };
}
