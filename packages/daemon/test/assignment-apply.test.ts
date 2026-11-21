import { describe, expect, it, vi } from "vitest";
import { applyAssignment, successorKind, type ApplyDeps, type PeerRestartResult } from "../src/domain/provider/assignment-apply.js";
import type { AssignmentPlan, PlanRow } from "../src/domain/provider/assignment-plan.js";
import type { AccountRef } from "../src/domain/provider/provider-account-refs.js";
import type { ProviderSwitchResult } from "../src/domain/provider/provider-service.js";

// #3625 slice 3: applying a plan seat by seat, through the existing switch, with each result one of six kinds.

const CLAUDE: AccountRef = { provider: "claude", label: "max-2", kind: "claude_token_file", file: "/keys/max-2", codexHome: null, login: null, createdAt: "t" };
const CODEX: AccountRef = { provider: "codex", label: "team", kind: "codex_saved_login", file: null, codexHome: "/homes/a", login: "team", createdAt: "t" };

const change = (seat: string, over: Partial<PlanRow> = {}): PlanRow => ({ seat, runtime: "claude-code", current: "the default login", effect: "change",
  precheck: { safe: true, reasons: [] }, continuity: "in place", activity: "idle", ...over });

function plan(account: AccountRef, rows: PlanRow[], over: Partial<AssignmentPlan> = {}): AssignmentPlan {
  return { daemon: "host-a", rig: "fleet", provider: account.provider, account: { label: account.label, kind: account.kind, reference: "ref" },
    includeOverrides: false, rows, codexHomes: [], digest: "0123456789ab", note: "", ...over };
}

function deps(switches: Record<string, ProviderSwitchResult>, restarts: Record<string, PeerRestartResult> = {}) {
  const saved: Array<{ seat: string; kind: string; applied: unknown }> = [];
  const d = {
    switchSeat: vi.fn(async (seat: string) => switches[seat] ?? { outcome: "rebind_in_progress" as const, message: `relaunched ${seat}` }),
    restartPeer: vi.fn(async (seat: string) => restarts[seat] ?? { ok: true as const, outcome: "restarted_account_unverified", message: "restarted" }),
    activityOf: vi.fn((seat: string) => (seat.startsWith("busy") ? "running" : "idle")),
    save: vi.fn((r, applied) => saved.push({ seat: r.seat, kind: r.kind, applied })),
    now: () => "2026-11-21T07:00:00.000Z",
  } satisfies ApplyDeps;
  return { d, saved };
}

