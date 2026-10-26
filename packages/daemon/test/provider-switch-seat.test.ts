import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { authSwitch, resolveCodexHome } from "../src/domain/codex-auth.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";

// `rig provider switch --seat`: one seat moves to a login saved in the Codex home it runs on (its own home with #1937,
// or a shared one, whose peers are named). The seat's in-place restart keeps its conversation and launch settings;
// the restart plan runs first, so a refusal changes nothing. Uptake is left to `rig seat restart --verify`.

const HOME = "/homes/seat-a";
const NOW = "2026-10-25T04:10:00.000Z";
const BEFORE = "before-switch-20261025T041000.000Z";
const PEER = { logicalId: "dev.qa", sessionName: "dev-qa@rig", home: "same" as const, effect: "not restarted; account unverified" };
const OTHER = { logicalId: "dev.guard", sessionName: "dev-guard@rig", home: "different" as const, effect: "Not restarted; uses a different Codex home." };

function report(over: Record<string, unknown> = {}) {
  return { ok: true, planOnly: true, message: "planned", codexHome: HOME, peers: [], activity: { state: "idle", needsInput: null, detail: "" }, ...over };
}

function harness(opts: { plan?: Record<string, unknown>; run?: Record<string, unknown>; saved?: string[]; loggedIn?: boolean; saveFails?: string } = {}) {
  const calls: string[] = [];
  const homes = new Map([[HOME, { active: opts.loggedIn === false ? null as string | null : "personal", saved: new Set(opts.saved ?? ["personal", "work"]) }]]);
  const codexLogins = {
    list: (home: string) => [...(homes.get(home)?.saved ?? [])].sort(),
    save: (home: string, name: string) => {
      calls.push(`save ${home} ${name}`);
      const h = homes.get(home);
      if (!h?.active) return { ok: false as const, reason: "not_configured" };
      if (opts.saveFails) return { ok: false as const, reason: opts.saveFails };
      if (h.saved.has(name)) return { ok: false as const, reason: "name_taken" };
      h.saved.add(name);
      return { ok: true as const, name };
    },
    activate: (home: string, name: string) => {
      calls.push(`activate ${home} ${name}`);
      const h = homes.get(home);
      if (!h?.saved.has(name)) return { ok: false as const, reason: "missing_profile" };
      h.active = name;
      return { ok: true as const };
    },
  };
  const seatRestart = {
    plan: async (seat: string) => { calls.push(`plan ${seat}`); return (opts.plan ?? report()) as never; },
    run: async (seat: string, reason: string) => {
      calls.push(`run ${seat} ${reason}`);
      return (opts.run ?? report({ planOnly: false, outcome: "restarted_account_unverified", message: "Restarted in place." })) as never;
    },
  };
  const svc = new ProviderServiceImpl({ db: {} as never, listRigs: () => [], codexLogins, now: () => NOW });
  return { svc, seatRestart, calls, homes };
}

