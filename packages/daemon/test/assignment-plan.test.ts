import { describe, expect, it, vi } from "vitest";
import { planAssignment, type AssignmentPlanInput, type PlanSeatFacts } from "../src/domain/provider/assignment-plan.js";
import type { AccountRef } from "../src/domain/provider/provider-account-refs.js";
import type { PlanCheck } from "../src/domain/provider/assignment-plan.js";

// #3625 slice 2: the plan's rules, over plain seat facts and a stand-in precheck.

const CLAUDE: AccountRef = { provider: "claude", label: "max-2", kind: "claude_token_file", file: "/keys/max-2", codexHome: null, login: null, createdAt: "t" };
const CODEX: AccountRef = { provider: "codex", label: "team", kind: "codex_saved_login", file: null, codexHome: "/homes/a", login: "team", createdAt: "t" };

function seat(session: string, over: Partial<PlanSeatFacts> = {}): PlanSeatFacts {
  const runtime = over.runtime ?? "claude-code";
  return {
    session, rigId: `id-${over.rigName ?? "fleet"}`, rigName: "fleet", runtime,
    configured: { source: "default_login", home: runtime === "codex" ? "/homes/a" : "/home/u/.claude", homeNote: "n" },
    claudeRef: null, ownHome: null, codexHome: runtime === "codex" ? "/homes/a" : null,
    running: runtime === "claude-code" ? true : null, activity: "idle",
    ...over,
  };
}
const SAFE: PlanCheck = { safe: true };

