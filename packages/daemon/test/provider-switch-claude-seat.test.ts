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
  relaunch?: Relaunched | (() => Promise<Relaunched>);
  exclusive?: (fn: () => Promise<unknown>) => Promise<unknown>;
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
    // The seat's lifecycle lease: one holder at a time, in arrival order.
    exclusive: <T>(nodeId: string, fn: () => Promise<T>): Promise<T> => {
      calls.push(`exclusive ${nodeId}`);
      if (opts.exclusive) return opts.exclusive(fn) as Promise<T>;
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    },
    relaunchInPane: async (rigId, logicalId, snapshotId) => {
      calls.push(`relaunch ${rigId} ${logicalId} ${snapshotId} with ${ref ? ref.label : "no reference"}`);
      return typeof opts.relaunch === "function" ? opts.relaunch() : opts.relaunch ?? RESUMED;
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

  it("a relaunch refused before the seat was touched puts the reference back, and the seat keeps running as it was", async () => {
    const before = { label: "personal", tokenFile: tokenFile() };
    const h = harness({ ref: before, relaunch: { ok: false, effect: "none", code: "awaiting-decision", message: "Restore stopped for a decision." } });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["relaunch_awaiting_decision"], message: expect.stringContaining("keeps running as it was") });
    expect(h.ref()).toEqual(before);
  });

  it("a relaunch that ended the seat's process but didn't resume reads unknown, with the snapshot's recovery and the way back, and isn't retried", async () => {
    const h = harness({ relaunch: { ok: false, effect: "unknown", code: "failed", message: "The pane couldn't be respawned." } });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "unknown", reasons: ["relaunch_failed"], message: expect.stringContaining("may have been ended"), seat: {
      loginChanged: true, undo: `rig provider switch --seat ${SEAT} --stored-login`,
      restart: { recoveryCommand: "rig launch rig dev.a --snapshot-id snap-1", remainingStep: expect.stringContaining(`rig seat stop ${SEAT}`) } } });
    expect(r.message).not.toContain("keeps running");
    expect(h.calls.filter((call) => call.startsWith("relaunch"))).toHaveLength(1);
  });

  it("a relaunch that throws reads unknown, with the snapshot's recovery, instead of rejecting the switch", async () => {
    const h = harness({ relaunch: async () => { throw new Error("transport failure after the launch request"); } });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "unknown", reasons: ["relaunch_threw"], seat: { restart: { recoveryCommand: "rig launch rig dev.a --snapshot-id snap-1" } } });
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

  it("a stopped seat isn't relaunched: it says to launch it first, and nothing changes", async () => {
    const h = harness({ running: false });
    const r = await h.svc.switchAccount(to("work", tokenFile()), h.seatRestart, h.claudeSeat);
    expect(r).toMatchObject({ outcome: "failed_safely", reasons: ["seat_not_running"] });
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
