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
import { ACCOUNT_ANSWER, makeFakeCodex, rateLimitsAnswer } from "./helpers/fake-codex-usage.js";

const ASOF = "2026-10-13T15:00:00.000Z";

const seat = (seatSession: string, runtime: string): ProviderSeat => ({ seatSession, rigName: "r", runtime, lifecycleState: "running" });
const reg = (seat: string, runtime: string, authProfile: string) => ({ seat, rig: "r", runtime, cwd: "/w", authProfile, updatedTs: "2026-10-12T10:00:00Z" });

function input(over: Partial<SeatAccountsInput>): SeatAccountsInput {
  return { seats: [], auth: { profiles: [], seats: [] }, usage: [], codexHome: "/h/.codex", claudeConfigDir: undefined, home: "/h", ...over };
}

function claudeWindow(seatSession: string, resetsAt: string, disagreeing: string[] = []): UsageWindowRow {
  return {
    window: "five_hour", durationMins: 300, usedPercent: 40, remainingPercent: 60, resetsAt, observedAt: ASOF, seatSession,
    ...(disagreeing.length ? { disagreeingSeats: disagreeing.map((s) => ({ seatSession: s, usedPercent: 10, resetsAt: "2026-10-13T20:00:00Z", observedAt: ASOF })) } : {}),
    level: "ok", freshness: "fresh",
  };
}

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
    }));
    expect(rows[0]!.observed).toEqual({ windowsSampled: true, differsFrom: ["b@r"], note: expect.stringMatching(/^possibly a different login: .*not a verdict$/) });
    expect(rows[1]!.observed).toMatchObject({ windowsSampled: true, differsFrom: ["a@r"] });
    expect(rows[2]!.observed).toEqual({ windowsSampled: false });
    for (const row of rows) {
      expect(row.configured.source).toBe("default_login");
      expect(row.allowance.linked).toBe(false);
    }
  });

  it("equal resets never link: two seats reporting the same windows are just sampled, with no link and no difference", () => {
    const rows = configuredSeatAccounts(input({
      seats: [seat("a@r", "claude-code"), seat("b@r", "claude-code")],
      usage: [claudeRow([claudeWindow("a@r", "2026-10-13T18:00:00Z"), claudeWindow("b@r", "2026-10-13T18:00:00Z")])],
    }));
    for (const row of rows) {
      expect(row.observed).toEqual({ windowsSampled: true });
      expect(row.allowance.linked).toBe(false);
    }
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
    const rows = configuredSeatAccounts(input({ seats: [seat("a@r", "claude-code"), seat("a@r", "claude-code"), seat("b@r", "claude-code")], usage }));
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