describe("applying an assignment", () => {
  it("goes seat by seat: a failure doesn't stop the others, successes stay, and nothing is retried", async () => {
    const { d, saved } = deps({
      "b@fleet": { outcome: "failed_safely", reasons: ["relaunch_no_pane"], message: "b wasn't relaunched and wasn't touched" },
      "u@fleet": { outcome: "unknown", reasons: ["relaunch_failed"], message: "didn't report a resumed conversation",
        seat: { seat: "u@fleet", account: "max-2", loginChanged: true, peers: [], restart: { outcome: "relaunch_failed", message: "m", recoveryCommand: "rig launch fleet dev.u --snapshot-id s1" } } },
    });
    const report = await applyAssignment(plan(CLAUDE, [
      change("a@fleet"), change("b@fleet"), change("u@fleet"), change("busy@fleet"),
      change("on@fleet", { effect: "unchanged" }),
      change("own@fleet", { effect: "kept_override", override: 'its own token file /keys/max-1 ("max-1")' }),
      change("bad@fleet", { precheck: { safe: false, reasons: ["credential_outranks_token"], message: "ANTHROPIC_API_KEY wins" } }),
      change("cx@fleet", { runtime: "codex", effect: "not_affected" }),
    ]), CLAUDE, d);
    expect(report.results.map((r) => [r.seat, r.kind])).toEqual([
      ["a@fleet", "switched"], ["b@fleet", "failed_before_effect"], ["u@fleet", "unknown"], ["busy@fleet", "switched"],
      ["on@fleet", "unchanged"], ["own@fleet", "unchanged"], ["bad@fleet", "failed_before_effect"]]);
    // Each seat that could change went through the switch once; the unsafe one wasn't attempted.
    expect(d.switchSeat.mock.calls.map(([s]) => s)).toEqual(["a@fleet", "b@fleet", "u@fleet", "busy@fleet"]);
    expect(report.results[2]!.recovery).toBe("rig launch fleet dev.u --snapshot-id s1");
    expect(report.results[5]!.detail).toBe('kept (seat override): its own token file /keys/max-1 ("max-1")');
    expect(report.results[6]!.detail).toBe("not attempted: its precheck was unsafe (credential_outranks_token): ANTHROPIC_API_KEY wins");
    // The activity is the seat's as it was switched, so a working seat shows it lost work in flight.
    expect(report.results[3]!.activity).toBe("running");
    // Saved as each landed; the reference goes with a switched seat only.
    expect(saved.map((s) => [s.seat, s.applied !== undefined])).toEqual([["a@fleet", true], ["b@fleet", false], ["u@fleet", false],
      ["busy@fleet", true], ["on@fleet", false], ["own@fleet", false], ["bad@fleet", false]]);
    expect(saved[0]!.applied).toEqual({ file: "/keys/max-2", fileKind: "token", codexHome: null, codexLogin: null });
  });

  it("a Codex home switches once: this rig's other seats restart on it, and another rig's are reported, not restarted", async () => {
    const { d } = deps({});
    const report = await applyAssignment(plan(CODEX, [
      change("c1@fleet", { runtime: "codex" }), change("c2@fleet", { runtime: "codex" }),
      change("on@fleet", { runtime: "codex", effect: "unchanged" }),
    ], { codexHomes: [{ home: "/homes/a", seats: [
      { seat: "c1@fleet", rig: "fleet", effect: "would restart" }, { seat: "c2@fleet", rig: "fleet", effect: "would restart" },
      { seat: "on@fleet", rig: "fleet", effect: "would restart" }, { seat: "p@other", rig: "other", effect: "not restarted; needs rig seat restart p@other" }] }] }), CODEX, d);
    expect(d.switchSeat.mock.calls.map(([s]) => s)).toEqual(["c1@fleet"]);
    expect(d.restartPeer.mock.calls.map(([s]) => s)).toEqual(["c2@fleet", "on@fleet"]);
    expect(report.results.map((r) => [r.seat, r.kind])).toEqual([["c1@fleet", "switched"], ["c2@fleet", "switched"], ["on@fleet", "switched"]]);
    expect(report.results[1]!.detail).toContain("which c1@fleet switched to \"team\"");
    expect(report.otherRigPeers).toEqual([{ seat: "p@other", rig: "other", home: "/homes/a", command: "rig seat restart p@other --keep-conversation" }]);
  });

  it.each([
    ["an unknown restart", { outcome: "unknown", reasons: ["restart_native_unknown"], message: "not confirmed",
      seat: { seat: "c1@fleet", home: "/homes/a", account: "team", loginChanged: true, peers: [] } }],
    // The home's login changed and the seat didn't restart: that's an effect, so it's unknown, not failed before effect.
    ["a login changed without a restart", { outcome: "failed_safely", reasons: ["login_changed_seat_not_restarted"], message: "/homes/a now uses team, but c1 wasn't restarted" }],
  ] as Array<[string, ProviderSwitchResult]>)("after %s on a home, its other seats are skipped", async (_what, first) => {
    const { d } = deps({ "c1@fleet": first });
    const report = await applyAssignment(plan(CODEX, [change("c1@fleet", { runtime: "codex" }), change("c2@fleet", { runtime: "codex" })],
      { codexHomes: [{ home: "/homes/a", seats: [{ seat: "c1@fleet", rig: "fleet", effect: "would restart" }, { seat: "c2@fleet", rig: "fleet", effect: "would restart" },
        { seat: "p@other", rig: "other", effect: "not restarted; needs rig seat restart p@other" }] }] }), CODEX, d);
    expect(report.results.map((r) => [r.seat, r.kind])).toEqual([["c1@fleet", "unknown"], ["c2@fleet", "unknown"]]);
    expect(report.results[0]!.recovery).toBe("rig seat restart c1@fleet --keep-conversation");
    expect(report.results[1]!.detail).toMatch(/^skipped: home outcome unknown/);
    expect(d.switchSeat).toHaveBeenCalledTimes(1);
    expect(d.restartPeer).not.toHaveBeenCalled();
    // The other rig's seat may be affected: it's reported with its command.
    expect(report.otherRigPeers.map((p) => p.seat)).toEqual(["p@other"]);
  });

  it("a seat whose own switch failed before effect restarts once another seat switches its home", async () => {
    const { d } = deps({ "c1@fleet": { outcome: "failed_safely", reasons: ["seat_home_changed"], message: "home changed" } });
    const report = await applyAssignment(plan(CODEX, [change("c1@fleet", { runtime: "codex" }), change("c2@fleet", { runtime: "codex" })],
      { codexHomes: [{ home: "/homes/a", seats: [{ seat: "c1@fleet", rig: "fleet", effect: "would restart" }, { seat: "c2@fleet", rig: "fleet", effect: "would restart" }] }] }), CODEX, d);
    expect(d.switchSeat.mock.calls.map(([s]) => s)).toEqual(["c1@fleet", "c2@fleet"]);
    expect(d.restartPeer.mock.calls.map(([s]) => s)).toEqual(["c1@fleet"]);
    expect(report.results.map((r) => [r.seat, r.kind])).toEqual([["c2@fleet", "switched"], ["c1@fleet", "switched"]]);
    expect(report.otherRigPeers).toEqual([]);
  });

  it("an unsupported seat isn't attempted; a move to a prepared home goes through the successor", async () => {
    const successor = vi.fn(async () => ({ ok: true as const, changed: true, confirmation: { note: "picking up the review", at: "t" } }));
    const { d, saved } = deps({});
    const report = await applyAssignment(plan(CODEX, [change("c1@fleet", { runtime: "codex", continuity: "fresh successor with handover, on /prepared" })],
      { accountHome: "/prepared" }), CODEX, { ...d, successor });
    expect(successor).toHaveBeenCalledWith("c1@fleet", "/prepared");
    expect(report.results[0]).toMatchObject({ kind: "pending_successor", detail: 'a fresh successor took the seat with a handover: "picking up the review"' });
    expect(saved[0]!.applied).toEqual({ file: null, fileKind: null, codexHome: "/prepared", codexLogin: null });
    const mac = await applyAssignment(plan(CODEX, [change("c1@fleet", { runtime: "codex", continuity: "unsupported in place: a Codex seat switches in place only on Linux" })]), CODEX, d);
    expect(mac.results[0]).toMatchObject({ kind: "unsupported", detail: "unsupported in place: a Codex seat switches in place only on Linux" });
    expect(d.switchSeat).not.toHaveBeenCalled();
  });

  it("maps the successor's outcomes", () => {
    expect(successorKind("s", { ok: true, changed: true, recoveryPending: true })).toEqual(["unknown", expect.any(String), "rig seat set-runtime s --recover"]);
    expect(successorKind("s", { ok: false, code: "runtime_switch_unsupported", message: "no pane" })).toEqual(["failed_before_effect", "runtime_switch_unsupported: no pane", undefined]);
    expect(successorKind("s", { ok: false, code: "runtime_switch_failed", message: "m", recoveryPending: true, guidance: "rig seat set-runtime s --recover" })[0]).toBe("unknown");
  });
});
