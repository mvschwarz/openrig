import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { providerCommand } from "../src/commands/provider.js";
import { DaemonClient, DaemonTimeoutError } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

// Slice-04 (OPR.0.5.0.4) seam A — the `rig provider` CLI grammar, daemon-backed via DaemonClient
// (packet 3ffa3c22 §3). These prove the CLI reaches the real routes and its --json is stable and
// param-faithful; the routes/collection/switch composition are the B/C/D production seams.

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
    ...overrides,
  };
}
function runningState(port: number): DaemonState {
  return { pid: 123, port, db: "test.sqlite", startedAt: "2026-03-26T00:00:00Z" };
}
function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => (p === STATE_FILE ? JSON.stringify(runningState(port)) : null)),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}
async function run(args: string[], deps: StatusDeps): Promise<{ logs: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const origLog = console.log, origErr = console.error, origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    await providerCommand(deps).parseAsync(["node", "rig", ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const exitCode = process.exitCode;
  process.exitCode = origExit;
  return { logs, exitCode };
}

describe("rig provider CLI grammar (daemon-backed)", () => {
  let server: http.Server;
  let port: number;
  const seen: Array<{ url: string; method: string; body: string }> = [];

  const FOUR_BLOCK = {
    accounts: [{ accountId: "cdx-a", label: "Codex A", provider: "codex", authState: "active", profileRef: "p-a", asOf: "2026-08-03T12:00:00.000Z" }],
    bindings: [
      {
        accountId: null,
        seatSession: "seat-9",
        rigName: "r3",
        boundAt: null,
        bindingSource: null,
        anomalies: [{ kind: "seat_with_no_account", seat: "seat-9", evidence: "no bound account", asOf: "2026-08-03T12:00:00.000Z" }],
      },
    ],
    signals: [{ provider: "codex", accountRef: "cdx-a", sourceClass: "unknown", authority: "unknown", asOf: "2026-08-03T12:00:00.000Z", unknownReason: "codex_app_server_unavailable", automationUse: "do_not_automate" }],
    // S-C: the S-A host-usage rollup rows the status verb now renders (arrive via /status verbatim).
    hostUsage: [
      { host: "local", provider: "claude", state: "ok", windows: [{ window: "five_hour", usedPercent: 10, asOf: "2026-08-03T12:00:00.000Z", seatSession: "seat-c" }], provenance: { basis: "one_account_per_host_deployment_invariant", note: "host==account is a deployment invariant of this rig (one account per host); no account identity is read or emitted." }, anomalies: [], evidenceSeats: ["seat-c"], asOf: "2026-08-03T12:00:00.000Z" },
      { host: "local", provider: "codex", state: "limited", resetsAt: "2026-08-03T13:00:00.000Z", windows: [{ window: "primary", usedPercent: 100, resetsAt: "2026-08-03T13:00:00.000Z", asOf: "2026-08-03T12:00:00.000Z", seatSession: "seat-x" }], provenance: { basis: "one_account_per_host_deployment_invariant", note: "host==account is a deployment invariant of this rig (one account per host); no account identity is read or emitted." }, anomalies: [], evidenceSeats: ["seat-x"], asOf: "2026-08-03T12:00:00.000Z" },
      { host: "local", provider: "codex", state: "explicit_unknown", unknownReason: "codex profile present but no usage meter", windows: [], provenance: { basis: "one_account_per_host_deployment_invariant", note: "host==account is a deployment invariant of this rig (one account per host); no account identity is read or emitted." }, anomalies: [], evidenceSeats: [], asOf: "2026-08-03T12:00:00.000Z" },
      { host: "local", provider: "claude", state: "explicit_unknown", unknownReason: "conflicting seat windows falsify the one-account-per-host invariant", windows: [], provenance: { basis: "one_account_per_host_deployment_invariant", note: "host==account is a deployment invariant of this rig (one account per host); no account identity is read or emitted." }, anomalies: [{ kind: "conflicting_seat_windows", window: "five_hour", seats: ["a@rig", "b@rig"], evidence: "a=20% vs b=90% at same asOf", asOf: "2026-08-03T12:00:00.000Z" }], evidenceSeats: ["a@rig", "b@rig"], asOf: "2026-08-03T12:00:00.000Z" },
    ],
    asOf: "2026-08-03T12:00:00.000Z",
  };

  it.each([{ selector: ["--account-home", "/accounts/selected"] }, { selector: ["--clear-account-home"] }])("does not silently ignore an API-key selector combined with $selector", async ({ selector }) => {
    const before = seen.length;
    const result = await run(["switch", "--seat", "dev-a@rig", ...(selector.includes("--clear-account-home") ? [] : ["--to-account", "api"]), "--api-key-file", "/synthetic/key",
      ...selector, "--reason", "Integration test"], runningDeps(port));
    expect(result.exitCode).toBe(1);
    expect(seen.length).toBe(before);
  });

  it("switches to a selected account home without sending credential values", async () => {
    const result = await run(["switch", "--seat", "dev-a@rig", "--to-account", "api-account", "--account-home", "/accounts/api",
      "--reason", "Plan limit", "--model", "gpt-5.5", "--json"], runningDeps(port));
    expect(result.exitCode).toBeFalsy();
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ seat: "dev-a@rig", toAccount: "api-account", accountHome: "/accounts/api",
      reason: "Plan limit", model: "gpt-5.5", dryRun: false });
    expect(JSON.parse(result.logs.at(-1)!)).toMatchObject({ ok: true });
  });

  it("returns to configured defaults through an acknowledged read-only clear plan", async () => {
    const before = seen.length;
    const args = ["switch", "--seat", "dev-a@rig", "--clear-account-home", "--reason", "Plan reset"];
    const dry = await run([...args, "--dry-run", "--json"], runningDeps(port));
    expect(dry.exitCode).toBeFalsy();
    expect(JSON.parse(dry.logs[0]!)).toMatchObject({ accountHome: null, dryRun: true });
    expect(seen.slice(before).some(r => r.url === "/api/provider/switch")).toBe(false);
    const result = await run(args, runningDeps(port));
    expect(result.exitCode).toBeFalsy();
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ seat: "dev-a@rig", clearAccountHome: true, reason: "Plan reset", dryRun: false });
  });

  it("refuses a clear that an older daemon does not explicitly acknowledge", async () => {
    const before = seen.length;
    const result = await run(["switch", "--seat", "old-daemon@rig", "--clear-account-home", "--reason", "Plan reset", "--json"], runningDeps(port));
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.logs[0]!)).toMatchObject({ code: "account_home_switch_unavailable" });
    expect(seen.slice(before).some(r => r.url === "/api/provider/switch")).toBe(false);
  });

  it.each([{ selectors: ["--stored-login"] }, { selectors: ["--to-account", "other"] }, { selectors: ["--token-file", "/tokens/new"] }, { selectors: ["--account-home", "/accounts/new"] }])("refuses conflicting clear selectors $selectors before requesting a switch", async ({ selectors }) => {
    const before = seen.length;
    const result = await run(["switch", "--seat", "dev-a@rig", "--clear-account-home", "--reason", "Plan reset", ...selectors], runningDeps(port));
    expect(result.exitCode).toBe(1);
    expect(seen.length).toBe(before);
  });

  it("a clear without its reason names the required flag without asking for a conflicting account selector", async () => {
    const before = seen.length;
    const result = await run(["switch", "--seat", "dev-a@rig", "--clear-account-home"], runningDeps(port));
    expect(result.exitCode).toBe(1);
    expect(result.logs).toContain("Pass --reason with --clear-account-home.");
    expect(seen.length).toBe(before);
  });

  it("requires a reason before starting an account-home switch", async () => {
    const before = seen.length;
    const result = await run(["switch", "--seat", "dev-a@rig", "--to-account", "api-account", "--account-home", "/accounts/api"], runningDeps(port));
    expect(result.exitCode).toBe(1);
    expect(seen.length).toBe(before);
  });

  it("reports pending account-home recovery with its instruction instead of success", async () => {
    const result = await run(["switch", "--seat", "dev-a@rig", "--to-account", "recovery-pending", "--account-home", "/accounts/api",
      "--reason", "Plan limit"], runningDeps(port));
    expect(result.exitCode).toBe(1);
    expect(result.logs.join("\n")).toContain("Recovery is still pending");
    expect(result.logs.join("\n")).toContain("rig seat set-runtime dev-a@rig --recover");
    expect(result.logs.join("\n")).not.toContain("A fresh conversation carries the handover");
  });

  it("prints refusal recovery instructions even without warnings", async () => {
    const result = await run(["switch", "--seat", "dev-a@rig", "--to-account", "recovery-refused", "--account-home", "/accounts/api",
      "--reason", "Plan limit"], runningDeps(port));
    expect(result.exitCode).toBe(1);
    expect(result.logs).toContain("The staged successor could not be retired.");
    expect(result.logs).toContain("Run rig seat set-runtime dev-a@rig --recover.");
    expect(result.logs.join("\n")).not.toContain("A fresh conversation carries the handover");
  });

  it("shows account-home dry-run settings, cleared choices and costs without requesting a switch", async () => {
    const before = seen.length;
    const args = ["switch", "--seat", "dev-a@rig", "--to-account", "api-account", "--account-home", "/accounts/api",
      "--reason", "Plan limit", "--dry-run"];
    const result = await run(args, runningDeps(port));
    const output = result.logs.join("\n");
    expect(output).toContain("Nothing changed.");
    expect(output).toContain("model: gpt-5.5 (explicit)");
    expect(output).toContain("effort: none (native_default)");
    expect(output).toContain("Cleared from codex: Codex profile old-profile.");
    expect(output).toContain("A fresh conversation carries only the handover.");
    expect(result.exitCode).toBeFalsy();
    expect(seen.slice(before).some(request => request.url === "/api/provider/switch")).toBe(false);
    const json = JSON.parse((await run([...args, "--json"], runningDeps(port))).logs[0]!);
    expect(json).toMatchObject({ dryRun: true, settings: { model: { value: "gpt-5.5", source: "explicit" } },
      dropped: [{ setting: "Codex profile", value: "old-profile" }], costs: ["A fresh conversation carries only the handover."] });
  });

  it("sends only an API-key file reference through the existing switch and precheck endpoints", async () => {
    const args = ["--seat", "dev-a@rig", "--to-account", "cdx-a", "--api-key-file", "/synthetic/api-key", "--json"];
    await run(["switch", ...args], runningDeps(port));
    expect(JSON.parse(seen.at(-1)!.body)).toEqual({ seat: "dev-a@rig", toAccount: "cdx-a", apiKeyFile: "/synthetic/api-key", forceUnsafe: false });
    await run(["precheck", ...args], runningDeps(port));
    expect(new URL(seen.at(-1)!.url, "http://localhost").searchParams.get("apiKeyFile")).toBe("/synthetic/api-key");
    const before = seen.length;
    expect((await run(["switch", ...args, "--stored-login"], runningDeps(port))).exitCode).toBe(1);
    expect(seen.length).toBe(before);
  });

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      seen.push({ url: req.url ?? "", method: req.method ?? "", body });
      const send = (code: number, obj: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      const path = (req.url ?? "").split("?")[0];
      if (path?.startsWith("/api/seat/status/")) return send(200, { runtime: "codex" });
      if (path?.startsWith("/api/seat/set-runtime/")) {
        const request = JSON.parse(body);
        if (path.includes("old-daemon")) return send(200, { ok: true, dryRun: true });
        return send(200, { ok: true, dryRun: true, accountHome: request.clearAccountHome ? null : request.accountHome, from: "codex", to: "codex",
          settings: { model: { value: "gpt-5.5", source: "explicit" }, effort: { value: null, source: "native_default" } },
          dropped: [{ setting: "Codex profile", value: "old-profile" }], costs: ["A fresh conversation carries only the handover."],
          ...(request.tokenFile ? { accountToken: { label: request.accountLabel, tokenFile: request.tokenFile } } : {}) });
      }
      if (path === "/api/provider/status") return send(200, FOUR_BLOCK);
      if (path === "/api/provider/accounts") {
        if ((req.url ?? "").includes("provider=bad")) return send(404, { error: "unknown provider: bad" });
        return send(200, { accounts: FOUR_BLOCK.accounts });
      }
      if (path === "/api/provider/bindings") return send(200, { bindings: FOUR_BLOCK.bindings });
      if (path === "/api/provider/signals") return send(200, { signals: FOUR_BLOCK.signals });
      if (path === "/api/provider/precheck") return send(200, { safe: false, reasons: ["target_needs_reauth"] });
      if (path === "/api/provider/switch") {
        if (body.includes("bad")) return send(400, { error: "invalid target account" });
        if (JSON.parse(body).toAccount === "recovery-refused") return send(409, { ok: false, recoveryPending: true,
          message: "The staged successor could not be retired.", guidance: "Run rig seat set-runtime dev-a@rig --recover." });
        if (JSON.parse(body).toAccount === "recovery-pending") return send(200, { ok: true, changed: true,
          recoveryPending: true, warnings: ["Run rig seat set-runtime dev-a@rig --recover before retrying."] });
        if (JSON.parse(body).accountHome || JSON.parse(body).clearAccountHome) return send(200, { ok: true, changed: true, recoveryPending: false });
        return send(200, { outcome: "succeeded" });
      }
      return send(500, { error: "not found" });
    });
    await new Promise<void>((r) => server.listen(0, r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  it("status --json emits the four-block read model verbatim", async () => {
    const { logs, exitCode } = await run(["status", "--json"], runningDeps(port));
    expect(exitCode).toBeFalsy();
    const out = JSON.parse(logs.join("\n"));
    expect(out).toEqual(FOUR_BLOCK);
  });

  it("accounts --provider passes the filter as a query param and --json emits the block", async () => {
    seen.length = 0;
    const { logs } = await run(["accounts", "--provider", "codex", "--json"], runningDeps(port));
    expect(seen.some((r) => r.url.includes("/api/provider/accounts") && r.url.includes("provider=codex"))).toBe(true);
    expect(JSON.parse(logs.join("\n"))).toEqual({ accounts: FOUR_BLOCK.accounts });
  });

  it("precheck --seat --to-account passes params and --json emits the safety verdict", async () => {
    seen.length = 0;
    const { logs, exitCode } = await run(["precheck", "--seat", "s1", "--to-account", "cdx-b", "--json"], runningDeps(port));
    const req = seen.find((r) => r.url.includes("/api/provider/precheck"));
    expect(req).toBeDefined();
    expect(req!.url).toContain("seat=s1");
    expect(req!.url).toContain("toAccount=cdx-b");
    expect(JSON.parse(logs.join("\n"))).toEqual({ safe: false, reasons: ["target_needs_reauth"] });
    // an unsafe precheck exits nonzero so scripts can gate.
    expect(exitCode).toBe(1);
  });

  it("switch POSTs seat/to-account and --json emits the outcome", async () => {
    seen.length = 0;
    const { logs } = await run(["switch", "--seat", "s1", "--to-account", "cdx-b", "--json"], runningDeps(port));
    const req = seen.find((r) => r.url.includes("/api/provider/switch") && r.method === "POST");
    expect(req).toBeDefined();
    const sentBody = JSON.parse(req!.body);
    expect(sentBody).toMatchObject({ seat: "s1", toAccount: "cdx-b" });
    expect(JSON.parse(logs.join("\n"))).toEqual({ outcome: "succeeded" });
  });

  it("a 4xx on a read is an ERROR (prints daemon payload, exit 1) — never accepted as success", async () => {
    const { logs, exitCode } = await run(["accounts", "--provider", "bad", "--json"], runningDeps(port));
    expect(exitCode).toBe(1);
    expect(logs.join(" ")).toMatch(/unknown provider/i);
  });

  it("a 4xx on switch is an ERROR (prints payload, exit 1) — never outcome-undefined exit-0 success", async () => {
    const { logs, exitCode } = await run(["switch", "--seat", "s1", "--to-account", "bad", "--json"], runningDeps(port));
    expect(exitCode).toBe(1);
    expect(logs.join(" ")).toMatch(/invalid target/i);
  });

  it("status (human) renders the §3 projection: account rows, first-class anomaly flags, signal summary", async () => {
    const { logs } = await run(["status"], runningDeps(port));
    const out = logs.join("\n");
    expect(out).toContain("ACCOUNTS");
    expect(out).toContain("Codex A");
    expect(out).toContain("(codex)");
    expect(out).toContain("ANOMALIES");
    expect(out).toMatch(/seat with no bound account: seat-9/);
    expect(out).toMatch(/SIGNALS \(1;/); // freshest-signal summary
  });

  // ── S-C: host-usage rollup rendered on the EXISTING `provider status` verb (no new verb) ──
  it("S-C human: a HOST USAGE section renders the rollup rows (state / window granularity / resets_at)", async () => {
    const out = (await run(["status"], runningDeps(port))).logs.join("\n");
    expect(out).toContain("HOST USAGE");
    expect(out).toMatch(/claude\s+ok/);
    expect(out).toMatch(/codex\s+limited/);
    expect(out).toContain("2026-08-03T13:00:00.000Z"); // resets_at surfaced for the limited row
    expect(out).toMatch(/five_hour|primary/); // C3 window granularity present, never normalized away
  });

  it("S-C human: explicit_unknown renders as 'unknown' + reason — never blank, never ok", async () => {
    const out = (await run(["status"], runningDeps(port))).logs.join("\n");
    expect(out).toMatch(/codex\s+unknown/);
    expect(out).toContain("codex profile present but no usage meter");
  });

  it("S-C human: the conflict anomaly renders both-facts-visible (never a silent merge)", async () => {
    const out = (await run(["status"], runningDeps(port))).logs.join("\n");
    expect(out.toLowerCase()).toContain("conflict");
    expect(out).toContain("a@rig");
    expect(out).toContain("b@rig");
  });

  it("S-C human: the deployment-invariant provenance label is visible", async () => {
    const out = (await run(["status"], runningDeps(port))).logs.join("\n");
    expect(out.toLowerCase()).toMatch(/deployment invariant|one account per host/);
  });

  it("S-C PARITY: --json carries the SAME hostUsage rows the human render shows (values must ARRIVE)", async () => {
    const out = JSON.parse((await run(["status", "--json"], runningDeps(port))).logs.join("\n"));
    expect(out.hostUsage).toEqual(FOUR_BLOCK.hostUsage);
  });

  it("S-C BELT: the human status render emits NO account identifier at the CLI altitude", async () => {
    const out = (await run(["status"], runningDeps(port))).logs.join("\n");
    expect(out).not.toContain("cdx-a"); // the accounts-block id never leaks into the host-usage render
    expect(out).not.toContain("accountId");
    expect(out).not.toContain("accountRef");
  });

  it("reports honestly when the daemon is not running", async () => {
    const downDeps: StatusDeps = {
      lifecycleDeps: mockLifecycleDeps({ exists: vi.fn(() => false), fetch: vi.fn(async () => { throw new Error("refused"); }) }),
      clientFactory: (u) => new DaemonClient(u),
    };
    const { logs, exitCode } = await run(["status", "--json"], downDeps);
    expect(exitCode).toBe(1);
    expect(logs.join(" ")).toMatch(/not running/i);
  });
});

describe("rig provider switch --seat tells the person what follows", () => {
  function switchDeps(post: (path: string, body: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>): StatusDeps {
    return { ...runningDeps(1), clientFactory: () => ({ post }) as never };
  }

  it("waits as long as a seat restart does, and prints each peer's home and the restart a same-home peer needs", async () => {
    let timeoutMs: number | undefined;
    const deps = switchDeps(async (_path, _body, opts) => {
      timeoutMs = opts?.timeoutMs;
      return { status: 200, data: { outcome: "rebind_in_progress", seat: { home: "/h", account: "work", loginChanged: true, undo: "rig auth switch --codex-home /h before-switch-123", peers: [
        { logicalId: "dev.qa", sessionName: "dev-qa@rig", home: "same", effect: "Not restarted.", step: "rig seat restart dev-qa@rig --keep-conversation" },
        { logicalId: "dev.guard", sessionName: "dev-guard@rig", home: "different", effect: "Not restarted; uses a different Codex home." },
        { logicalId: "dev.pi", sessionName: null, home: "unknown", effect: "Not restarted; its Codex home could not be observed." },
      ] } } };
    });
    const { logs } = await run(["switch", "--seat", "s1", "--to-account", "work"], deps);
    expect(timeoutMs).toBe(120_000);
    expect(logs).toContain("to restore the home's saved credential bytes: rig auth switch --codex-home /h before-switch-123");
    expect(logs.join("\n")).toContain("undo restores saved credential bytes only; sign-in is unverified.");
    expect(logs.join("\n")).toContain("may expire, be revoked, or be superseded by refresh elsewhere");
    expect(logs.join("\n")).toContain("Restart the affected seat and use the existing account verification; fresh sign-in may be required.");
    expect(logs).toContain("peer on this home: dev-qa@rig: Not restarted.");
    expect(logs).toContain("  then: rig seat restart dev-qa@rig --keep-conversation");
    expect(logs).toContain("seat on another home: dev-guard@rig: Not restarted; uses a different Codex home.");
    expect(logs).toContain("seat, home unknown: dev.pi: Not restarted; its Codex home could not be observed.");
  });

  it("a CLI timeout reports the switch as unknown, with how to check it before running it again", async () => {
    const deps = switchDeps(async () => { throw new DaemonTimeoutError("timed out"); });
    const { logs, exitCode } = await run(["switch", "--seat", "s1", "--to-account", "work"], deps);
    expect(exitCode).toBe(1);
    expect(logs[0]).toBe("unknown: switch_outcome_unknown");
    expect(logs.join("\n")).toContain("rig seat restart s1 --keep-conversation --plan");
    // A switch still queued behind another on the home hasn't restarted anything, so an eligible plan isn't the end of it.
    expect(logs.join("\n")).toContain("queued behind another switch on the same Codex home");
    expect(logs.join("\n")).toMatch(/lastRestart that finished after \d{4}-\d{2}-\d{2}T/);
    expect(logs.join("\n")).toContain("don't run the switch again");
  });

  it("a Claude seat's switch prints a token that didn't take effect, the launch's warnings, and what to do after an unknown relaunch", async () => {
    const warning = "dev-a@rig: This seat's Claude subscription token (work) wasn't applied: the seat's pane shell can't run the token step.";
    const notApplied = switchDeps(async () => ({ status: 200, data: { outcome: "rebind_in_progress", message: "Relaunched dev-a@rig in its own pane.",
      seat: { account: "work", tokenFile: "/tokens/work", conversation: "conv-1", loginChanged: true, tokenApplied: false, warnings: [warning], undo: null, peers: [] } } }));
    const shown = (await run(["switch", "--seat", "dev-a@rig", "--to-account", "work", "--token-file", "/tokens/work"], notApplied)).logs;
    expect(shown).toContain(`Claude token: "work", read from /tokens/work (reference saved; the token didn't take effect)`);
    expect(shown).toContain(`warning: ${warning}`);
    const unknown = switchDeps(async () => ({ status: 200, data: { outcome: "unknown", reasons: ["relaunch_failed"], message: "Its process may have been ended.",
      seat: { account: "work", tokenFile: "/tokens/work", loginChanged: true, undo: null, peers: [],
        restart: { recoveryCommand: "rig launch rig dev.a --snapshot-id snap-1", remainingStep: "If the pane shows no running Claude, stop the seat first." } } } }));
    const after = await run(["switch", "--seat", "dev-a@rig", "--to-account", "work", "--token-file", "/tokens/work"], unknown);
    expect(after.exitCode).toBe(1);
    expect(after.logs).toContain("recovery: rig launch rig dev.a --snapshot-id snap-1");
    expect(after.logs).toContain("If the pane shows no running Claude, stop the seat first.");
  });
});
