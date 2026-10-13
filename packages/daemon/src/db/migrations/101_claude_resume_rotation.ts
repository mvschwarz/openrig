import type { Migration } from "../migrate.js";

// A Claude seat resumed with `--resume T1` whose conversation continues as T2 (#1077).
// resume_launch_token arms that launch: the token OpenRig is about to resume, recorded before the
// launch. The first current-generation SessionStart hook for the row consumes it; when that hook
// reports `source: "resume"`, T2 and the launch marker OpenRig's resume command set, resume_rotated_from
// keeps T1, the one launch identity the proof may still accept in argv, and resume_rotated_process the
// process that sent that hook (JSON pid and start time), the only one whose argv may name T1. Any
// write that changes the stored token clears both. resume_launch_process is the launch path's own
// observation of the process it started on T1 (JSON token, pid, start time), recorded right after the
// launch; a rotation counts only when its process is that one. Re-arming a launch clears it.
export const resumeRotationSchema: Migration = {
  name: "101_claude_resume_rotation.sql",
  sql: `
    ALTER TABLE sessions ADD COLUMN resume_launch_token TEXT;
    ALTER TABLE sessions ADD COLUMN resume_rotated_from TEXT;
    ALTER TABLE sessions ADD COLUMN resume_rotated_process TEXT;
    ALTER TABLE sessions ADD COLUMN resume_launch_process TEXT;
  `,
};