describe("rig provider switch --seat moves one seat to a login saved in the Codex home it runs on", () => {
  it("plans the restart, keeps the outgoing login, activates the chosen one there, restarts in place, and leaves uptake to verify", async () => {
    const h = harness();
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart);
    expect(h.calls).toEqual([
      "plan dev-a@rig",
      `save ${HOME} ${BEFORE}`,
      `activate ${HOME} work`,
      "run dev-a@rig rig provider switch --to-account work",
    ]);
    expect(r).toMatchObject({
      outcome: "rebind_in_progress",
      seat: { seat: "dev-a@rig", home: HOME, account: "work", loginChanged: true, savedBefore: BEFORE,
        undo: `rig auth switch --codex-home ${HOME} ${BEFORE}`, restart: { outcome: "restarted_account_unverified" },
        next: expect.stringContaining("rig seat restart dev-a@rig --keep-conversation --verify --expect-account") },
    });
    expect(h.homes.get(HOME)!.active).toBe("work");
  });

  it("names every peer on a shared home, and gives each one on the same home its restart, since it stops at its next token refresh", async () => {
    const h = harness({ plan: report({ peers: [PEER, OTHER] }), run: report({ planOnly: false, outcome: "restarted_account_unverified", peers: [PEER, OTHER] }) });
    expect(await h.svc.precheck({ seat: "dev-a@rig", toAccount: "work" }, h.seatRestart))
      .toMatchObject({ safe: true, seat: { home: HOME, activity: "idle", peers: [PEER, OTHER] } });
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart);
    expect(r).toMatchObject({ outcome: "rebind_in_progress",
      seat: { peers: [{ ...PEER, step: 'rig seat restart dev-qa@rig --keep-conversation --reason "its Codex home moved to work"' }, OTHER] } });
    expect(r.seat!.peers[1]).not.toHaveProperty("step");
  });

  it("a home whose current login can't be saved first changes nothing: the switch stops before activation", async () => {
    const h = harness({ saveFails: "io_error" });
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["outgoing_login_not_saved"], message: expect.stringContaining("io_error") });
    expect(h.calls).toEqual(["plan dev-a@rig", `save ${HOME} ${BEFORE}`]);
    expect(h.homes.get(HOME)!.active).toBe("personal");
  });

  it("an unknown sign-in state doesn't stop an authorized move", async () => {
    const h = harness();
    const verdict = await h.svc.precheck({ seat: "dev-a@rig", toAccount: "work" }, h.seatRestart);
    expect(verdict).toMatchObject({ safe: true });
    expect(verdict).not.toHaveProperty("reasons");
  });

  it("a refused restart plan changes nothing: the home's login stays, and the refusal is named", async () => {
    const h = harness({ plan: { ok: false, code: "settings_unverified", message: "Couldn't read the running Codex's environment." } });
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: true }, h.seatRestart);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["seat_restart_refused"], message: expect.stringContaining("settings_unverified") });
    expect(h.calls).toEqual(["plan dev-a@rig"]);
    expect(h.homes.get(HOME)!.active).toBe("personal");
  });

  it("a Claude seat isn't switched: its runtime has no account switch yet", async () => {
    const h = harness({ plan: { ok: false, code: "not_codex", message: "Seat \"dev-a@rig\" runs claude-code; in-place restart supports Codex seats only." } });
    expect(await h.svc.precheck({ seat: "dev-a@rig", toAccount: "work" }, h.seatRestart))
      .toMatchObject({ safe: false, reasons: ["rebind_unsupported_for_runtime"] });
    expect(await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart))
      .toMatchObject({ outcome: "failed_safely", reasons: ["rebind_unsupported_for_runtime"] });
    expect(h.calls.some((call) => call.startsWith("activate"))).toBe(false);
  });

  it("a login that isn't saved in the seat's home is named, with how to list the ones that are", async () => {
    const h = harness({ saved: ["personal"] });
    expect(await h.svc.precheck({ seat: "dev-a@rig", toAccount: "work" }, h.seatRestart)).toMatchObject({
      safe: false, reasons: ["target_not_in_seat_home"], message: expect.stringContaining(`rig auth list --codex-home ${HOME}`),
    });
    expect(h.calls.some((call) => call.startsWith("activate") || call.startsWith("run"))).toBe(false);
  });

  it("a restart that can't confirm is reported as unknown, with its recovery command, and never retried", async () => {
    const h = harness({ run: report({ planOnly: false, outcome: "native_unknown", recoveryCommand: "codex resume abc", message: "The replacement Codex wasn't observed." }) });
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart);
    expect(r).toMatchObject({ outcome: "unknown", reasons: ["restart_native_unknown"],
      seat: { loginChanged: true, restart: { outcome: "native_unknown", recoveryCommand: "codex resume abc" } } });
    expect(h.calls.filter((call) => call.startsWith("run"))).toHaveLength(1);
  });

  it("a restart refused after the login changed says so, with the way back", async () => {
    const h = harness({ run: { ok: false, code: "restart_in_progress", message: "Another restart of this seat is running." } });
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["login_changed_seat_not_restarted"],
      message: expect.stringContaining("Another restart of this seat is running."),
      seat: { loginChanged: true, undo: `rig auth switch --codex-home ${HOME} ${BEFORE}` } });
    // The seat wasn't restarted, so it keeps its old login only until its next token refresh.
    expect(r.message).toContain("next token refresh");
    expect(r.message).toContain('rig seat restart dev-a@rig --keep-conversation --reason "its Codex home moved to work"');
  });

  it("a switch that waited behind another on its home checks the seat again before it changes the login", async () => {
    const h = harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let bPlans = 0;
    const seatRestart = {
      plan: async (seat: string) => {
        h.calls.push(`plan ${seat}`);
        // While it waits, seat B loses what its restart needs.
        if (seat === "dev-b@rig" && bPlans++ > 0) return { ok: false, code: "settings_unverified", message: "Couldn't read the running Codex's environment." } as never;
        return report() as never;
      },
      run: async (seat: string) => {
        h.calls.push(`run ${seat}`);
        if (seat === "dev-a@rig") await held;
        return report({ planOnly: false, outcome: "restarted_account_unverified", message: "Restarted in place." }) as never;
      },
    };
    const a = h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, seatRestart);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const b = h.svc.switchAccount({ seat: "dev-b@rig", toAccount: "personal", forceUnsafe: false }, seatRestart);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    expect(await a).toMatchObject({ outcome: "rebind_in_progress" });
    expect(await b).toMatchObject({ outcome: "failed_safely", reasons: ["seat_restart_refused"], message: expect.stringContaining("settings_unverified") });
    // B planned twice (before and after its wait), and changed nothing: the home keeps A's login.
    expect(h.calls.filter((call) => call.endsWith("dev-b@rig"))).toEqual(["plan dev-b@rig", "plan dev-b@rig"]);
    expect(h.homes.get(HOME)!.active).toBe("work");
  });

  it("a switch whose seat moved to another home while it waited touches neither home", async () => {
    const h = harness();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let bPlans = 0;
    const seatRestart = {
      plan: async (seat: string) => {
        h.calls.push(`plan ${seat}`);
        if (seat === "dev-b@rig" && bPlans++ > 0) return report({ codexHome: "/homes/seat-b" }) as never;
        return report() as never;
      },
      run: async (seat: string) => {
        h.calls.push(`run ${seat}`);
        if (seat === "dev-a@rig") await held;
        return report({ planOnly: false, outcome: "restarted_account_unverified", message: "Restarted in place." }) as never;
      },
    };
    const a = h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, seatRestart);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const b = h.svc.switchAccount({ seat: "dev-b@rig", toAccount: "personal", forceUnsafe: false }, seatRestart);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await a;
    expect(await b).toMatchObject({ outcome: "failed_safely", reasons: ["seat_home_changed"], message: expect.stringContaining("/homes/seat-b") });
    expect(h.calls.filter((call) => call.endsWith("dev-b@rig") || call.includes("seat-b"))).toEqual(["plan dev-b@rig", "plan dev-b@rig"]);
    expect(h.homes.get(HOME)!.active).toBe("work");
  });

  it("a home with no active login moves without a before copy, and says there's nothing to switch back to", async () => {
    const h = harness({ loggedIn: false });
    const r = await h.svc.switchAccount({ seat: "dev-a@rig", toAccount: "work", forceUnsafe: false }, h.seatRestart);
    expect(r).toMatchObject({ outcome: "rebind_in_progress", seat: { savedBefore: null, undo: null, loginChanged: true } });
    expect(h.homes.get(HOME)!.active).toBe("work");
  });
});

