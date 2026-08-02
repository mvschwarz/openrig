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
      { kind: "stuck", target: "dev50-guard@openrig-build", detail: "dev50.guard looks stuck — idle 42m >= 30m default · holds 1" },
    ],
    humanQueueProbed: true,
    humanQueue: [],
    // host-down is composed BESIDE the items (never projected into the item shape)
    hostsDown: [{ hostId: "mm2-host", status: "unreachable", error: "read timed out" }],
    stream: [
      { tsEmitted: "2026-08-02T10:00:00.000Z", sourceSession: "dev50-guard@v-openrig-build", body: "gate cleared: slice-11 spike verdict PASS" },
      { tsEmitted: "2026-08-02T10:05:00.000Z", sourceSession: "orch-lead@v-openrig-build", body: "provider re-auth completed on mm2" },
    ],
    readErrors: [],
  };
}
