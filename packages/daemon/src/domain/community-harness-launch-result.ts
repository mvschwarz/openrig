// A community harness whose preset sets `launch_result: true` has a launcher that reports the harness's own conversation
// id for each launch. OpenRig names one file per launch attempt (OPENRIG_LAUNCH_RESULT, with OPENRIG_LAUNCH_ATTEMPT) and
// the launcher writes one JSON record there:
//   { "format": 1, "attempt": "<OPENRIG_LAUNCH_ATTEMPT>", "harness": "<preset name>", "nativeRef": "<id>", "producer": "<launcher>" }
// OpenRig reads only that attempt's record, and only from its own folder. A record that's missing, malformed, from another
// attempt or behind a link leaves the seat's identity unavailable; it never means the conversation is gone. A reported id
// is what the launcher says, not proof the harness used it.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDefaultOpenRigPath } from "../openrig-compat.js";

export const LAUNCH_RESULT_FORMAT = 1;
const MAX_REF = 512;
/** A record is a few hundred bytes; anything larger isn't one (a launcher writing its log there, say) and isn't read. */
const MAX_RECORD_BYTES = 64 * 1024;

export interface LaunchAttempt { attempt: string; dir: string; file: string }
export type LaunchResultRead = { ok: true; nativeRef: string; producer: string } | { ok: false; reason: string };

export function launchResultRoot(): string {
  return getDefaultOpenRigPath(path.join("state", "launch-results"));
}

/** A new attempt for this seat's session: its own file name, in a folder OpenRig owns. */
export function newLaunchAttempt(session: string, root: string = launchResultRoot()): LaunchAttempt {
  const attempt = randomUUID();
  const dir = path.join(root, session.replace(/[^A-Za-z0-9@._-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { attempt, dir, file: path.join(dir, `${attempt}.json`) };
}

/** This attempt's record, or why there isn't a usable one. */
export function readLaunchResult(attempt: LaunchAttempt, harness: string, root: string = launchResultRoot()): LaunchResultRead {
  const unusable = (why: string): LaunchResultRead => ({ ok: false, reason: `${attempt.file} ${why}` });
  let stat: fs.Stats;
  try { stat = fs.lstatSync(attempt.file); } catch { return unusable("wasn't written"); }
  if (!stat.isFile()) return unusable("isn't a plain file");
  if (stat.size > MAX_RECORD_BYTES) return unusable(`is too large (${stat.size} bytes; a record is at most ${MAX_RECORD_BYTES})`);
  try {
    // The folder and the file must be exactly where OpenRig named them: no link on the way.
    const anchor = fs.realpathSync(root);
    if (fs.realpathSync(attempt.dir) !== path.join(anchor, path.basename(attempt.dir))
      || fs.realpathSync(attempt.file) !== path.join(anchor, path.basename(attempt.dir), path.basename(attempt.file))) {
      return unusable("isn't inside OpenRig's launch-result folder (a link on the way)");
    }
  } catch { return unusable("couldn't be checked"); }
  let doc: unknown;
  try { doc = JSON.parse(fs.readFileSync(attempt.file, "utf8")); } catch { return unusable("isn't JSON"); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return unusable("isn't a JSON object");
  const record = doc as Record<string, unknown>;
  if (record.format !== LAUNCH_RESULT_FORMAT) return unusable(`declares format ${JSON.stringify(record.format ?? null)}; this OpenRig reads format ${LAUNCH_RESULT_FORMAT}`);
  if (record.attempt !== attempt.attempt) return unusable("belongs to another launch attempt");
  if (record.harness !== harness) return unusable(`names harness ${JSON.stringify(record.harness ?? null)}, not "${harness}"`);
  const ref = record.nativeRef;
  if (typeof ref !== "string" || !ref || ref.length > MAX_REF || /[\s\x00-\x1f\x7f]/.test(ref)) {
    return unusable(`has no usable nativeRef (a non-empty string of at most ${MAX_REF} characters, without spaces or control characters)`);
  }
  if (typeof record.producer !== "string" || !record.producer.trim()) return unusable("doesn't name its producer");
  return { ok: true, nativeRef: ref, producer: record.producer.trim() };
}

/** Wait for this attempt's record while it hasn't been written yet; any other answer returns at once. */
export async function waitForLaunchResult(attempt: LaunchAttempt, harness: string,
  opts: { timeoutMs?: number; intervalMs?: number; root?: string; sleep?: (ms: number) => Promise<void> } = {}): Promise<LaunchResultRead> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let read = readLaunchResult(attempt, harness, opts.root);
  for (let waited = 0; !read.ok && read.reason.endsWith("wasn't written") && waited < timeoutMs; waited += intervalMs) {
    await sleep(intervalMs);
    read = readLaunchResult(attempt, harness, opts.root);
  }
  return read;
}
