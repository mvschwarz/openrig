// Slice 01 (OPR.0.7.0.1) — each seat's CONFIGURED account in the provider read model, kept apart from observed
// allowances: registry, default login and unknown; a stale registry; a configuration-vs-observed difference; an
// unresolved allowance row kept and never linked; and, with provider.usage_windows off, today's model unchanged.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { CodexUsageWindows } from "../src/domain/provider/codex-usage-windows.js";
import { codexUsageReader } from "../src/domain/provider/codex-usage-reader.js";
import { configuredSeatAccounts, type SeatAccountsInput } from "../src/domain/provider/provider-seat-accounts.js";
import type { ProviderSeat } from "../src/domain/provider/provider-collect.js";
import type { ProviderUsageAllowance, UsageWindowRow } from "../src/domain/provider/provider-types.js";
import { ClaudeUsageWindows, latestClaudeWindowSamples, type ClaudeWindowSample } from "../src/domain/provider/claude-usage-windows.js";
import type { ClaudeAuthAnswer } from "../src/domain/provider/claude-auth-status-reader.js";
import type { UsageReadOutcome } from "../src/domain/provider/usage-windows.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { ACCOUNT_ANSWER, makeFakeCodex, rateLimitsAnswer } from "./helpers/fake-codex-usage.js";

const ASOF = "2026-10-13T15:00:00.000Z";

const seat = (seatSession: string, runtime: string): ProviderSeat => ({ seatSession, rigName: "r", runtime, lifecycleState: "running" });
const reg = (seat: string, runtime: string, authProfile: string) => ({ seat, rig: "r", runtime, cwd: "/w", authProfile, updatedTs: "2026-10-12T10:00:00Z" });

function input(over: Partial<SeatAccountsInput>): SeatAccountsInput {
  return { seats: [], auth: { profiles: [], seats: [] }, usage: [], claudeSamples: [], codexHome: "/h/.codex", claudeConfigDir: undefined, home: "/h", ...over };
}

function claudeWindow(seatSession: string, resetsAt: string, disagreeing: string[] = []): UsageWindowRow {
  return {
    window: "five_hour", durationMins: 300, usedPercent: 40, remainingPercent: 60, resetsAt, observedAt: ASOF, seatSession,
    ...(disagreeing.length ? { disagreeingSeats: disagreeing.map((s) => ({ seatSession: s, usedPercent: 10, resetsAt: "2026-10-13T20:00:00Z", observedAt: ASOF })) } : {}),
    level: "ok", freshness: "fresh",
  };
}

const sampleOf = (seatSession: string): ClaudeWindowSample =>
  ({ seatSession, window: "five_hour", usedPercent: 40, resetsAt: "2026-10-13T18:00:00Z", sampledAt: ASOF });

function claudeRow(windows: UsageWindowRow[], unresolved = false): ProviderUsageAllowance {
  return {
    provider: "claude",
    identity: unresolved
      ? { orgId: null, limitId: "claude", email: null, orgName: null, subscriptionType: null, source: "unresolved" }
      : { orgId: "org-1", limitId: "claude", email: "a@example.com", orgName: null, subscriptionType: "max", source: "claude auth status orgId and email" },
    source: { kind: "claude_statusline_samples", host: "local" }, observedAt: ASOF, seats: "unknown", windows,
    limitEvidence: null, latestFromSource: true, lastRefresh: null, currentAvailability: "known",
    ...(unresolved ? { unresolved: { note: "kept", keptReads: 1, droppedReads: 0 } } : {}),
  };
}

