// D12 base-health + WRITE-leak containment (broadcast-leak atom).
//
// The cli test suite MUST NOT inherit the seat's live-daemon connection. Two holes:
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

// (1) Scrub the connection-redirect vars (desk-authoritative set).
for (const key of ["OPENRIG_URL", "OPENRIG_PORT", "RIGGED_URL", "RIGGED_PORT", "OPENRIG_HOST_SELECTED", "OPENRIG_HOST", "OPENRIG_BIND_HOST"]) {
  delete process.env[key];
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
const fixtureHome =
  existingHome && fs.existsSync(path.join(existingHome, ".openrig-fixture"))
    ? existingHome
    : (() => {
        const h = fs.mkdtempSync(path.join(os.tmpdir(), ".openrig-cli-fixture-home-"));
        fs.writeFileSync(path.join(h, ".openrig-fixture"), "");
        return h;
      })();
process.env["OPENRIG_HOME"] = fixtureHome;
delete process.env["RIGGED_HOME"];

// (3) ASSERT — capture the resolved home + fail loud if it is not fixture-scoped.
const { OPENRIG_HOME } = await import("../src/openrig-compat.js");
const { assertFixtureScopedHome } = await import("./live-daemon-guard.js");
assertFixtureScopedHome(OPENRIG_HOME);

// (4) P37 REQUEST-LAYER GUARD — the universal outbound-request chokepoint. The two
// guards above close the DISCOVERY paths (connection env, state-file home); this closes
// the REQUEST layer, where a hardcoded :7433 literal, a mocked URL getter with an
// un-mocked client, or a production default constant still issues a real request that
// no env-scrub or fixture-home can catch. Fail-closed on any unregistered target; an
// in-process fixture registers its origin (allowFetchTarget) when it binds.
const { installFetchGuard } = await import("./fetch-guard.js");
installFetchGuard();
