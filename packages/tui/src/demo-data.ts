// Demo fixture (clearly labeled): the shape the §4.A reads hydrate, with stub
// values for tests + `openrig-tui --demo` manual runs. Never used unless
// --demo is passed; the real path is the daemon reads (Phase 2 binding).
import type { FleetSnapshot } from "./types.js";

export function demoSnapshot(): FleetSnapshot {
  return {
    hosts: [
      {
        name: "vm-host",
        reachable: true,
        rigs: [
          {
            name: "openrig-build",
            pods: [
              {
                name: "dev50",
                agents: [
                  { name: "dev50.driver", runtime: "claude-code", spec: "driver-agent", context: 62, tokens: "118k", status: "active", live: true, canRun: false, session: "dev50-driver@openrig-build", attach: "tmux attach -t dev50-driver@openrig-build" },
                  { name: "dev50.guard", runtime: "codex", spec: "guard-agent", context: 31, tokens: "54k", status: "idle", live: true, canRun: false, session: "dev50-guard@openrig-build" },
                  { name: "dev50.qa", runtime: "codex", spec: "qa-agent", context: null, tokens: null, status: "unknown", live: false, canRun: true, session: "dev50-qa@openrig-build" },
                ],
              },
              {
                name: "orch",
                agents: [
                  { name: "orch.lead", runtime: "codex", spec: "lead-agent", context: 88, tokens: "203k", status: "needs-attention", live: true, canRun: false },
                ],
              },
            ],
          },
        ],
      },
      { name: "mm2-host", reachable: false, rigs: [] },
    ],
    specs: [
      { name: "openrig-build-rig", kind: "rig", agentRefs: ["driver-agent", "guard-agent", "qa-agent", "lead-agent"] },
      { name: "driver-agent", kind: "agent", runtime: "claude-code", usedByRigs: ["openrig-build-rig"] },
      { name: "guard-agent", kind: "agent", runtime: "codex", usedByRigs: ["openrig-build-rig"] },
      { name: "qa-agent", kind: "agent", runtime: "codex", usedByRigs: ["openrig-build-rig"] },
      { name: "lead-agent", kind: "agent", runtime: "codex", usedByRigs: ["openrig-build-rig"] },
    ],
    needs: [
      // shaped like served composeNeedsYou derived items: kind + summary/evidence verbatim
      { source: "derived", kind: "stuck", target: "dev50-guard@openrig-build", detail: "dev50.guard looks stuck — idle 42m >= 30m default · holds 1" },
    ],
    humanQueueProbed: true,
    // PULSE ▲ NEEDS YOU source — shaped like the shipped attention read (the
    // daemon already returns exactly the human-facing set).
    attention: [
      { qitemId: "q1", state: "in-progress", destinationSession: "human-yeah@kernel", blockedOn: null, handedOffTo: null, tier: "human-gate", tags: null, summary: "0.5.0 cut packet ready · waiting on you", body: "", claimedAt: "2026-08-05T09:38:00.000Z", tsUpdated: "2026-08-05T09:38:00.000Z" },
      { qitemId: "q2", state: "pending", destinationSession: "human-yeah@kernel", blockedOn: null, handedOffTo: null, tier: "human-gate", tags: null, summary: "slice-20 routing pixels · waiting on you", body: "", claimedAt: "2026-08-05T07:00:00.000Z", tsUpdated: "2026-08-05T07:00:00.000Z" },
    ],
    // PULSE ⧗ BLOCKED source — shaped like the shipped state=blocked read (ALL
    // blocked qitems). b1 is a REALISTIC agent-block: blockedOn is a qitem POINTER
    // and blockerSession carries the resolved owner (the blocking AGENT — hydrate
    // resolves this live via GET /:qitemId). The render excludes the human-blocked
    // one (b2, a SESSION in blockedOn) — it is already surfaced under NEEDS YOU.
    blocked: [
      { qitemId: "b1", state: "blocked", destinationSession: "dev50-driver@openrig-build", blockedOn: "qitem-20260805-review", blockerSession: "review-r1@openrig-build", handedOffTo: null, tier: null, tags: null, summary: "terminal verdict for 51209941", body: "", claimedAt: "2026-08-05T09:00:00.000Z", tsUpdated: "2026-08-05T09:00:00.000Z" },
      { qitemId: "b2", state: "blocked", destinationSession: "dev50-qa@openrig-build", blockedOn: "human-yeah@kernel", blockerSession: null, handedOffTo: null, tier: null, tags: null, summary: "human sign-off pending", body: "", claimedAt: "2026-08-05T08:00:00.000Z", tsUpdated: "2026-08-05T08:00:00.000Z" },
    ],
    // PULSE ◌ PARKED WITH BATON source — shaped like the shipped state=in-progress
    // read. p1 is a REALISTIC parked baton (owner dev50-guard is IDLE — see
    // seatActivity — and no handoff). p2 is a realistic EXCLUSION control: owner
    // dev50-driver is ACTIVE, so it is NOT parked (working, not stranded).
    inProgress: [
      { qitemId: "qitem-20260806-8f3a1b2c", state: "in-progress", destinationSession: "dev50-guard@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "slice 51-06 D2 atom", body: "", claimedAt: "2026-08-06T10:50:00.000Z", tsUpdated: "2026-08-06T11:13:00.000Z" },
      { qitemId: "qitem-20260806-drv0aa11", state: "in-progress", destinationSession: "dev50-driver@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "pulse-view incr build", body: "", claimedAt: "2026-08-06T11:40:00.000Z", tsUpdated: "2026-08-06T11:58:00.000Z" },
    ],
    // Per-seat ps/activity — the PARKED join's right side (terminalActive idle
    // boolean + raw lastActivityAt). driver ACTIVE, guard IDLE (47m before the
    // 12:00 demo clock), qa NO SIGNAL (detached → null, honest-unknown ≠ idle).
    seatActivity: [
      { session: "dev50-driver@openrig-build", terminalActive: true, lastActivityAt: "2026-08-06T11:58:30.000Z" },
      { session: "dev50-guard@openrig-build", terminalActive: false, lastActivityAt: "2026-08-06T11:13:00.000Z" },
      { session: "dev50-qa@openrig-build", terminalActive: null, lastActivityAt: null },
    ],
    // host-down is composed BESIDE the items (never projected into the item shape)
    hostsDown: [{ hostId: "mm2-host", status: "unreachable", error: "read timed out" }],
    stream: [
      { tsEmitted: "2026-08-02T10:00:00.000Z", sourceSession: "dev50-guard@v-openrig-build", body: "gate cleared: slice-11 spike verdict PASS" },
      { tsEmitted: "2026-08-02T10:05:00.000Z", sourceSession: "orch-lead@v-openrig-build", body: "provider re-auth completed on mm2" },
    ],
    readErrors: [],
  };
}