describe("configuredSeatAccounts — each state", () => {
  it("registry: a Codex seat with a row shows its profile, the row's time and that the profile is saved; never linked", () => {
    const [row] = configuredSeatAccounts(input({
      seats: [seat("dev-qa@r", "codex")],
      auth: { profiles: ["work-a"], seats: [reg("dev-qa@r", "codex", "work-a")] },
    }));
    expect(row).toEqual({
      seatSession: "dev-qa@r", rigName: "r", runtime: "codex",
      configured: { source: "registry", profileRef: "work-a", recordedAt: "2026-10-12T10:00:00Z", profileSaved: true },
      allowance: { linked: false, reason: expect.stringContaining("different kinds of fact") },
      observed: { note: "no per-seat observation for Codex" },
    });
  });

  it("registry naming a profile that isn't saved: shown, with the note; still configured, never dropped", () => {
    const [row] = configuredSeatAccounts(input({ seats: [seat("dev-qa@r", "codex")], auth: { profiles: [], seats: [reg("dev-qa@r", "codex", "gone")] } }));
    expect(row!.configured).toMatchObject({ source: "registry", profileRef: "gone", profileSaved: false });
    expect(row!.registryNotes).toEqual(["profile gone is not saved on this host"]);
  });

  it("a registry row whose runtime column isn't codex is named", () => {
    const [row] = configuredSeatAccounts(input({ seats: [seat("dev-qa@r", "codex")], auth: { profiles: ["a"], seats: [reg("dev-qa@r", "claude-code", "a")] } }));
    expect(row!.registryNotes).toEqual(["the registry row's runtime column says claude-code, not codex"]);
  });

  it("default login: a Codex seat with no row, and every Claude seat, name the daemon's home", () => {
    const rows = configuredSeatAccounts(input({ seats: [seat("dev-qa@r", "codex"), seat("dev-build@r", "claude-code")] }));
    expect(rows[0]!.configured).toEqual({ source: "default_login", home: "/h/.codex", homeNote: "the login active in the daemon's CODEX_HOME when this seat launched" });
    expect(rows[1]!.configured).toEqual({ source: "default_login", home: "/h/.claude", homeNote: "the login in the daemon's Claude config dir, shared by every Claude seat on this daemon" });
    for (const row of rows) expect(row.allowance).toEqual({ linked: false, reason: expect.stringContaining("active when it launched") });
  });

  it("Claude's config dir: an absolute CLAUDE_CONFIG_DIR is the home; a relative one is said to resolve per seat", () => {
    expect(configuredSeatAccounts(input({ seats: [seat("b@r", "claude-code")], claudeConfigDir: "/cfg" }))[0]!.configured).toMatchObject({ home: "/cfg" });
    expect(configuredSeatAccounts(input({ seats: [seat("b@r", "claude-code")], claudeConfigDir: "cfg" }))[0]!.configured)
      .toEqual({ source: "default_login", home: null, homeNote: "CLAUDE_CONFIG_DIR cfg is relative: it resolves against each seat's working directory" });
    expect(configuredSeatAccounts(input({ seats: [seat("b@r", "claude-code")], claudeConfigDir: "" }))[0]!.configured)
      .toEqual({ source: "default_login", home: null, homeNote: "CLAUDE_CONFIG_DIR is set but empty: it resolves to each seat's working directory" });
  });

  it("unknown: any other runtime says so, with nothing invented", () => {
    const [row] = configuredSeatAccounts(input({ seats: [seat("t@r", "terminal")] }));
    expect(row).toEqual({
      seatSession: "t@r", rigName: "r", runtime: "terminal",
      configured: { source: "unknown", reason: "no account configuration is known for runtime terminal" },
      allowance: { linked: false, reason: "no configured account" },
    });
  });

  it("a stale registry after a runtime change: the row is named, not applied; the seat reads as its runtime's default", () => {
    const [row] = configuredSeatAccounts(input({ seats: [seat("dev-qa@r", "claude-code")], auth: { profiles: ["work-a"], seats: [reg("dev-qa@r", "codex", "work-a")] } }));
    expect(row!.configured).toMatchObject({ source: "default_login" });
    expect(row!.registryNotes).toEqual(["stale registry row: names profile work-a (recorded 2026-10-12T10:00:00Z) for runtime codex; not applied: this seat now runs claude-code"]);
  });

  it("configuration vs observed: a Claude seat whose samples disagree with another's is labelled possibly a different login, both ways", () => {
    const rows = configuredSeatAccounts(input({
      seats: [seat("a@r", "claude-code"), seat("b@r", "claude-code"), seat("c@r", "claude-code")],
      usage: [claudeRow([claudeWindow("a@r", "2026-10-13T18:00:00Z", ["b@r"])])],
      claudeSamples: [sampleOf("a@r"), sampleOf("b@r")],
    }));
    expect(rows[0]!.observed).toEqual({ windowsSampled: true, lastSampledAt: ASOF, differsFrom: ["b@r"], note: expect.stringMatching(/^possibly a different login: .*not a verdict$/) });
    expect(rows[1]!.observed).toMatchObject({ windowsSampled: true, differsFrom: ["a@r"] });
    expect(rows[2]!.observed).toEqual({ windowsSampled: false });
    for (const row of rows) {
      expect(row.configured.source).toBe("default_login");
      expect(row.allowance.linked).toBe(false);
    }
  });

  it("lastSampledAt is the seat's newest sample across its windows, whatever their order", () => {
    const older = { ...sampleOf("a@r"), window: "weekly" as const, sampledAt: "2026-10-13T14:00:00.000Z" };
    for (const claudeSamples of [[older, sampleOf("a@r")], [sampleOf("a@r"), older]]) {
      const [row] = configuredSeatAccounts(input({ seats: [seat("a@r", "claude-code")], claudeSamples }));
      expect(row!.observed).toEqual({ windowsSampled: true, lastSampledAt: ASOF });
    }
  });

  it("samples not available to the read: no claim either way, said so", () => {
    const [row] = configuredSeatAccounts(input({ seats: [seat("a@r", "claude-code")], claudeSamples: null }));
    expect(row!.observed).toEqual({ note: "status-line samples were not available to this read" });
  });

  it("an unresolved allowance row is read for observations only and never linked or changed", () => {
    const usage = [claudeRow([claudeWindow("a@r", "2026-10-13T18:00:00Z")], true)];
    const before = JSON.stringify(usage);
    const [row] = configuredSeatAccounts(input({ seats: [seat("a@r", "claude-code")], usage }));
    expect(row!.allowance.linked).toBe(false);
    expect(JSON.stringify(usage)).toBe(before);
  });

  it("a registry row naming another rig is still applied, as bindings[] applies it, and noted", () => {
    const [row] = configuredSeatAccounts(input({
      seats: [seat("dev-qa@r", "codex")],
      auth: { profiles: ["work-a"], seats: [{ ...reg("dev-qa@r", "codex", "work-a"), rig: "other" }] },
    }));
    expect(row!.configured).toEqual({ source: "registry", profileRef: "work-a", recordedAt: "2026-10-12T10:00:00Z", profileSaved: true });
    expect(row!.registryNotes).toEqual(["registry row names rig other; this seat is in rig r"]);
  });

  it("two Claude seats with the same session name and rig: observations withheld, never attributed", () => {
    const usage = [claudeRow([claudeWindow("a@r", "2026-10-13T18:00:00Z", ["b@r"])])];
    const rows = configuredSeatAccounts(input({ seats: [seat("a@r", "claude-code"), seat("a@r", "claude-code"), seat("b@r", "claude-code")], usage, claudeSamples: [sampleOf("a@r"), sampleOf("b@r")] }));
    const withheld = {
      withheld: true,
      note: "observation withheld: 2 seats share session name a@r; status-line samples are keyed by session name and cannot be attributed to one seat",
    };
    expect(rows[0]!.observed).toEqual(withheld);
    expect(rows[1]!.observed).toEqual(withheld);
    expect(rows[2]!.observed).toMatchObject({ windowsSampled: true });
  });

  it("two Codex seats with the same session name and rig and a registry row: applied to both, with a note that it can't tell them apart", () => {
    const rows = configuredSeatAccounts(input({
      seats: [seat("dev-qa@r", "codex"), seat("dev-qa@r", "codex")],
      auth: { profiles: ["work-a"], seats: [reg("dev-qa@r", "codex", "work-a")] },
    }));
    for (const row of rows) {
      expect(row.configured).toMatchObject({ source: "registry", profileRef: "work-a" });
      expect(row.registryNotes).toEqual(["2 seats share session name dev-qa@r; the seat-keyed registry row cannot tell them apart"]);
    }
    // A default login stays true for both, so no note without a row.
    const plain = configuredSeatAccounts(input({ seats: [seat("x@r", "codex"), seat("x@r", "codex")] }));
    for (const row of plain) expect(row.registryNotes).toBeUndefined();
  });
});

