// D12 base-health + WRITE-leak containment (broadcast-leak atom).
//
// The Node test suites MUST NOT inherit the seat's live-daemon connection. Two holes:
//
// 1. Connection-redirect env (OPENRIG_URL / OPENRIG_PORT / OPENRIG_HOST + RIGGED_*
//    aliases) — honored as a real operator override in production, but ambient inside
//    a seat it bypasses each test's injected mock daemon (up.test.ts: 29 fails ambient
//    vs 1 hermetic). Scrubbed below. Production behavior is untouched.
//
// 2. The DEFAULT STATE_FILE discovery — `OPENRIG_HOME/daemon.json` (daemon-lifecycle
//    `OPENRIG_DIR = OPENRIG_HOME`). Scrubbing the env is NOT enough: with URL/PORT
//    unset, the CLI falls back to the live daemon's state file. This is exactly how
//    `broadcast.test.ts` emitted REAL 'System maintenance' broadcasts to 14 seats.
//    The READ direction (results pollution) was known; the WRITE direction (emitting
//    into the live topology) is strictly worse.
//
// FORCE + ASSERT (unwritable-by-omission — the guarantee lives where it cannot be
// skipped, so a new test file inherits safety from the setup that runs first, not
// from a runner or a per-file convention that 145/164 files already omit):
//   FORCE  — establish a fixture-scoped OPENRIG_HOME (a fresh temp dir carrying the
//            `.openrig-fixture` marker) BEFORE any daemon-resolving module loads and
//            captures the eager `OPENRIG_HOME` const, so default discovery finds no
//            live daemon.
//   ASSERT — `assertFixtureScopedHome` throws LOUD if the home is NOT fixture-scoped
//            (mkdtemp failure, or OPENRIG_HOME captured before this ran via an
//            import-order regression). Forcing alone silently fixes and proves
//            nothing; the assert makes it evidence. Its known-negative lives in
//            live-daemon-guard.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realRuntimesRequested, writeRuntimeStubs } from "./stub-runtimes.js";

export function fixtureUserHomeEnv(userHome: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return { HOME: userHome, ...(platform === "win32" ? { USERPROFILE: userHome } : {}) };
}

// Scrub inherited instance selectors before product modules capture their defaults.
// Tests can still set explicit overrides after setup; test/provider opt-in flags
// are not instance selectors and remain untouched.
for (const key of [
  "URL", "PORT", "HOST", "BIND_HOST", "HOST_SELECTED", "DB",
  "TRANSCRIPTS_PATH", "WORKSPACE_ROOT", "WORKSPACE_SLICES_ROOT",
  "WORKSPACE_STEERING_PATH", "WORKSPACE_SPECS_ROOT", "WORKSPACE_PROJECTS_ROOT",
  "WORKSPACE_CATALOG_PATH", "TOPOLOGY_ROOT", "CONTEXT_ROOT", "CONTEXT_PACKS_ROOT",
  "SKILLS_ROOT", "SHARED_DOCS_ROOT", "FILES_ALLOWLIST", "PROGRESS_SCAN_ROOTS",
  "SESSION_NAME", "NODE_ID", "RIG_ID", "AUTH_BEARER_TOKEN", "TERMINAL_BEARER_TOKEN",
  // Slice 15: a seat with compact output on must not change what the suite prints.
  "OUTPUT_COMPACT",
  // Slice 01: a seat with usage windows on must not change what the suite reads.
  "PROVIDER_USAGE_WINDOWS",
  // A seat whose setup recorded a provider choice must not change which kernel variant the suite picks.
  "PROVIDER_SELECTED",
  // A seat with input-box verification on must not change what the transport suites verify.
  "TRANSPORT_VERIFY_INPUT_BOX",
  "TRANSPORT_LOCAL_USER_GUARD",
]) {
  delete process.env[`OPENRIG_${key}`];
  delete process.env[`RIGGED_${key}`];
}

// (2) FORCE a fixture-scoped home — BEFORE importing openrig-compat (whose
// OPENRIG_HOME const is eager). Node builtins above do not load it; the dynamic
// imports below run only AFTER this assignment, so the const captures the fixture.
// ONE stable fixture home per worker. setupFiles runs per test FILE, but
// openrig-compat's OPENRIG_HOME const is captured ONCE per worker — a fresh per-file
// home would diverge from that captured const (env says home N, the const holds home
// 1), which flakes any test reading one vs the other under suite ordering. So reuse a
// fixture home already established in this worker. Named as a realistic `.openrig`-style
// home (still fixture-scoped via the marker) so path-shape assertions hold against it.
const existingHome = process.env["OPENRIG_HOME"];
let createdHome: string | undefined;
let createdTmp: string | undefined;
const fixtureHome =
  existingHome && fs.existsSync(path.join(existingHome, ".openrig-fixture"))
    ? existingHome
    : (() => {
        const h = fs.mkdtempSync(path.join(os.tmpdir(), ".openrig-test-fixture-home-"));
        fs.writeFileSync(path.join(h, ".openrig-fixture"), "");
        createdHome = h;
        // The worker's own TMPDIR, so every os.tmpdir() mkdtemp a test makes lands in a directory removed with
        // the homes. The name is short on purpose: it adds 9 characters ("o-" + 6 + "/") to each such path,
        // and a Unix socket path is capped (104 bytes on macOS, where TMPDIR is already ~49 long).
        // A package whose tests are tied to the length of the temp path (the tui's Unix socket tests) opts out with
        // test.env OPENRIG_TEST_KEEP_TMPDIR=1 in its vitest config and keeps the TMPDIR it was given.
        if (process.env["OPENRIG_TEST_KEEP_TMPDIR"] !== "1") {
          createdTmp = fs.mkdtempSync(path.join(os.tmpdir(), "o-"));
          process.env["TMPDIR"] = createdTmp;
        }
        return h;
      })();
