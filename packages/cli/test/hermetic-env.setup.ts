// D12 base-health: the cli test suite MUST NOT inherit the seat's live-daemon
// connection env. getDaemonStatus + DaemonClient intentionally honor
// OPENRIG_URL / OPENRIG_PORT / OPENRIG_HOST (and the RIGGED_* legacy aliases) as
// a real operator override — CORRECT in production. But when the whole-suite fold
// gate runs INSIDE an OpenRig seat (which exports those), that ambient env
// bypasses each test's injected mock daemon deps, so daemon-resolving assertions
// hit the live daemon instead of the mock (up.test.ts: 29 fails ambient vs 1
// hermetic). This setup file (imported before every test module) scrubs ONLY the
// connection-redirect vars so tests are hermetic; production behavior is untouched
// (a real caller that sets OPENRIG_URL still targets it). Tests that need a
// specific port set + restore it themselves.
// Scrub set is the desk-authoritative six connection-redirect vars.
for (const key of ["OPENRIG_URL", "OPENRIG_PORT", "RIGGED_URL", "RIGGED_PORT", "OPENRIG_HOST_SELECTED", "OPENRIG_HOST"]) {
  delete process.env[key];
}