function plan(input: Partial<AssignmentPlanInput> & Pick<AssignmentPlanInput, "account" | "seats">, precheck = vi.fn(async (_s: PlanSeatFacts): Promise<PlanCheck> => SAFE)) {
  return { result: planAssignment({ daemon: "host-a", rig: "fleet", rigId: "id-fleet", includeOverrides: false, platform: "linux", ...input }, precheck), precheck };
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
    // The precheck decides: a stopped seat whose next launch wouldn't resume its conversation doesn't claim it would.
    const stuck = await plan({ account: CLAUDE, seats: [seat("down@fleet", { running: false })] },
      vi.fn(async (): Promise<PlanCheck> => ({ safe: false, reasons: ["conversation_not_resumable"] }))).result;
    expect(stuck.rows[0]!.continuity).toBe("not resumable: the precheck found no conversation the seat's next launch would resume");
    const unknown = await plan({ account: CLAUDE, seats: [seat("q@fleet", { running: null })] }).result;
    expect(unknown.rows[0]!.continuity).toBe("unknown: the daemon can't tell whether the seat is running, so whether it keeps its conversation in place or at its next launch");
  });

  it("--account-home leaves a Codex seat that's already on the account's own saved login where it is", async () => {
    const on = seat("on@fleet", { runtime: "codex", configured: { source: "registry", profileRef: "team", home: "/homes/a", homeNote: "n" } as PlanSeatFacts["configured"] });
    const { result, precheck } = plan({ account: CODEX, seats: [on, seat("off@fleet", { runtime: "codex" })], platform: "darwin", accountHome: "/prepared" });
    expect((await result).rows.map((r) => [r.seat, r.effect])).toEqual([["on@fleet", "unchanged"], ["off@fleet", "change"]]);
    expect(precheck.mock.calls.map(([s]) => s.session)).toEqual(["off@fleet"]);
  });

  it("Codex continuity: in place on Linux and macOS; unsupported in place elsewhere unless --account-home, then a fresh successor; never a fallback", async () => {
    const seats = [seat("c@fleet", { runtime: "codex" })];
    expect((await plan({ account: CODEX, seats }).result).rows[0]!.continuity).toBe("in place: the seat restarts on the same conversation");
    // macOS reads the running Codex from its launch record and lsof (#3840), so it restarts in place as on Linux.
    const mac = await plan({ account: CODEX, seats, platform: "darwin" }).result;
    expect(mac.rows[0]!.continuity).toBe("in place: the seat restarts on the same conversation");
    const windows = await plan({ account: CODEX, seats, platform: "win32" }).result;
    expect(windows.rows[0]!.continuity).toBe("unsupported in place: a Codex seat switches in place only on Linux and macOS (name a prepared home with --account-home for a fresh successor)");
    const prepared = await plan({ account: CODEX, seats, platform: "darwin", accountHome: "/prepared/home" }).result;
    expect(prepared.rows[0]!.continuity).toBe("fresh successor with handover, on /prepared/home");
    expect(prepared.accountHome).toBe("/prepared/home");
    expect(prepared.rows[0]!.notes).toEqual(["not checked: whether /prepared/home is signed in as team; the successor uses the login active in that home"]);
    // Its check is the one the service hands in (the account-home dry run), and its verdict is shown as is.
    const refused = await plan({ account: CODEX, seats, platform: "darwin", accountHome: "/prepared/home" },
      vi.fn(async (): Promise<PlanCheck> => ({ safe: false, reasons: ["runtime_switch_unsupported"], message: "only a single-pane seat can" }))).result;
    expect(refused.rows[0]!.precheck).toEqual({ safe: false, reasons: ["runtime_switch_unsupported"], message: "only a single-pane seat can" });
    // Homes are compared resolved: the same directory written another way is the same home.
    const slash = await plan({ account: CODEX, seats: [seat("e@fleet", { runtime: "codex", codexHome: "/homes/a/" })],
      resolveHome: (h) => h.replace(/\/+$/, "") }).result;
    expect(slash.rows[0]!.continuity).toBe("in place: the seat restarts on the same conversation");
    expect(slash.codexHomes.map((h) => h.seats.map((x) => x.seat))).toEqual([["e@fleet"]]);
    // A seat on another home can't take this home's login in place.
    const elsewhere = await plan({ account: CODEX, seats: [seat("d@fleet", { runtime: "codex", codexHome: "/homes/b" })] }).result;
    expect(elsewhere.rows[0]!.continuity).toBe("unsupported in place: the seat runs on /homes/b, and this login is saved in /homes/a");
  });

  it("a seat that's unchanged but restarts with a home this plan switches has its restart checked, and the verdict is in the digest", async () => {
    const reg = { source: "registry" as const, profileRef: "team", recordedAt: "t", profileSaved: true };
    const seats = [seat("c1@fleet", { runtime: "codex" }), seat("on@fleet", { runtime: "codex", configured: reg })];
    const refuse = (s: PlanSeatFacts): Promise<PlanCheck> => Promise.resolve(s.session === "on@fleet"
      ? { safe: false, reasons: ["seat_restart_refused"], message: "pane_unverified: no bound pane" } : SAFE);
    const unsafe = plan({ account: CODEX, seats }, vi.fn(refuse));
    const p = await unsafe.result;
    expect(unsafe.precheck.mock.calls.map(([s]) => s.session)).toEqual(["c1@fleet", "on@fleet"]);
    expect(p.rows[1]).toMatchObject({ seat: "on@fleet", effect: "unchanged",
      precheck: { safe: false, reasons: ["seat_restart_refused"], message: "pane_unverified: no bound pane" } });
    const safe = await plan({ account: CODEX, seats }).result;
    expect(safe.rows[1]).toMatchObject({ effect: "unchanged", precheck: { safe: true, reasons: [] } });
    expect(safe.digest).not.toBe(p.digest);
    // With nothing switching its home, an unchanged seat restarts with nothing, so it isn't checked.
    const alone = plan({ account: CODEX, seats: [seat("on@fleet", { runtime: "codex", configured: reg })] });
    expect((await alone.result).rows[0]).not.toHaveProperty("precheck");
    expect(alone.precheck).not.toHaveBeenCalled();
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
      { seat: "c1@fleet", rig: "fleet", rigId: "id-fleet", effect: "would restart" },
      { seat: "c2@fleet", rig: "fleet", rigId: "id-fleet", effect: "would restart" },
      { seat: "peer@other", rig: "other", rigId: "id-other", effect: "not restarted; needs rig seat restart peer@other" },
    ] }]);
    // A seat's own choice can't keep it off a home that switches: it moves with the home, and the row says so.
    const reg = { source: "registry" as const, profileRef: "other", recordedAt: "t", profileSaved: true };
    const moved = await plan({ account: CODEX, seats: [seat("c1@fleet", { runtime: "codex" }), seat("own@fleet", { runtime: "codex", configured: reg }),
      seat("on@fleet", { runtime: "codex", configured: { ...reg, profileRef: "team" } })] }).result;
    expect(moved.rows.map((r) => [r.seat, r.effect])).toEqual([["c1@fleet", "change"], ["own@fleet", "change"], ["on@fleet", "unchanged"]]);
    expect(moved.rows[1]).toMatchObject({ override: "the saved login other (seat registry)",
      notes: ["moves with its home: the switch makes team the active login of /homes/a, which this seat runs on, so its own choice can't be kept"] });
    expect(moved.rows[2]!.notes).toEqual(["already on team; moves with its home: the switch makes team the active login of /homes/a, which this seat runs on, so it restarts with it"]);
    // With nothing else switching that home, the choice is kept.
    expect((await plan({ account: CODEX, seats: [seat("own@fleet", { runtime: "codex", configured: reg })] }).result).rows[0]!.effect).toBe("kept_override");
    // Moving to a named account home changes no shared home.
    expect((await plan({ account: CODEX, seats: [seat("c1@fleet", { runtime: "codex" })], accountHome: "/prepared" }).result).codexHomes).toEqual([]);
    // macOS switches the home in place as Linux does, so it lists the same seats; elsewhere nothing switches in place, so no
    // home is switched and nothing restarts.
    const onHome = [seat("c1@fleet", { runtime: "codex" }), seat("peer@other", { runtime: "codex", rigName: "other" })];
    expect((await plan({ account: CODEX, seats: onHome, platform: "darwin" }).result).codexHomes)
      .toEqual((await plan({ account: CODEX, seats: onHome, platform: "linux" }).result).codexHomes);
    expect((await plan({ account: CODEX, seats: onHome, platform: "darwin" }).result).codexHomes).not.toEqual([]);
    expect((await plan({ account: CODEX, seats: onHome, platform: "win32" }).result).codexHomes).toEqual([]);
    // A seat on another home can't switch in place: only the account's own home is listed.
    const mixed = await plan({ account: CODEX, seats: [seat("c1@fleet", { runtime: "codex" }), seat("c9@fleet", { runtime: "codex", codexHome: "/homes/b" })] }).result;
    expect(mixed.codexHomes.map((h) => [h.home, h.seats.map((s) => s.seat)])).toEqual([["/homes/a", ["c1@fleet"]]]);
  });

  it("shows the precheck's verdict and reasons, and a busy seat as a note, not a refusal", async () => {
    const precheck = vi.fn(async (s: PlanSeatFacts): Promise<PlanCheck> => s.session === "bad@fleet"
      ? { safe: false, reasons: ["credential_outranks_token"], message: "ANTHROPIC_API_KEY would be used instead" } : SAFE);
    const p = await plan({ account: CLAUDE, seats: [seat("bad@fleet"), seat("busy@fleet", { activity: "running" })] }, precheck).result;
    expect(p.rows[0]!.precheck).toEqual({ safe: false, reasons: ["credential_outranks_token"], message: "ANTHROPIC_API_KEY would be used instead" });
    expect(p.rows[1]).toMatchObject({ effect: "change", precheck: { safe: true, reasons: [] }, activity: "running",
      notes: ["busy (working): a switch interrupts work in flight"] });
  });
});