// Remove the homes (and the worker TMPDIR) this process created when it ends: nothing else ever does, and a full run leaves two per
// worker (a run on 2026-10-14 left ~65,000, 6.2 GB, in the RAM-backed /tmp). A hook here, not a globalSetup
// teardown: the homes are made inside the workers, which a teardown in the runner cannot name. Vitest ends a
// finished worker with SIGTERM, which skips "exit" hooks, so the signals clean up too and then take their
// default effect again. Only the creating file registers (later files in the worker reuse the home), and only
// a home this process made, still carrying the marker: a reused home from the environment, say a parent
// run's, is never ours to remove.
if (createdHome) {
  const home = createdHome;
  const tmp = createdTmp;
  const remove = () => {
    if (!fs.existsSync(path.join(home, ".openrig-fixture"))) return;
    // A failed removal (busy, permissions) must not turn a signal or a clean exit into a crash.
    for (const dir of [home, `${home}-user-home`, ...(tmp ? [tmp] : [])]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leave it: the worker is ending */ }
    }
  };
  process.once("exit", remove);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(signal, () => { remove(); process.kill(process.pid, signal); });
  }
}
process.env["OPENRIG_HOME"] = fixtureHome;
delete process.env["RIGGED_HOME"];
// Compaction packets default to the shared /tmp/claude-compaction-restore that real seats use. Give every test a
// folder under the fixture home instead (removed with it), so a test that forgets its own root can't write there
// and a seat's value can't reach the suite. Tests that set their own root still do.
process.env["OPENRIG_COMPACTION_OUT_ROOT"] = path.join(fixtureHome, "compaction-packets");
// Legacy ~/.rigged discovery and ordinary home-based config must also stay local
// to this fixture. Merely changing HOME would not override OPENRIG_HOME or DB.
// Keep ordinary user files outside the state root, as in a real installation.
// Otherwise file-transfer correctly rejects every ~/ path as OpenRig state.
// Vitest sets testPath before setupFiles. Plain Node setup consumers have no native-runtime exception.
const testPath = process.env["VITEST"] ? (await import("vitest")).expect.getState().testPath : undefined;
const realCodexTest = realRuntimesRequested(process.env, testPath);
// These files exercise Codex only; an inherited Claude override never belongs to their fixture.
delete process.env["CLAUDE_CONFIG_DIR"];
if (!realCodexTest) {
  const userHome = `${fixtureHome}-user-home`;
  fs.mkdirSync(userHome, { recursive: true });
  Object.assign(process.env, fixtureUserHomeEnv(userHome));
  delete process.env["CODEX_HOME"];
  for (const [key, suffix] of Object.entries({
    XDG_CONFIG_HOME: ".config", XDG_STATE_HOME: ".local/state",
    XDG_DATA_HOME: ".local/share", XDG_CACHE_HOME: ".cache",
  })) process.env[key] = path.join(userHome, suffix);

  if (os.homedir() !== userHome || process.env["CODEX_HOME"] !== undefined
    || process.env["CLAUDE_CONFIG_DIR"] !== undefined) {
    throw new Error("test provider homes must stay inside the fixture");
  }

  // codex and claude resolve to stubs that answer at once, so no test runs the host's real
  // binaries (a codex wrapper that hangs under a fixture HOME leaves its probes running).
  // The stubs live beside the fixture home and go away with it. One PATH entry per worker.
  const stubDir = writeRuntimeStubs(userHome);
  const pathEntries = (process.env["PATH"] ?? "").split(path.delimiter);
  if (pathEntries[0] !== stubDir) {
    process.env["PATH"] = [stubDir, ...pathEntries.filter((entry) => entry !== stubDir)].join(path.delimiter);
  }
}

// (3) ASSERT — capture the resolved home + fail loud if it is not fixture-scoped.
const { OPENRIG_HOME } = await import("../packages/cli/src/openrig-compat.js");
const { assertFixtureScopedHome } = await import("../packages/cli/test/live-daemon-guard.js");
assertFixtureScopedHome(OPENRIG_HOME);

// (4) P37 REQUEST-LAYER GUARD — the universal outbound-request chokepoint. The two
// guards above close the DISCOVERY paths (connection env, state-file home); this closes
// the REQUEST layer, where a hardcoded :7433 literal, a mocked URL getter with an
// un-mocked client, or a production default constant still issues a real request that
// no env-scrub or fixture-home can catch. Fail-closed on any unregistered target; an
// in-process fixture registers its origin (allowFetchTarget) when it binds.
const { installFetchGuard } = await import("../packages/cli/test/fetch-guard.js");
installFetchGuard();