// The same switch on real files in a temporary Codex home (`rig auth`'s save and switch); only the restart is stubbed.
describe("switches on one Codex home keep each receipt's way back and the login its restart loads", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => { for (const f of cleanup.splice(0)) f(); });

  const login = (name: string) => JSON.stringify({ fixture: name });

  function codexHome() {
    const home = mkdtempSync(path.join(tmpdir(), "provider-switch-home-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(path.join(home, "auth-profiles"), { mode: 0o700 });
    for (const name of ["alpha", "beta", "gamma"]) writeFileSync(path.join(home, "auth-profiles", `${name}.json`), login(name), { mode: 0o600 });
    writeFileSync(path.join(home, "auth.json"), login("alpha"), { mode: 0o600 });
    const times = ["2026-10-25T04:10:00.100Z", "2026-10-25T04:10:00.200Z"];
    const svc = new ProviderServiceImpl({ db: {} as never, listRigs: () => [], now: () => times.length > 1 ? times.shift()! : times[0] });
    const restarted = () => report({ codexHome: home, planOnly: false, outcome: "restarted_account_unverified", message: "Restarted in place." });
    const restart = (run: () => Promise<unknown> = async () => restarted()) => ({ plan: async () => report({ codexHome: home }) as never, run: run as never });
    const active = () => readFileSync(path.join(home, "auth.json"), "utf8");
    const undo = (savedBefore: string) => authSwitch(resolveCodexHome({ CODEX_HOME: home }), savedBefore);
    return { home, svc, times, restart, restarted, active, undo };
  }

  it("each switch keeps its own recovery copy, so an earlier receipt's undo still restores its own login", async () => {
    const f = codexHome();
    const first = await f.svc.switchAccount({ seat: "dev-a@rig", toAccount: "beta", forceUnsafe: false }, f.restart());
    const second = await f.svc.switchAccount({ seat: "dev-b@rig", toAccount: "gamma", forceUnsafe: false }, f.restart());
    expect([first.outcome, second.outcome]).toEqual(["rebind_in_progress", "rebind_in_progress"]);
    expect(first.seat!.savedBefore).not.toBe(second.seat!.savedBefore);
    expect(f.undo(first.seat!.savedBefore!).ok).toBe(true);
    expect(f.active()).toBe(login("alpha"));
    expect(f.undo(second.seat!.savedBefore!).ok).toBe(true);
    expect(f.active()).toBe(login("beta"));
  });

  it("a recovery copy is never overwritten: a second switch in the same millisecond stops before changing anything", async () => {
    const f = codexHome();
    f.times.splice(1);
    const first = await f.svc.switchAccount({ seat: "dev-a@rig", toAccount: "beta", forceUnsafe: false }, f.restart());
    const second = await f.svc.switchAccount({ seat: "dev-b@rig", toAccount: "gamma", forceUnsafe: false }, f.restart());
    expect(second).toMatchObject({ outcome: "failed_safely", reasons: ["outgoing_login_not_saved"] });
    expect(f.active()).toBe(login("beta"));
    expect(f.undo(first.seat!.savedBefore!).ok).toBe(true);
    expect(f.active()).toBe(login("alpha"));
  });

  it("two switches on one home run one at a time, so each restart loads the login its receipt names", async () => {
    const f = codexHome();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inFirstRestart = new Promise<void>((resolve) => { entered = resolve; });
    let firstRestartLoaded = "";
    const first = f.svc.switchAccount({ seat: "dev-a@rig", toAccount: "beta", forceUnsafe: false }, f.restart(async () => {
      entered();
      await held;
      firstRestartLoaded = f.active();
      return f.restarted();
    }));
    await inFirstRestart;
    const second = f.svc.switchAccount({ seat: "dev-b@rig", toAccount: "gamma", forceUnsafe: false }, f.restart());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // While the first seat restarts, the second switch hasn't touched the home.
    expect(f.active()).toBe(login("beta"));
    release();
    expect(await first).toMatchObject({ outcome: "rebind_in_progress", seat: { account: "beta" } });
    expect(firstRestartLoaded).toBe(login("beta"));
    expect(await second).toMatchObject({ outcome: "rebind_in_progress", seat: { account: "gamma" } });
    expect(f.active()).toBe(login("gamma"));
  });
});
