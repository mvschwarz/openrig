import fs from "node:fs";
import nodePath from "node:path";

// Pi's `--session <file>` takes its runtime folder from the session header's `cwd`, not from the process cwd, and
// offers no flag to override it (its `--fork` does, but mints a new session file and id, which an exact resume refuses).
// After `rig seat set-cwd` moves a seat, a resume would otherwise run Pi's tools and system prompt in the OLD folder
// while the runner, guidance and checkpoints use the new one, or exit when the old folder is gone. Before the runner
// spawns Pi on its own session file, it points the header at the seat's folder: only line 1 changes, so the session
// file, its id and every entry stay as they were.

export type PiSessionCwdReason =
  | "runtime_unverified"
  | "outside_seat_sessions"
  | "seat_folder_missing"
  | "write_failed";

export type PiSessionCwdOutcome =
  | { kind: "unchanged" }
  | { kind: "moved"; from: string; to: string }
  | { kind: "mismatch"; from: string; to: string; reason: PiSessionCwdReason };

function realpathOrNull(path: string): string | null {
  try { return fs.realpathSync(path); } catch { return null; }
}

function isInside(child: string, parent: string): boolean {
  const rel = nodePath.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !nodePath.isAbsolute(rel);
}

/** Align a resumed session file's recorded folder with the seat's folder. Never throws: a file it cannot read or
 *  parse as a session header is left to the runtime, as before. `rewrite` is false for runtimes whose session format
 *  is unverified; a differing folder is then reported, not changed. */
export function alignPiSessionCwd(opts: { sessionFile: string; cwd: string; sessionsDir: string; rewrite: boolean }): PiSessionCwdOutcome {
  let content: Buffer;
  try {
    const stat = fs.lstatSync(opts.sessionFile, { throwIfNoEntry: false });
    if (!stat?.isFile()) return { kind: "unchanged" };
    content = fs.readFileSync(opts.sessionFile);
  } catch {
    return { kind: "unchanged" };
  }
  const newline = content.indexOf(0x0a);
  const headerText = content.subarray(0, newline < 0 ? content.length : newline).toString("utf8");
  let header: Record<string, unknown>;
  try {
    const parsed = JSON.parse(headerText) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unchanged" };
    header = parsed as Record<string, unknown>;
  } catch {
    return { kind: "unchanged" };
  }
  const from = header["cwd"];
  if (header["type"] !== "session" || typeof from !== "string" || from === opts.cwd) return { kind: "unchanged" };
  const seatFolder = realpathOrNull(opts.cwd);
  if (seatFolder !== null && realpathOrNull(from) === seatFolder) return { kind: "unchanged" };
  const mismatch = (reason: PiSessionCwdReason): PiSessionCwdOutcome => ({ kind: "mismatch", from, to: opts.cwd, reason });
  if (!opts.rewrite) return mismatch("runtime_unverified");
  if (seatFolder === null || !fs.statSync(seatFolder).isDirectory()) return mismatch("seat_folder_missing");
  const file = realpathOrNull(opts.sessionFile);
  const sessions = realpathOrNull(opts.sessionsDir);
  if (file === null || sessions === null || !isInside(file, sessions)) return mismatch("outside_seat_sessions");

  // The header line is the only part re-serialized; the rest of the file is copied byte for byte. A temp file in the
  // same folder (not named *.jsonl, so no session listing picks it up) is renamed over the original.
  const temp = nodePath.join(nodePath.dirname(file), `.${nodePath.basename(file)}.openrig-cwd-${process.pid}.tmp`);
  try {
    const mode = fs.statSync(file).mode & 0o7777;
    const rest = newline < 0 ? Buffer.from("\n") : content.subarray(newline);
    fs.writeFileSync(temp, Buffer.concat([Buffer.from(JSON.stringify({ ...header, cwd: seatFolder }), "utf8"), rest]), { mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* the original is untouched */ }
    return mismatch("write_failed");
  }
  return { kind: "moved", from, to: seatFolder };
}

/** The runner's pane line for an outcome, or null when there is nothing to say. Never an ERROR marker: the launch
 *  still goes ahead. */
export function piSessionCwdNotice(outcome: PiSessionCwdOutcome, runtime: string): string | null {
  if (outcome.kind === "unchanged") return null;
  if (outcome.kind === "moved") {
    return `[${runtime}-runner] resume: the conversation was recorded in ${outcome.from}; it continues in the seat's folder ${outcome.to}`;
  }
  const why = outcome.reason === "runtime_unverified" ? `${runtime} is not verified to work from an updated session header`
    : outcome.reason === "outside_seat_sessions" ? "the session file is not in this seat's sessions folder"
    : outcome.reason === "seat_folder_missing" ? "the seat's folder does not exist"
    : "the session file could not be updated";
  return `[${runtime}-runner] WARNING resume: the conversation was recorded in ${outcome.from}, not the seat's folder ${outcome.to}, and ${why}; ${runtime} may read and edit files in ${outcome.from}`;
}
