import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import type { ClaudeSeatTokenRef } from "../src/domain/claude-seat-token.js";
import type { CredentialPrecedence } from "../src/domain/claude-credential-precedence.js";
import type { ClaudeSeatRelaunch } from "../src/domain/provider/provider-service.js";

// `rig provider switch --seat` for a Claude seat: the seat keeps its config dir and its pane, gets its own subscription token
// through a token-file reference, and resumes the same conversation by restore's own path: under the seat's lifecycle lease, a
// snapshot taken now that resumes it, then only that seat relaunched from that snapshot in its own pane. Nothing changes until
// every check has passed, and only a refusal before the seat was touched reads as unchanged.

const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

const SEAT = "dev-a@rig";
const CLEAR: CredentialPrecedence = { conflicts: [], checked: ["the launch environment"], notChecked: ["managed settings (a managed-settings.json file, MDM or the server)"] };
type Relaunched = Awaited<ReturnType<ClaudeSeatRelaunch["relaunchInPane"]>>;
const RESUMED: Relaunched = { ok: true, status: "resumed", warnings: [] };

function tokenFile(contents = "fixture-file-contents", name = "work.token") {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-switch-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

function harness(opts: {
  runtime?: string; running?: boolean; pane?: string | null; ref?: ClaudeSeatTokenRef | null; precedence?: CredentialPrecedence;
  snapshot?: { resumes: true; conversation: string | null } | { resumes: false; why: string };
  nextLaunch?: ReturnType<ClaudeSeatRelaunch["nextLaunch"]>;
  relaunch?: Relaunched | (() => Promise<Relaunched>);
  exclusive?: (fn: () => Promise<unknown>) => Promise<unknown>;
  effort?: Awaited<ReturnType<NonNullable<ClaudeSeatRelaunch["effortChange"]>>>;
  // What restore's launch-effort seam selected and why (default: the kept effort when one was asked for, else what the
  // seat's effort read before the relaunch implies).
  selected?: { effort: string | null; source: "kept" | "seat_choice" | "saved" } | null;
} = {}) {
  const calls: string[] = [];
  let ref: ClaudeSeatTokenRef | null = opts.ref ?? null;
  let queue: Promise<unknown> = Promise.resolve();
  const claudeSeat: ClaudeSeatRelaunch = {
    seat: () => (opts.runtime ?? "claude-code") === "claude-code"
      ? { nodeId: "node-a", rigId: "rig-1", rigName: "rig", logicalId: "dev.a", running: opts.running ?? true, pane: opts.pane === undefined ? "%7" : opts.pane } : null,
    tokenRef: () => ref,
    setTokenRef: (_nodeId, next) => { calls.push(`setTokenRef ${next ? next.label : "null"}`); ref = next; },
    snapshot: (rigId) => { calls.push(`snapshot ${rigId}`); return { snapshotId: "snap-1", ...(opts.snapshot ?? { resumes: true as const, conversation: "conv-1" }) }; },
    nextLaunch: (rigId) => { calls.push(`next launch ${rigId}`); return opts.nextLaunch ?? { snapshotId: "snap-0", resumes: true, automatic: false, conversation: "conv-1" }; },
    // The seat's lifecycle lease: one holder at a time, in arrival order.
    exclusive: <T>(nodeId: string, fn: () => Promise<T>): Promise<T> => {
      calls.push(`exclusive ${nodeId}`);
      if (opts.exclusive) return opts.exclusive(fn) as Promise<T>;
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    },
    ...(opts.effort === undefined ? {} : { effortChange: async (nodeId: string, pane: string) => { calls.push(`effort ${nodeId} ${pane}`); return opts.effort!; } }),
    relaunchInPane: async (rigId, logicalId, snapshotId, o) => {
      calls.push(`relaunch ${rigId} ${logicalId} ${snapshotId} with ${ref ? ref.label : "no reference"}${o?.effort ? ` keeping effort ${o.effort}` : ""}`);
      const done = typeof opts.relaunch === "function" ? await opts.relaunch() : opts.relaunch ?? RESUMED;
      const read = opts.effort;
      const selected = opts.selected !== undefined ? opts.selected
        : o?.effort ? { effort: o.effort, source: "kept" as const }
        : read ? { effort: read.relaunch, source: read.relaunchIsSeatChoice ? "seat_choice" as const : "saved" as const }
        : read === null ? { effort: null, source: "saved" as const } : null;
      return done.ok && selected ? { ...done, effort: selected } : done;
    },
  };
  const claudePrecedence = async (nodeId: string, o?: { storedLogin?: boolean }) => {
    calls.push(`precedence ${nodeId}${o?.storedLogin ? " (stored login)" : ""}`); return opts.precedence ?? CLEAR;
  };
  const svc = new ProviderServiceImpl({ db: {} as never, listRigs: () => [], claudePrecedence });
  const seatRestart = { plan: async () => { throw new Error("the Codex restart isn't used for a Claude seat"); }, run: async () => { throw new Error("unused"); } };
  return { svc, seatRestart, claudeSeat, calls, ref: () => ref };
}

const to = (account: string, file: string | null) => ({ seat: SEAT, toAccount: account, tokenFile: file, forceUnsafe: false });

describe("rig provider switch --seat moves a Claude seat to its own subscription token on the same conversation, in its own pane", () => {
  // A switch is how a person recovers a seat from a limit or an outage, so it keeps what the seat was running with. A
  // process running with its own --effort keeps it through the relaunch, unless the seat has an explicit effort choice
  // (`rig seat set-effort`), which the relaunch applies. The kept value is never saved as the seat's choice, and the
  // result says which effort the relaunch used and why.
  it("keeps the running --effort through the relaunch when the seat has no effort choice of its own, and says so", async () => {
    const h = harness({ effort: { running: "high", relaunch: null, relaunchIsSeatChoice: false } });
    const result = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(result.outcome).toBe("rebind_in_progress");
    expect(h.calls).toContain("effort node-a %7");
    expect(h.calls).toContain("relaunch rig-1 dev.a snap-1 with work keeping effort high");
    expect(result.seat?.effort).toContain("kept the running effort high");
    expect(result.seat?.effort).toContain("the runtime default");
    expect(h.ref()).toMatchObject({ label: "work" });
  });

  it("says a kept effort was asked for, not done, when the relaunch didn't report resuming, and how the recovery keeps it", async () => {
    const h = harness({ effort: { running: "high", relaunch: "low", relaunchIsSeatChoice: false },
      relaunch: { ok: false, effect: "unknown", code: "failed", message: "the seat didn't come back" } });
    const result = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(result.outcome).toBe("unknown");
    expect(h.calls).toContain("relaunch rig-1 dev.a snap-1 with work keeping effort high");
    expect(result.seat?.restart?.recoveryCommand).toBe("rig launch rig dev.a --snapshot-id snap-1");
    expect(result.seat?.effort).not.toContain("kept the running effort");
    expect(result.seat?.effort).toContain("asked to keep the running effort high");
    expect(result.seat?.effort).toContain("explicit effort choice at that time, else the snapshot's effort");
    expect(result.seat?.effort).not.toContain("saved effort low");
    expect(result.seat?.effort).toContain(`rig seat set-effort ${SEAT} high`);
  });

  it("reports the seat's chosen effort when a choice saved during the switch won at restore's launch-effort seam", async () => {
    const h = harness({ effort: { running: "high", relaunch: "low", relaunchIsSeatChoice: false }, selected: { effort: "medium", source: "seat_choice" } });
    const result = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(result.outcome).toBe("rebind_in_progress");
    expect(h.calls).toContain("relaunch rig-1 dev.a snap-1 with work keeping effort high");
    expect(result.seat?.effort).not.toContain("kept the running effort");
    expect(result.seat?.effort).toContain("the seat's chosen effort medium");
    expect(result.seat?.effort).toContain("high");
  });

  it("words the chosen and unreadable efforts as intended, not applied, when the relaunch didn't report resuming", async () => {
    const unknown = { ok: false as const, effect: "unknown" as const, code: "failed", message: "the seat didn't come back" };
    const chosen = harness({ effort: { running: "high", relaunch: "low", relaunchIsSeatChoice: true }, relaunch: unknown });
    const c = await chosen.svc.switchAccount(to("work", tokenFile()), chosen.seatRestart, chosen.claudeSeat);
    expect(c.outcome).toBe("unknown");
    expect(c.seat?.effort).toContain("didn't report resuming");
    expect(c.seat?.effort).toContain("explicit effort choice at that time");
    expect(c.seat?.effort).not.toContain("low");
    const unread = harness({ effort: null, relaunch: unknown });
    const u = await unread.svc.switchAccount(to("work", tokenFile()), unread.seatRestart, unread.claudeSeat);
    expect(u.outcome).toBe("unknown");
    expect(u.seat?.effort).toContain("couldn't be read");
    expect(u.seat?.effort).toContain("didn't report resuming");
    expect(u.seat?.effort).not.toContain("kept");
  });

  it("keeps a running --effort that differs from the seat's saved, authored one", async () => {
    const h = harness({ effort: { running: "high", relaunch: "low", relaunchIsSeatChoice: false } });
    const result = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(result.outcome).toBe("rebind_in_progress");
    expect(h.calls).toContain("relaunch rig-1 dev.a snap-1 with work keeping effort high");
    expect(result.seat?.effort).toContain("kept the running effort high");
    expect(result.seat?.effort).toContain("low");
  });

  it("applies the seat's explicit effort choice, and says so", async () => {
    const h = harness({ effort: { running: "high", relaunch: "low", relaunchIsSeatChoice: true } });
    const result = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(result.outcome).toBe("rebind_in_progress");
    expect(h.calls).toContain("relaunch rig-1 dev.a snap-1 with work");
    expect(result.seat?.effort).toContain("the seat's chosen effort low");
    expect(result.seat?.effort).not.toContain("kept");
  });

  it("reports the explicit choice the launch actually used when another choice was saved during the switch", async () => {
    const h = harness({ effort: { running: "high", relaunch: "low", relaunchIsSeatChoice: true }, selected: { effort: "medium", source: "seat_choice" } });
    const result = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(result.outcome).toBe("rebind_in_progress");
    expect(h.calls).toContain("relaunch rig-1 dev.a snap-1 with work");
    expect(result.seat?.effort).toContain("the seat's chosen effort medium");
    expect(result.seat?.effort).not.toContain("low");
  });

  it("says which effort launched wasn't reported, rather than naming the effort read before the relaunch", async () => {
    const h = harness({ effort: { running: "high", relaunch: "low", relaunchIsSeatChoice: true }, selected: null });
    const result = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(result.outcome).toBe("rebind_in_progress");
    expect(result.seat?.effort).toContain("didn't report which effort it launched");
    expect(result.seat?.effort).not.toContain("low");
  });

  it("relaunches with the saved effort when the running effort can't be read, and says it wasn't read, never that it was kept", async () => {
    const h = harness({ effort: null });
    const result = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(result.outcome).toBe("rebind_in_progress");
    expect(h.calls).toContain("relaunch rig-1 dev.a snap-1 with work");
    expect(result.seat?.effort).toContain("couldn't be read");
    expect(result.seat?.effort).not.toContain("kept");
  });

  it("relaunches with the saved effort when the running process has no --effort flag, and says so", async () => {
    const h = harness({ effort: { running: null, relaunch: "high", relaunchIsSeatChoice: false } });
    const result = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(result.outcome).toBe("rebind_in_progress");
    expect(h.calls).toContain("relaunch rig-1 dev.a snap-1 with work");
    expect(result.seat?.effort).toContain("no --effort flag");
    expect(result.seat?.effort).toContain("high");
  });

  it("says nothing about effort when the relaunch uses the effort already running", async () => {
    const h = harness({ effort: { running: "high", relaunch: "high", relaunchIsSeatChoice: false } });
    const result = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(result.outcome).toBe("rebind_in_progress");
    expect(h.calls).toContain("relaunch rig-1 dev.a snap-1 with work");
    expect(result.seat?.effort).toBeUndefined();
  });

  it("switches to an API-key reference and back without changing the resumed conversation", async () => {
    const h = harness();
    const file = tokenFile();
    const result = await h.svc.switchAccount({ seat: SEAT, toAccount: "api-budget", apiKeyFile: file, forceUnsafe: false }, h.seatRestart, h.claudeSeat);
    expect(result).toMatchObject({ outcome: "rebind_in_progress", seat: { account: "api-budget", credentialKind: "api-key", conversation: "conv-1", tokenApplied: true } });
    expect(h.ref()).toEqual({ label: "api-budget", tokenFile: file, kind: "api-key" });
    const back = await h.svc.switchAccount(to("plan", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(back).toMatchObject({ outcome: "rebind_in_progress", seat: { conversation: "conv-1", undo: expect.stringContaining("--api-key-file") } });
    expect(h.ref()).not.toHaveProperty("kind");
    expect(JSON.stringify(result)).not.toContain("fixture-file-contents");
  });

  it("under the seat's lease, checks what outranks the token, takes a snapshot that resumes the seat, sets the reference and relaunches the seat in its pane from that snapshot", async () => {
    const file = tokenFile();
    const h = harness();
    const r = await h.svc.switchAccount(to("work", file), h.seatRestart, h.claudeSeat);
    expect(h.calls).toEqual([
      "exclusive node-a",
      "precedence node-a",
      "snapshot rig-1",
      "setTokenRef work",
      "relaunch rig-1 dev.a snap-1 with work",
    ]);
    expect(r).toMatchObject({ outcome: "rebind_in_progress", message: expect.stringContaining("in its own pane on its own token"), seat: {
      seat: SEAT, account: "work", tokenFile: file, conversation: "conv-1", loginChanged: true, tokenApplied: true,
      undo: `rig provider switch --seat ${SEAT} --stored-login`,
      next: expect.stringContaining("/status"),
    } });
    // The reference is metadata: the file's contents appear nowhere.
    expect(JSON.stringify(r)).not.toContain("fixture-file-contents");
    expect(h.ref()).toEqual({ label: "work", tokenFile: file });
  });

  it("a credential that outranks the token stops it before anything changes, naming each and its remedy", async () => {
    const h = harness({ precedence: { ...CLEAR, conflicts: [{ name: "ANTHROPIC_API_KEY", source: "the daemon's environment", remedy: "remove it from the daemon's allowlist" }] } });
    const r = await h.svc.switchAccount({ ...to("work", tokenFile()), forceUnsafe: true }, h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["credential_outranks_token"],
      message: expect.stringMatching(/ANTHROPIC_API_KEY.*the daemon's environment.*remove it from the daemon's allowlist/) });
    expect(h.calls).toEqual(["exclusive node-a", "precedence node-a"]);
  });

  it("a token file that wouldn't apply stops it before anything changes", async () => {
    const h = harness();
    const r = await h.svc.switchAccount(to("work", path.join(tmpdir(), "no-such-dir-claude-switch", "work.token")), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["token_file_unusable"], message: expect.stringContaining("doesn't exist") });
    expect(h.calls).toEqual(["exclusive node-a"]);
  });

  it("a snapshot that can't resume the seat's conversation stops it before the reference or the seat changes", async () => {
    const h = harness({ snapshot: { resumes: false, why: "has no resume token for this seat" } });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["conversation_not_resumable"], message: expect.stringContaining("has no resume token") });
    expect(h.calls).toEqual(["exclusive node-a", "precedence node-a", "snapshot rig-1"]);
    expect(h.ref()).toBeNull();
  });

  it("a seat without a bound pane isn't relaunched, and nothing changes", async () => {
    const h = harness({ pane: null });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["no_bound_pane"] });
    expect(h.ref()).toBeNull();
    expect(h.calls.some((call) => call.startsWith("relaunch"))).toBe(false);
  });

  it("a relaunch refused before the seat was touched puts the reference back, and says the seat is as it was, never that it runs", async () => {
    const before = { label: "personal", tokenFile: tokenFile() };
    const h = harness({ ref: before, relaunch: { ok: false, effect: "none", code: "awaiting-decision", message: "Restore stopped for a decision." } });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["relaunch_awaiting_decision"], message: expect.stringContaining("as it was before the switch") });
    expect(r.message).not.toContain("keeps running");
    expect(h.ref()).toEqual(before);
  });

  it("a relaunch that ended the seat's process but didn't resume reads unknown, with the snapshot's recovery and the way back, and isn't retried", async () => {
    const h = harness({ relaunch: { ok: false, effect: "unknown", code: "failed", message: "The pane couldn't be respawned." },
      effort: { running: "high", relaunch: "low", relaunchIsSeatChoice: false } });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r.seat?.effort).toContain("asked to keep the running effort high");
    expect(r.seat?.effort).not.toContain("kept the running effort");
    expect(r).toMatchObject({ outcome: "unknown", reasons: ["relaunch_failed"], message: expect.stringContaining("may have been ended"), seat: {
      loginChanged: true, undo: `rig provider switch --seat ${SEAT} --stored-login`,
      restart: { recoveryCommand: "rig launch rig dev.a --snapshot-id snap-1", remainingStep: expect.stringContaining(`rig seat stop ${SEAT}`) } } });
    expect(r.message).not.toContain("keeps running");
    expect(h.calls.filter((call) => call.startsWith("relaunch"))).toHaveLength(1);
  });

  it("a relaunch that throws reads unknown, with the snapshot's recovery, instead of rejecting the switch", async () => {
    const h = harness({ relaunch: async () => { throw new Error("transport failure after the launch request"); },
      effort: { running: "high", relaunch: "low", relaunchIsSeatChoice: false } });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "unknown", reasons: ["relaunch_threw"], seat: { restart: { recoveryCommand: "rig launch rig dev.a --snapshot-id snap-1" } } });
    expect(r.seat?.effort).toContain("asked to keep the running effort high");
    expect(r.seat?.effort).toContain(`rig seat set-effort ${SEAT} high`);
  });

  it("a token the relaunch couldn't apply is reported: the reference is saved, the token didn't take effect, and the warning is carried", async () => {
    const warning = "dev-a@rig: This seat's Claude subscription token (work) wasn't applied: the seat's pane shell can't run the token step. Claude started without it.";
    const h = harness({ relaunch: { ok: true, status: "resumed", warnings: [warning] } });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "rebind_in_progress", message: expect.stringContaining("the token didn't take effect"),
      seat: { tokenApplied: false, warnings: [warning] } });
    expect(r.message).not.toContain("on its own token");
  });

  it("--stored-login moves the seat back, and the way back names the reference it had, its path quoted as one argument", async () => {
    const before = { label: "work", tokenFile: tokenFile("fixture-file-contents", "prior token's file.txt") };
    const h = harness({ ref: before });
    const r = await h.svc.switchAccount(to("stored-login", null), h.seatRestart, h.claudeSeat);
    expect(h.calls).toContain("precedence node-a (stored login)");
    expect(r).toMatchObject({ outcome: "rebind_in_progress", message: expect.stringContaining("on its config dir's stored login"), seat: { account: "stored-login",
      undo: `rig provider switch --seat ${SEAT} --to-account work --token-file '${before.tokenFile.replace(/'/g, `'"'"'`)}'` } });
    expect(h.ref()).toBeNull();
    const args = execFileSync("/bin/sh", ["-c", `rig() { printf '%s\\n' "$@"; }\n${r.seat!.undo}`], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" }).trimEnd().split("\n");
    expect(args.slice(args.indexOf("--token-file") + 1)).toEqual([before.tokenFile]);
  });

  it("--stored-login with an inherited CLAUDE_CODE_OAUTH_TOKEN goes ahead and says that token is what the seat uses", async () => {
    const inherited = { name: "CLAUDE_CODE_OAUTH_TOKEN", source: "the daemon's environment, which every managed Claude launch receives", remedy: "unset it where the daemon starts" };
    const h = harness({ ref: { label: "work", tokenFile: tokenFile() }, precedence: { ...CLEAR, instead: [inherited] } });
    const r = await h.svc.switchAccount(to("stored-login", null), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "rebind_in_progress",
      message: expect.stringContaining("It uses the CLAUDE_CODE_OAUTH_TOKEN from the daemon's environment"),
      seat: { next: expect.stringContaining("not the stored login") } });
    expect(r.message).not.toContain("on its config dir's stored login");
  });

  it("a stopped seat gets the new token file for the launch that resumes its conversation: nothing is relaunched or captured", async () => {
    const h = harness({ running: false, pane: null, ref: { label: "retired", tokenFile: "/tokens/retired" } });
    const file = tokenFile();
    const r = await h.svc.switchAccount(to("work", file), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "succeeded", seat: { account: "work", tokenFile: file, conversation: "conv-1", loginChanged: true,
      undo: "rig provider switch --seat dev-a@rig --to-account retired --token-file '/tokens/retired'",
      next: expect.stringContaining(`rig launch rig dev.a --snapshot-id snap-0 resumes conversation conv-1 with its token reference "work". `) } });
    expect(r.message).toBe(`dev-a@rig isn't running, so nothing was relaunched. Its next launch uses its token reference "work": rig launch rig dev.a --snapshot-id snap-0.`);
    // No snapshot is taken, and the checked one is the one the launch uses.
    expect(h.calls).toEqual(["exclusive node-a", "precedence node-a", "next launch rig-1", "setTokenRef work"]);
    expect(h.ref()).toEqual({ label: "work", tokenFile: file });
  });

  it("a stopped seat whose next launch wouldn't resume its conversation refuses, and keeps its reference", async () => {
    const retired = { label: "retired", tokenFile: "/tokens/retired" };
    const h = harness({ running: false, ref: retired, nextLaunch: { snapshotId: "snap-0", resumes: false, why: "has no resume token for this seat" } });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["conversation_not_resumable"] });
    expect(r.message).toBe("dev-a@rig isn't running, and snapshot snap-0, which its next launch uses, has no resume token for this seat, so it wouldn't resume its conversation. Nothing changed.");
    expect(h.calls).toEqual(["exclusive node-a", "precedence node-a", "next launch rig-1"]);
    expect(h.ref()).toEqual(retired);
  });

  it("a stopped seat that resumes through restore's automatic periodic carry is told to launch it plainly, since naming the snapshot turns the carry off", async () => {
    const h = harness({ running: false, nextLaunch: { snapshotId: "snap-p", resumes: true, automatic: true, conversation: "conv-7" } });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "succeeded", seat: { conversation: "conv-7",
      next: expect.stringContaining(`rig launch rig dev.a resumes conversation conv-7 with its token reference "work" (it selects the latest usable snapshot, snap-p now, and resumes through its periodic carry)`) } });
    expect(r.message).toBe(`dev-a@rig isn't running, so nothing was relaunched. Its next launch uses its token reference "work": rig launch rig dev.a.`);
    expect(JSON.stringify(r)).not.toContain("--snapshot-id");
  });

  it("a stopped seat's --stored-login with an inherited CLAUDE_CODE_OAUTH_TOKEN says that token is what its next launch uses", async () => {
    const inherited = { name: "CLAUDE_CODE_OAUTH_TOKEN", source: "the daemon's environment, which every managed Claude launch receives", remedy: "unset it where the daemon starts" };
    const h = harness({ running: false, ref: { label: "work", tokenFile: tokenFile() }, precedence: { ...CLEAR, instead: [inherited] } });
    const r = await h.svc.switchAccount(to("stored-login", null), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "succeeded",
      message: expect.stringContaining("Its next launch uses the CLAUDE_CODE_OAUTH_TOKEN from the daemon's environment"),
      seat: { account: "stored-login", next: expect.stringContaining("not the stored login") } });
    expect(r.message).toContain("which Claude Code ranks above its config dir's stored login");
    expect(h.ref()).toBeNull();
  });

  it("precheck on a stopped seat reads the launch it would resume, so it agrees with the switch, and changes nothing", async () => {
    const h = harness({ running: false, nextLaunch: { snapshotId: "snap-0", resumes: false, why: "has no resume token for this seat" } });
    expect(await h.svc.precheck(to("work", tokenFile()), h.seatRestart, h.claudeSeat)).toMatchObject({ safe: false, reasons: ["conversation_not_resumable"] });
    const ok = harness({ running: false });
    expect(await ok.svc.precheck(to("work", tokenFile()), ok.seatRestart, ok.claudeSeat)).toMatchObject({ safe: true });
    expect([...h.calls, ...ok.calls].filter((c) => c.startsWith("setTokenRef") || c.startsWith("relaunch") || c.startsWith("snapshot"))).toEqual([]);
  });

  it("a stopped seat's token file that wouldn't apply still stops it before anything changes", async () => {
    const h = harness({ running: false });
    const r = await h.svc.switchAccount(to("work", path.join(tmpdir(), "no-such-dir-claude-switch", "work.token")), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["token_file_unusable"] });
    expect(h.calls).toEqual(["exclusive node-a"]);
  });

  it("a second switch on the same seat waits for the first, then checks the seat again and relaunches with its own reference", async () => {
    const firstRelaunch = deferred();
    let relaunches = 0;
    const h = harness({ relaunch: async () => { if (++relaunches === 1) await firstRelaunch.promise; return RESUMED; } });
    const first = h.svc.switchAccount(to("alpha", tokenFile()), h.seatRestart, h.claudeSeat);
    const second = h.svc.switchAccount(to("beta", tokenFile()), h.seatRestart, h.claudeSeat);
    await settle();
    expect(h.calls.filter((call) => call.startsWith("relaunch"))).toEqual(["relaunch rig-1 dev.a snap-1 with alpha"]);
    expect(h.calls.filter((call) => call.startsWith("precedence"))).toHaveLength(1);
    firstRelaunch.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(h.calls.filter((call) => call.startsWith("relaunch"))).toEqual(["relaunch rig-1 dev.a snap-1 with alpha", "relaunch rig-1 dev.a snap-1 with beta"]);
    expect(h.calls.filter((call) => call.startsWith("precedence"))).toHaveLength(2);
    expect(a).toMatchObject({ outcome: "rebind_in_progress", seat: { account: "alpha" } });
    expect(b).toMatchObject({ outcome: "rebind_in_progress", seat: { account: "beta" } });
    expect(h.ref()?.label).toBe("beta");
  });

  it("a lease the seat can't give (its typing guard holds it) refuses before anything changes", async () => {
    const h = harness({ exclusive: async () => { throw Object.assign(new Error("Automatic input is paused for this seat."), { code: "typing_guard_enabled" }); } });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["typing_guard_enabled"], message: expect.stringContaining("Nothing changed") });
    expect(h.ref()).toBeNull();
  });

  it("precheck names the reference, whether its file would apply and what would outrank it, and changes nothing", async () => {
    const h = harness();
    const file = tokenFile();
    expect(await h.svc.precheck({ seat: SEAT, toAccount: "work", tokenFile: file }, h.seatRestart, h.claudeSeat)).toMatchObject({
      safe: true, claude: { label: "work", tokenFile: file, notChecked: CLEAR.notChecked } });
    expect(h.calls).toEqual(["precedence node-a"]);
    expect(h.ref()).toBeNull();
  });
});