/** Seed live seats (rig + pod + node + running session) into node-inventory. */
function seedSeats(db: Database.Database, seats: Array<{ id: string; session: string; runtime: string }>) {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r");
  db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-1", "rig-1", "dev", "Dev");
  for (const s of seats) {
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id) VALUES (?, ?, ?, ?, ?, ?)").run(s.id, "rig-1", `dev.${s.id}`, s.runtime, "/w", "pod-1");
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)").run(`sess-${s.id}`, s.id, s.session, "running", "ready");
    db.prepare("INSERT OR REPLACE INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)").run(`bind-${s.id}`, s.id, s.session);
  }
}

/** Every path under a dir with its size and mtime: a write anywhere shows as a difference. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      out.push(`${path.relative(dir, p)} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

describe("seatAccounts through the provider service", () => {
  function setup(enabled: boolean) {
    const fake = makeFakeCodex();
    fake.setPlan({ mode: "ok", account: ACCOUNT_ANSWER, rateLimits: rateLimitsAnswer({ secondaryUsed: 10 }) });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounts-home-"));
    // Registry metadata and a saved profile. The profile can't be opened (mode 000): only its name may be read.
    fs.mkdirSync(path.join(fake.codexHome, "auth-profiles"), { recursive: true });
    fs.writeFileSync(path.join(fake.codexHome, "auth-profiles", "work-a.json"), "{\"tokens\":\"never read\"}", { mode: 0o000 });
    fs.writeFileSync(path.join(fake.codexHome, "auth-seat-registry.tsv"),
      "seat\trig\truntime\tcwd\tauth_profile\tupdated_ts\ndev-qa@r\tr\tcodex\t/w\twork-a\t2026-10-12T10:00:00Z\ndev-old@r\tr\tcodex\t/w\twork-a\t2026-10-01T10:00:00Z\n", { mode: 0o600 });
    const db = createFullTestDb();
    seedSeats(db, [
      { id: "qa", session: "dev-qa@r", runtime: "codex" },
      { id: "cx", session: "dev-cx@r", runtime: "codex" },
      { id: "build", session: "dev-build@r", runtime: "claude-code" },
      { id: "old", session: "dev-old@r", runtime: "claude-code" },
    ]);
    const env = { CODEX_HOME: fake.codexHome, HOME: home } as NodeJS.ProcessEnv;
    const windows = new CodexUsageWindows({
      now: () => ASOF,
      read: codexUsageReader({ launchPath: `${fake.binDir}${path.delimiter}${process.env.PATH}`, home, codexHome: fake.codexHome, deadlineMs: 5_000, graceMs: 200, now: () => ASOF }),
    });
    const base = { db, listRigs: () => [{ id: "rig-1" }], env, now: () => ASOF };
    const svc = new ProviderServiceImpl({ ...base, usageWindows: { enabled: () => enabled, windows } });
    const mainSvc = new ProviderServiceImpl(base);
    return { fake, svc, mainSvc, home };
  }

  it("switch off: no seatAccounts, and the read model is today's byte for byte", async () => {
    const { svc, mainSvc } = setup(false);
    const model = await svc.getReadModel();
    expect(model).not.toHaveProperty("seatAccounts");
    expect(JSON.stringify(model)).toBe(JSON.stringify(await mainSvc.getReadModel()));
  });

  it("switch on: every live seat with its configured account and source; bindings and usage rows unchanged", async () => {
    const { svc, mainSvc, fake } = setup(true);
    const model = await svc.getReadModel();
    const bySeat = new Map(model.seatAccounts!.map((row) => [row.seatSession, row]));
    expect([...bySeat.keys()].sort()).toEqual(["dev-build@r", "dev-cx@r", "dev-old@r", "dev-qa@r"]);
    expect(bySeat.get("dev-qa@r")!.configured).toEqual({ source: "registry", profileRef: "work-a", recordedAt: "2026-10-12T10:00:00Z", profileSaved: true });
    expect(bySeat.get("dev-cx@r")!.configured).toMatchObject({ source: "default_login", home: fake.codexHome });
    expect(bySeat.get("dev-build@r")!.configured).toMatchObject({ source: "default_login", home: expect.stringMatching(/seat-accounts-home-.*\/\.claude$/) });
    expect(bySeat.get("dev-old@r")!.registryNotes![0]).toMatch(/^stale registry row: names profile work-a .* this seat now runs claude-code$/);
    // The existing blocks are as before: bindings[] as main, usage rows still seats: "unknown".
    expect(model.bindings).toEqual((await mainSvc.getReadModel()).bindings);
    for (const row of model.usage!) expect(row.seats).toBe("unknown");
  });

  it("switch on: reads start no native probe and write nothing under the homes", async () => {
    const { svc, fake, home } = setup(true);
    const before = [tree(fake.codexHome), tree(home)];
    for (let i = 0; i < 3; i++) await svc.getReadModel();
    expect(fake.spawns()).toBe(0);
    expect([tree(fake.codexHome), tree(home)]).toEqual(before);
  });
});

// Review round 1: each finding through the production composition: real migrated SQLite samples →
// latestClaudeWindowSamples → ClaudeUsageWindows → ProviderServiceImpl. Identity answers are inert fixtures.
describe("seatAccounts on the production path (samples, registry reads, config dir)", () => {
  const minutes = (m: number) => new Date(Date.parse(ASOF) + m * 60_000).toISOString();
  const RESET = minutes(180);

  function prod(opts: { seats: Array<{ id: string; session: string; runtime: string }>; registry?: { body: string; mode: number }; profiles?: { names: string[]; folderMode: number }; env?: Record<string, string> }) {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    seedSeats(db, opts.seats);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounts-prod-home-"));
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "seat-accounts-prod-codex-"));
    if (opts.registry) fs.writeFileSync(path.join(codexHome, "auth-seat-registry.tsv"), opts.registry.body, { mode: opts.registry.mode });
    const profileDir = path.join(codexHome, "auth-profiles");
    if (opts.profiles) {
      fs.mkdirSync(profileDir);
      for (const name of opts.profiles.names) fs.writeFileSync(path.join(profileDir, `${name}.json`), "{\"tokens\":\"never read\"}", { mode: 0o600 });
      fs.chmodSync(profileDir, opts.profiles.folderMode);
    }
    let clock = ASOF;
    let org = "org-1";
    const insert = db.prepare(`INSERT INTO usage_samples (lane, seat_session, source, sampled_at, captured_at, window, window_used_percent, resets_at)
      VALUES ('provider_window', ?, 'claude_statusline_json', ?, ?, ?, ?, ?)`);
    const sample = (seatSession: string, sampledAt: string, resetsAt: string, used = 40) => {
      for (const window of ["five_hour", "weekly"]) insert.run(seatSession, sampledAt, sampledAt, window, used, resetsAt);
    };
    const claude = new ClaudeUsageWindows({
      now: () => clock,
      readIdentity: async (): Promise<UsageReadOutcome<ClaudeAuthAnswer>> => ({ ok: true, observedAt: clock,
        auth: { loggedIn: true, authMethod: "claude.ai", email: "d***@example.test", orgId: org, orgName: "Example Org", subscriptionType: "team" } as ClaudeAuthAnswer["auth"] }),
      listSamples: () => latestClaudeWindowSamples(db),
    });
    const windows = new CodexUsageWindows({ now: () => clock, read: async () => { throw new Error("a read never starts the Codex reader"); } });
    const svc = new ProviderServiceImpl({ db, listRigs: () => [{ id: "rig-1" }], now: () => clock,
      env: { CODEX_HOME: codexHome, HOME: home, ...opts.env } as NodeJS.ProcessEnv,
      usageWindows: { enabled: () => true, windows, claude } });
    const bySeat = async () => new Map((await svc.getReadModel()).seatAccounts!.map((row) => [row.seatSession, row]));
    return { svc, claude, sample, bySeat, home, profileDir, setClock: (t: string) => { clock = t; }, setOrg: (o: string) => { org = o; } };
  }
  const claudeSeats = [
    { id: "a", session: "a@r", runtime: "claude-code" },
    { id: "b", session: "b@r", runtime: "claude-code" },
    { id: "c", session: "c@r", runtime: "claude-code" },
  ];

  it("F1: a fresh seat whose sample isn't the one shown is still sampled; only a seat with no sample reads as none yet", async () => {
    const p = prod({ seats: claudeSeats });
    p.sample("a@r", minutes(-1 / 60), RESET);
    p.sample("b@r", minutes(-2 / 60), RESET);
    const rows = await p.bySeat();
    // The served window keeps one sample per window: A's. B is not in it, but B did report.
    const shown = (await p.svc.getReadModel()).usage!.find((r) => r.provider === "claude")!.windows.map((w) => w.seatSession);
    expect(shown).toEqual(["a@r", "a@r"]);
    expect(rows.get("a@r")!.observed).toEqual({ windowsSampled: true, lastSampledAt: minutes(-1 / 60) });
    expect(rows.get("b@r")!.observed).toEqual({ windowsSampled: true, lastSampledAt: minutes(-2 / 60) });
    expect(rows.get("c@r")!.observed).toEqual({ windowsSampled: false });
  });

  it("an old sample: still sampled, with its own time, so the seat never reads as reporting now", async () => {
    const p = prod({ seats: claudeSeats.slice(0, 2) });
    p.sample("a@r", minutes(-1), RESET);
    p.sample("b@r", minutes(-21 * 1440), minutes(-20 * 1440));
    const rows = await p.bySeat();
    expect(rows.get("b@r")!.observed).toEqual({ windowsSampled: true, lastSampledAt: minutes(-21 * 1440) });
    expect(rows.get("a@r")!.observed).toEqual({ windowsSampled: true, lastSampledAt: minutes(-1) });
  });

  it("F2: a repaired disagreement: the earlier divergent row is history, and SEATS shows no current difference", async () => {
    const p = prod({ seats: claudeSeats });
    p.setClock(minutes(-10));
    p.sample("a@r", minutes(-10.5), RESET);
    p.sample("b@r", minutes(-10.6), minutes(300));
    await p.claude.refresh();
    p.setClock(ASOF);
    p.sample("a@r", minutes(-0.5), RESET);
    p.sample("b@r", minutes(-0.6), RESET);
    p.setOrg("org-2");
    await p.claude.refresh();
    const usage = (await p.svc.getReadModel()).usage!.filter((r) => r.provider === "claude");
    // The history still shows the old disagreement, labelled earlier; the current row has none.
    expect(usage.map((r) => [r.latestFromSource, r.windows.some((w) => (w.disagreeingSeats ?? []).length > 0)])).toEqual([[true, false], [false, true]]);
    const rows = await p.bySeat();
    expect(rows.get("a@r")!.observed).toEqual({ windowsSampled: true, lastSampledAt: minutes(-0.5) });
    expect(rows.get("b@r")!.observed).toEqual({ windowsSampled: true, lastSampledAt: minutes(-0.6) });
  });

  const codexSeats = [{ id: "qa", session: "dev-qa@r", runtime: "codex" }, { id: "cx", session: "dev-cx@r", runtime: "codex" }];
  const HEADER = "seat\trig\truntime\tcwd\tauth_profile\tupdated_ts\n";
  const ROW = "dev-cx@r\tr\tcodex\t/w\tsaved-work\t2026-10-12T10:00:00Z\n";

  it.skipIf(process.getuid?.() === 0)("F3: an unreadable registry: each Codex seat without a parsed row is unknown, with the error code", async () => {
    const p = prod({ seats: codexSeats, registry: { body: HEADER + ROW, mode: 0o000 } });
    const rows = await p.bySeat();
    for (const seat of ["dev-qa@r", "dev-cx@r"]) {
      expect(rows.get(seat)!.configured).toEqual({ source: "unknown", reason: "the seat registry exists but couldn't be read (EACCES)" });
    }
  });

  it("F3: malformed rows: a Codex seat without a parsed row is unknown, with the count; a parsed row still applies", async () => {
    const p = prod({ seats: codexSeats, registry: { body: HEADER + "dev-qa@r\tr\tcodex\n" + ROW, mode: 0o600 } });
    const rows = await p.bySeat();
    expect(rows.get("dev-qa@r")!.configured).toEqual({ source: "unknown", reason: "the registry has 1 malformed row; this seat may be among them" });
    expect(rows.get("dev-cx@r")!.configured).toMatchObject({ source: "registry", profileRef: "saved-work" });
  });

  it.skipIf(process.getuid?.() === 0)("an unreadable profile folder: whether the profile is saved can't be told (null), never 'not saved'", async () => {
    const p = prod({ seats: codexSeats, registry: { body: HEADER + ROW, mode: 0o600 }, profiles: { names: ["saved-work"], folderMode: 0o000 } });
    try {
      const model = await p.svc.getReadModel();
      const row = model.seatAccounts!.find((r) => r.seatSession === "dev-cx@r")!;
      expect(row.configured).toEqual({ source: "registry", profileRef: "saved-work", recordedAt: "2026-10-12T10:00:00Z", profileSaved: null });
      expect(row.registryNotes).toEqual(["can't tell whether profile saved-work is saved on this host: the profile folder couldn't be read (EACCES)"]);
      expect(JSON.stringify(model)).not.toContain("not saved");
      // The existing blocks read the folder as before: no profiles, so no accounts and no savedProfiles.
      expect(model.accounts).toEqual([]);
      for (const usage of model.usage!) expect(usage).not.toHaveProperty("savedProfiles");
    } finally {
      fs.chmodSync(p.profileDir, 0o700);
    }
  });

  it("an absent profile folder is a supported absence: the profile is not saved", async () => {
    const p = prod({ seats: codexSeats, registry: { body: HEADER + ROW, mode: 0o600 } });
    const row = (await p.bySeat()).get("dev-cx@r")!;
    expect(row.configured).toMatchObject({ source: "registry", profileSaved: false });
    expect(row.registryNotes).toEqual(["profile saved-work is not saved on this host"]);
  });

  it("F3: an absent registry is a supported absence: default login", async () => {
    const p = prod({ seats: codexSeats });
    const rows = await p.bySeat();
    for (const seat of ["dev-qa@r", "dev-cx@r"]) expect(rows.get(seat)!.configured).toMatchObject({ source: "default_login" });
  });

  it("F4: an empty CLAUDE_CONFIG_DIR resolves per seat, as the launch resolver does, never to HOME/.claude", async () => {
    const p = prod({ seats: claudeSeats.slice(0, 2), env: { CLAUDE_CONFIG_DIR: "" } });
    const rows = await p.bySeat();
    for (const seat of ["a@r", "b@r"]) {
      expect(rows.get(seat)!.configured).toEqual({ source: "default_login", home: null, homeNote: "CLAUDE_CONFIG_DIR is set but empty: it resolves to each seat's working directory" });
    }
  });
});
