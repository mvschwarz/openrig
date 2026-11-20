import { describe, expect, it, vi } from "vitest";
import { planAssignment, type AssignmentPlanInput, type PlanSeatFacts } from "../src/domain/provider/assignment-plan.js";
import type { AccountRef } from "../src/domain/provider/provider-account-refs.js";
import type { PrecheckResult } from "../src/domain/provider/provider-types.js";

// #3625 slice 2: the plan's rules, over plain seat facts and a stand-in precheck.

const CLAUDE: AccountRef = { provider: "claude", label: "max-2", kind: "claude_token_file", file: "/keys/max-2", codexHome: null, login: null, createdAt: "t" };
const CODEX: AccountRef = { provider: "codex", label: "team", kind: "codex_saved_login", file: null, codexHome: "/homes/a", login: "team", createdAt: "t" };

function seat(session: string, over: Partial<PlanSeatFacts> = {}): PlanSeatFacts {
  const runtime = over.runtime ?? "claude-code";
  return {
    session, rigName: "fleet", runtime,
    configured: { source: "default_login", home: runtime === "codex" ? "/homes/a" : "/home/u/.claude", homeNote: "n" },
    claudeRef: null, ownHome: null, codexHome: runtime === "codex" ? "/homes/a" : null,
    running: runtime === "claude-code" ? true : null, activity: "idle",
    ...over,
  };
}
const SAFE: PrecheckResult = { safe: true };

function plan(input: Partial<AssignmentPlanInput> & Pick<AssignmentPlanInput, "account" | "seats">, precheck = vi.fn(async (): Promise<PrecheckResult> => SAFE)) {
  return { result: planAssignment({ daemon: "host-a", rig: "fleet", includeOverrides: false, platform: "linux", ...input }, precheck), precheck };
}

