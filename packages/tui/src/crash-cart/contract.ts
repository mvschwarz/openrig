// Crash-cart C3 — the TUI-local contract types for the `rig crash-cart --json` emit. The verb is the
// SSOT (it runs the detector + the C2 read and prints ONE JSON); these mirror that JSON so the TUI
// parses + renders WITHOUT a dependency on @openrig/daemon (the light-TUI fence). The daemon-side
// verb owns the matching shapes; this file is the documented parse target the TUI reads.

export type DaemonState = "up" | "down" | "unverified";

/** Verbatim evidence for the UNVERIFIED screen (cannot-confirm-down). */
export interface DaemonUnverifiedEvidence {
  pidState: string;
  probeResult: string;
  failedSignal: string;
}
