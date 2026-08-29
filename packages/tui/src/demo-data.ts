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
                  { name: "orch.lead", runtime: "codex", spec: "lead-agent", context: 88, tokens: "203k", status: "needs-attention", live: true, canRun: false, session: "orch-lead@openrig-build" },
                ],
              },
            ],
          },
        ],
      },
      { name: "remote-host", reachable: false, rigs: [] },
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
    scopes: [
      {
        mission: "release-0.5.2",
        slices: [
          {
            dirName: "gateway-m1", id: "OPR.0.5.2.9", displayName: "gateway-m1", status: "spec", stage: "building",
            locks: { spec: { by: "pm-openrig@openrig-pm", at: "2026-08-06T10:00:00.000Z" }, delivery: null },
            proof: { paired: 2, total: 9 },
            intent: '"Milestone cut: the functionality we need today — Slack to the founder — on the bones we keep."',
            miniRequirements: [
              "The daemon resolves @external addresses to the gateway path via domain-class admission; an unregistered domain bounces loudly.",
              "Human specs are one file per human; the registry is a generated projection.",
            ],
            proofContract: [
              { index: 1, text: "The ack-after-delivery repair demonstrated on the SHIPPED relay path.", paired: true, drops: [{ file: "qa-relay.md", artifactType: "qa", verdict: "PASS", media: ["relay-repair-e2e.txt"] }] },
              { index: 2, text: "A registered entity cold-DMs from Slack and it queues exactly as today.", paired: false, drops: [] },
              { index: 3, text: "An unregistered domain bounces loudly with the teaching error.", paired: true, drops: [{ file: "guard-bounce.md", artifactType: "guard", verdict: "CLEAR", media: [] }] },
            ],
            narrative: "- kickoff: A1 in build\n- A2 held on arch consult",
            specShaShort: "fe92ffa9",
            prdExists: true,
          },
          {
            dirName: "crash-cart", id: "OPR.0.5.2.5", displayName: "crash-cart", status: "done", stage: "established",
            locks: { spec: { by: "pm-openrig@openrig-pm", at: "2026-08-05T10:00:00.000Z" }, delivery: { by: "pm-openrig@openrig-pm", at: "2026-08-06T20:00:00.000Z" } },
            proof: { paired: 4, total: 4 },
            intent: "The daemon-down cockpit.",
            miniRequirements: ["One keystroke restore."],
            proofContract: [
              { index: 1, text: "Restore everything works.", paired: true, drops: [{ file: "qa1.md", artifactType: "qa", verdict: "PASS", media: [] }] },
              { index: 2, text: "Daemon-only start works.", paired: true, drops: [{ file: "qa2.md", artifactType: "qa", verdict: "PASS", media: [] }] },
              { index: 3, text: "Inspect works.", paired: true, drops: [{ file: "qa3.md", artifactType: "qa", verdict: "PASS", media: [] }] },
              { index: 4, text: "Onboarding menu lives here.", paired: true, drops: [{ file: "qa4.md", artifactType: "qa", verdict: "PASS", media: [] }] },
            ],
            narrative: null,
            specShaShort: "0a1b2c3d",
            prdExists: true,
          },
        ],
      },
    ],
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
    // PULSE ◌ PARKED WITH BATON + ● NOW source — shaped like the shipped
    // state=in-progress read. The guard qitem is a REALISTIC parked baton (owner
    // IDLE — see seatActivity — no handoff). The driver/planner/r1/lead qitems are
    // owned by ACTIVE seats → they surface under NOW (running seats with work),
    // NOT parked.
    inProgress: [
      { qitemId: "qitem-20260806-8f3a1b2c", state: "in-progress", destinationSession: "dev50-guard@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "slice 51-06 D2 atom", body: "", claimedAt: "2026-08-06T10:50:00.000Z", tsUpdated: "2026-08-06T11:13:00.000Z" },
      { qitemId: "qitem-20260806-drv0aa11", state: "in-progress", destinationSession: "dev50-driver@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "pulse-view incr build", body: "", claimedAt: "2026-08-06T11:40:00.000Z", tsUpdated: "2026-08-06T11:58:00.000Z" },
      { qitemId: "qitem-20260806-pln0b220", state: "in-progress", destinationSession: "dev50-planner@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "IMPL-PLAN incr-4 drill-in", body: "", claimedAt: "2026-08-06T11:30:00.000Z", tsUpdated: "2026-08-06T11:57:00.000Z" },
      { qitemId: "qitem-20260806-r10c331", state: "in-progress", destinationSession: "review50-r1@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "review incr-3 lanes", body: "", claimedAt: "2026-08-06T11:45:00.000Z", tsUpdated: "2026-08-06T11:59:00.000Z" },
      { qitemId: "qitem-20260806-led0d442", state: "in-progress", destinationSession: "orch-lead@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "fold receipt 0.5.2", body: "", claimedAt: "2026-08-06T11:50:00.000Z", tsUpdated: "2026-08-06T11:59:30.000Z" },
    ],
    // Per-seat ps/activity — the NOW + PARKED join's right side (terminalActive
    // idle boolean + raw lastActivityAt). driver/planner/r1/lead ACTIVE → NOW;
    // guard IDLE (47m before the 12:00 demo clock) → PARKED; qa NO SIGNAL
    // (detached → null, honest-unknown ≠ idle → shown in neither lane).
    seatActivity: [
      { session: "dev50-driver@openrig-build", logicalId: "dev50.driver", terminalActive: true, lastActivityAt: "2026-08-06T11:58:30.000Z" },
      { session: "dev50-planner@openrig-build", logicalId: "dev50.planner", terminalActive: true, lastActivityAt: "2026-08-06T11:59:10.000Z" },
      { session: "review50-r1@openrig-build", logicalId: "review50.r1", terminalActive: true, lastActivityAt: "2026-08-06T11:59:20.000Z" },
      { session: "orch-lead@openrig-build", logicalId: "orch.lead", terminalActive: true, lastActivityAt: "2026-08-06T11:59:40.000Z" },
      { session: "dev50-guard@openrig-build", logicalId: "dev50.guard", terminalActive: false, lastActivityAt: "2026-08-06T11:13:00.000Z" },
      { session: "dev50-qa@openrig-build", logicalId: "dev50.qa", terminalActive: null, lastActivityAt: null },
    ],
    // PULSE ○ UP NEXT source — shaped like the shipped state=pending read
    // (unclaimed backlog, served ts_created DESC → carried verbatim). SIX items
    // exercise the display-cap overflow: the view renders the first four + a "…"
    // marker, with the header count the TRUE total (6).
    pending: [
      { qitemId: "qitem-20260806-up000001", state: "pending", destinationSession: "orch-lead@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "RM ceremony 0.5.2", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:55:00.000Z" },
      { qitemId: "qitem-20260806-up000002", state: "pending", destinationSession: "dev50-qa@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "51-02 scenario runner", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:50:00.000Z" },
      { qitemId: "qitem-20260806-up000003", state: "pending", destinationSession: "dev50-qa@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "51-03 seed scenarios", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:45:00.000Z" },
      { qitemId: "qitem-20260806-up000004", state: "pending", destinationSession: "dev50-driver@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "incr-4 drill-in + selection parity", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:40:00.000Z" },
      { qitemId: "qitem-20260806-up000005", state: "pending", destinationSession: "dev50-driver@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "incr-5 live refresh-seam", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:35:00.000Z" },
      { qitemId: "qitem-20260806-up000006", state: "pending", destinationSession: "dev50-planner@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "docs sweep sdlc-conventions", body: "", claimedAt: null, tsUpdated: "2026-08-06T11:30:00.000Z" },
    ],
    // PULSE ✓ JUST FINISHED source — shaped like the shipped state=done,handed-off
    // read (bounded recent window). Served in ts_created order; the view re-sorts
    // by tsUpdated DESC (finish time) → newest-finished first.
    recentlyFinished: [
      { qitemId: "qitem-20260806-fin00001", state: "done", destinationSession: "dev50-guard@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "slice-03 close-out", body: "", claimedAt: "2026-08-06T11:20:00.000Z", tsUpdated: "2026-08-06T11:44:00.000Z" },
      { qitemId: "qitem-20260806-fin00002", state: "handed-off", destinationSession: "dev50-driver@openrig-build", blockedOn: null, handedOffTo: "review50-r1@openrig-build", tier: null, tags: null, summary: "field fold receipt", body: "", claimedAt: "2026-08-06T10:40:00.000Z", tsUpdated: "2026-08-06T11:20:00.000Z" },
      { qitemId: "qitem-20260806-fin00003", state: "done", destinationSession: "dev50-driver@openrig-build", blockedOn: null, handedOffTo: null, tier: null, tags: null, summary: "terminal CLEAR 51209941", body: "", claimedAt: "2026-08-06T10:20:00.000Z", tsUpdated: "2026-08-06T10:58:00.000Z" },
    ],
    // When this demo snapshot "hydrated" — 2s before the 12:00 demo clock so the
    // PULSE footer renders "updated 2s ago" deterministically.
    hydratedAt: "2026-08-06T11:59:58.000Z",
    // host-down is composed BESIDE the items (never projected into the item shape)
    hostsDown: [{ hostId: "remote-host", status: "unreachable", error: "read timed out" }],
    stream: [
      { tsEmitted: "2026-08-02T10:00:00.000Z", sourceSession: "dev50-guard@v-openrig-build", body: "gate cleared: slice-11 spike verdict PASS" },
      { tsEmitted: "2026-08-02T10:05:00.000Z", sourceSession: "orch-lead@v-openrig-build", body: "provider re-auth completed on mm2" },
    ],
    readErrors: [],
  };
}