describe("the assignment plan", () => {
  it("a mixed rig: only the provider's seats change; the other runtime and a terminal are listed as not affected", async () => {
    const { result, precheck } = plan({ account: CLAUDE, seats: [seat("a@fleet"), seat("b@fleet", { runtime: "codex" }), seat("t@fleet", { runtime: "terminal" })] });
    const p = await result;
    expect(p).toMatchObject({ daemon: "host-a", rig: "fleet", provider: "claude", account: { label: "max-2", reference: "the token file /keys/max-2" } });
    expect(p.rows.map((r) => [r.seat, r.effect])).toEqual([["a@fleet", "change"], ["b@fleet", "not_affected"], ["t@fleet", "not_affected"]]);
    expect(p.rows[1]!.notes).toEqual(["a codex seat: a claude assignment doesn't touch it"]);
    expect(p.rows[2]!.notes).toEqual(["a terminal seat has no claude account"]);
    expect(precheck).toHaveBeenCalledTimes(1);
    expect(p.note).toContain("nothing was changed");
  });

  it("a seat already on the account is unchanged, and isn't prechecked", async () => {
    const { result, precheck } = plan({ account: CLAUDE, seats: [
      seat("on@fleet", { claudeRef: { label: "whatever", tokenFile: "/keys/max-2" } }),
      // The same file as an API key is another credential.
      seat("key@fleet", { claudeRef: { label: "max-2", tokenFile: "/keys/max-2", kind: "api-key" } }),
    ] });
    const p = await result;
    expect(p.rows.map((r) => r.effect)).toEqual(["unchanged", "kept_override"]);
    expect(precheck).not.toHaveBeenCalled();
    const codex = await plan({ account: CODEX, seats: [seat("c@fleet", { runtime: "codex",
      configured: { source: "registry", profileRef: "team", recordedAt: "t", profileSaved: true } })] }).result;
    expect(codex.rows[0]!.effect).toBe("unchanged");
  });

  it("a seat's own choice for another account is kept and shown, unless --include-overrides", async () => {
    const seats = [
      seat("token@fleet", { claudeRef: { label: "max-1", tokenFile: "/keys/max-1" } }),
      seat("home@fleet", { ownHome: { home: "/accounts/x", source: "account-switch" } }),
      seat("member@fleet", { ownHome: { home: "/cfg/own", source: "member" } }),
      seat("rigenv@fleet", { ownHome: { home: "/cfg/rig", source: "rig" } }),
    ];
    const kept = await plan({ account: CLAUDE, seats }).result;
    expect(kept.rows.map((r) => [r.seat, r.effect, r.override])).toEqual([
      ["token@fleet", "kept_override", 'its own token file /keys/max-1 ("max-1")'],
      ["home@fleet", "kept_override", "its account home /accounts/x"],
      ["member@fleet", "kept_override", "its own home /cfg/own (member env)"],
      // A rig-wide home isn't a seat's own choice.
      ["rigenv@fleet", "change", undefined],
    ]);
    expect(kept.rows[0]!.notes).toEqual(["kept (seat override); --include-overrides moves it too"]);
    const included = await plan({ account: CLAUDE, seats, includeOverrides: true }).result;
    expect(included.rows.map((r) => r.effect)).toEqual(["change", "change", "change", "change"]);
    expect(included.rows[0]!.override).toBe('its own token file /keys/max-1 ("max-1")');

    const codex = await plan({ account: CODEX, seats: [seat("reg@fleet", { runtime: "codex",
      configured: { source: "registry", profileRef: "other", recordedAt: "t", profileSaved: true } })] }).result;
    expect(codex.rows[0]).toMatchObject({ effect: "kept_override", override: "the saved login other (seat registry)" });
  });

  it("Claude continuity: a running seat in place; a stopped seat on its next launch", async () => {
    const p = await plan({ account: CLAUDE, seats: [seat("up@fleet"), seat("down@fleet", { running: false })] }).result;
    expect(p.rows[0]!.continuity).toBe("in place: the seat is relaunched in its own pane and keeps its conversation");
    expect(p.rows[1]!.continuity).toMatch(/^next launch: the reference is saved now/);
  });

  it("Codex continuity: in place on Linux; unsupported in place on macOS unless --account-home, then a fresh successor; never a fallback", async () => {
    const seats = [seat("c@fleet", { runtime: "codex" })];
    expect((await plan({ account: CODEX, seats }).result).rows[0]!.continuity).toBe("in place: the seat restarts on the same conversation");
    const mac = await plan({ account: CODEX, seats, platform: "darwin" }).result;
    expect(mac.rows[0]!.continuity).toMatch(/^unsupported in place: a Codex seat switches in place only on Linux/);
    const prepared = await plan({ account: CODEX, seats, platform: "darwin", accountHome: "/prepared/home" }).result;
    expect(prepared.rows[0]!.continuity).toBe("fresh successor with handover, on /prepared/home");
    expect(prepared.accountHome).toBe("/prepared/home");
    // A seat on another home can't take this home's login in place.
    const elsewhere = await plan({ account: CODEX, seats: [seat("d@fleet", { runtime: "codex", codexHome: "/homes/b" })] }).result;
    expect(elsewhere.rows[0]!.continuity).toBe("unsupported in place: the seat runs on /homes/b, and this login is saved in /homes/a");
  });

  it("a shared Codex home switches once and lists every seat on it, restarting only this rig's", async () => {
    const p = await plan({ account: CODEX, seats: [
      seat("c1@fleet", { runtime: "codex" }),
      seat("c2@fleet", { runtime: "codex" }),
      seat("peer@other", { runtime: "codex", rigName: "other" }),
      seat("far@other", { runtime: "codex", rigName: "other", codexHome: "/homes/b" }),
      seat("cl@other", { rigName: "other" }),
    ] }).result;
    expect(p.rows.map((r) => r.seat)).toEqual(["c1@fleet", "c2@fleet"]);
    expect(p.codexHomes).toEqual([{ home: "/homes/a", seats: [
      { seat: "c1@fleet", rig: "fleet", effect: "would restart" },
      { seat: "c2@fleet", rig: "fleet", effect: "would restart" },
      { seat: "peer@other", rig: "other", effect: "not restarted; needs rig seat restart peer@other" },
    ] }]);
    // Moving to a named account home changes no shared home.
    expect((await plan({ account: CODEX, seats: [seat("c1@fleet", { runtime: "codex" })], accountHome: "/prepared" }).result).codexHomes).toEqual([]);
  });

  it("shows the precheck's verdict and reasons, and a busy seat as a note, not a refusal", async () => {
    const precheck = vi.fn(async (s: PlanSeatFacts): Promise<PrecheckResult> => s.session === "bad@fleet"
      ? { safe: false, reasons: ["credential_outranks_token"], message: "ANTHROPIC_API_KEY would be used instead" } : SAFE);
    const p = await plan({ account: CLAUDE, seats: [seat("bad@fleet"), seat("busy@fleet", { activity: "running" })] }, precheck).result;
    expect(p.rows[0]!.precheck).toEqual({ safe: false, reasons: ["credential_outranks_token"], message: "ANTHROPIC_API_KEY would be used instead" });
    expect(p.rows[1]).toMatchObject({ effect: "change", precheck: { safe: true, reasons: [] }, activity: "running",
      notes: ["busy (working): a switch interrupts work in flight"] });
  });
});
