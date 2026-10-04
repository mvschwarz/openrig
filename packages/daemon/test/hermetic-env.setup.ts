// Runs before every daemon test file (vitest setupFiles).
//
// Many daemon suites boot createDaemon, whose runtime setup manages OpenRig's entries in the Cursor
// home's hooks.json. Point the Cursor home at a fresh temp dir so no daemon test ever reads or
// writes the operator's real ~/.cursor. The hooks setting stays at its default, so the startup path
// still runs, against the temp dir. The hooks tests themselves drive the adapter against an
// in-memory fs and are unaffected.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OPENRIG_CURSOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-test-cursor-home-"));
