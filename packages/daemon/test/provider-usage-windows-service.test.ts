// Slice 01 (OPR.0.7.0.1) — usage windows through the provider service and routes: off by default
// with today's read model and route bodies unchanged; reads never start a native probe; only the
// refresh route reads natively.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { CodexUsageWindows } from "../src/domain/provider/codex-usage-windows.js";
import { codexUsageReader } from "../src/domain/provider/codex-usage-reader.js";
import { providerRoutes } from "../src/routes/provider.js";
import { ACCOUNT_ANSWER, makeFakeCodex, rateLimitsAnswer } from "./helpers/fake-codex-usage.js";

const ASOF = "2026-10-12T20:00:00.000Z";

function setup(opts: { enabled: boolean | (() => boolean); withWindows?: boolean }) {
  const fake = makeFakeCodex();
  fake.setPlan({ mode: "ok", account: ACCOUNT_ANSWER, rateLimits: rateLimitsAnswer({ secondaryUsed: 100 }) });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-svc-home-"));
  const windows = new CodexUsageWindows({
    now: () => ASOF,
    read: codexUsageReader({ launchPath: `${fake.binDir}${path.delimiter}${process.env.PATH}`, home, codexHome: fake.codexHome, deadlineMs: 5_000, graceMs: 200, now: () => ASOF }),
  });
  const enabled = typeof opts.enabled === "function" ? opts.enabled : () => opts.enabled as boolean;
  const base = { db: createFullTestDb(), listRigs: () => [], env: { CODEX_HOME: fake.codexHome } as NodeJS.ProcessEnv, now: () => ASOF };
  const svc = new ProviderServiceImpl({ ...base, ...(opts.withWindows === false ? {} : { usageWindows: { enabled, windows } }) });
  const mainSvc = new ProviderServiceImpl(base); // today's wiring: no usage windows at all
  const app = (s: ProviderServiceImpl) => {
    const a = new Hono();
    a.use("*", async (c, next) => { c.set("providerService" as never, s); await next(); });
    a.route("/api/provider", providerRoutes());
    return a;
  };
  return { fake, svc, mainSvc, app };
}

describe("usage windows: switch off is today's read model and routes", () => {
  it("getReadModel has no usage key and equals today's model", async () => {
    const { svc, mainSvc } = setup({ enabled: false });
    const model = await svc.getReadModel();
    expect(model).not.toHaveProperty("usage");
    expect(JSON.stringify(model)).toBe(JSON.stringify(await mainSvc.getReadModel()));
  });

  it("GET /api/provider/status and /usage bodies are byte-identical to today's", async () => {
    const { svc, mainSvc, app } = setup({ enabled: false });
    for (const route of ["/api/provider/status", "/api/provider/usage", "/api/provider/signals"]) {
      const [off, today] = await Promise.all([app(svc).request(route), app(mainSvc).request(route)]);
      expect(off.status).toBe(today.status);
      expect(await off.text(), route).toBe(await today.text());
    }
  });

  it("POST /usage/refresh refuses with 409 naming the key, and starts nothing", async () => {
    const { svc, fake, app } = setup({ enabled: false });
    const res = await app(svc).request("/api/provider/usage/refresh", { method: "POST", body: JSON.stringify({ provider: "codex" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "usage_windows_disabled", message: "Codex usage windows are off. Turn them on with: rig config set provider.usage_windows true" });
    expect(fake.spawns()).toBe(0);
  });

  it("a switch that throws reads as off", async () => {
    const { svc } = setup({ enabled: () => { throw new Error("unreadable settings"); } });
    expect(await svc.getReadModel()).not.toHaveProperty("usage");
  });
});

describe("usage windows: switch on", () => {
  it("getReadModel never starts a native read, however often it runs", async () => {
    const { svc, fake } = setup({ enabled: true });
    for (let i = 0; i < 5; i++) await svc.getReadModel();
    expect(fake.spawns()).toBe(0);
    expect((await svc.getReadModel()).usage).toEqual([expect.objectContaining({ identity: null, currentAvailability: "unknown" })]);
  });

  it("only the refresh route reads; its answer and the next status carry the reading (U2 exhausted)", async () => {
    const { svc, fake, app } = setup({ enabled: true });
    const res = await app(svc).request("/api/provider/usage/refresh", { method: "POST", body: JSON.stringify({ provider: "codex" }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { refresh: unknown; usage: Array<{ windows: Array<{ level: string; durationMins: number }> }> };
    expect(body.refresh).toEqual({ at: ASOF, outcome: "ok", coalesced: false });
    expect(body.usage[0]!.windows.find((w) => w.durationMins === 10080)!.level).toBe("exhausted");
    expect(fake.spawns()).toBe(1);
    const status = await (await app(svc).request("/api/provider/status")).json() as { usage: unknown };
    expect(status.usage).toEqual(body.usage);
    expect(fake.spawns()).toBe(1);
  });

  it("the usage and seatAccounts keys are added after today's keys; the rest of the model is unchanged", async () => {
    const { svc, mainSvc } = setup({ enabled: true });
    const model = await svc.getReadModel();
    expect(Object.keys(model).slice(-2)).toEqual(["usage", "seatAccounts"]);
    const { usage, seatAccounts, ...rest } = model;
    expect(usage).toBeDefined();
    expect(seatAccounts).toEqual([]);
    expect(JSON.stringify(rest)).toBe(JSON.stringify(await mainSvc.getReadModel()));
  });

  it("saved rig auth profiles: the rows say they weren't read, only when profiles exist", async () => {
    const { svc, fake } = setup({ enabled: true });
    expect((await svc.getReadModel()).usage![0]).not.toHaveProperty("savedProfiles");
    fs.mkdirSync(path.join(fake.codexHome, "auth-profiles"));
    for (const name of ["work", "personal"]) fs.writeFileSync(path.join(fake.codexHome, "auth-profiles", `${name}.json`), "{}");
    const usage = (await svc.getReadModel()).usage!;
    expect(usage.every((row) => JSON.stringify(row.savedProfiles) === JSON.stringify({
      names: ["personal", "work"],
      note: "saved rig auth profiles: not read (usage unknown); this reading is only the login active in the daemon's CODEX_HOME",
    }))).toBe(true);
  });

  it("refresh refuses a provider other than codex, and an unwired service is a 503", async () => {
    const { svc, app } = setup({ enabled: true });
    const res = await app(svc).request("/api/provider/usage/refresh", { method: "POST", body: JSON.stringify({ provider: "claude" }) });
    expect(res.status).toBe(400);
    const bare = new Hono();
    bare.route("/api/provider", providerRoutes());
    expect((await bare.request("/api/provider/usage/refresh", { method: "POST" })).status).toBe(503);
  });
});

describe("usage windows with the Claude reader alongside Codex", () => {
  async function both(enabled = true, withSamples = true) {
    const { ClaudeUsageWindows, latestClaudeWindowSamples } = await import("../src/domain/provider/claude-usage-windows.js");
    const { claudeAuthStatusReader } = await import("../src/domain/provider/claude-auth-status-reader.js");
    const { makeFakeClaude, CLAUDE_AUTH } = await import("./helpers/fake-claude-usage.js");
    const base = setup({ enabled });
    const fakeClaude = makeFakeClaude();
    fakeClaude.setPlan({ auth: [CLAUDE_AUTH] });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-svc-home-"));
    // All migrations, so usage_samples (062) exists as in a running daemon.
    const { createDb } = await import("../src/db/connection.js");
    const { migrate } = await import("../src/db/migrate.js");
    const { ALL_MIGRATIONS } = await import("../src/db/all-migrations.js");
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    if (withSamples) {
      // A Claude seat's status-line windows, as the context monitor records them (lane provider_window).
      const insert = db.prepare(`INSERT INTO usage_samples (lane, seat_session, source, sampled_at, captured_at, window, window_used_percent, resets_at)
        VALUES ('provider_window', 'dev@rig', 'claude_statusline_json', ?, ?, ?, ?, ?)`);
      const sampledAt = new Date(Date.parse(ASOF) - 60_000).toISOString();
      const later = (days: number) => new Date(Date.parse(ASOF) + days * 86_400_000).toISOString();
      insert.run(sampledAt, sampledAt, "five_hour", 20, later(0.1));
      insert.run(sampledAt, sampledAt, "weekly", 85, later(2));
    }
    const claude = new ClaudeUsageWindows({
      now: () => ASOF,
      readIdentity: claudeAuthStatusReader({ launchPath: `${fakeClaude.binDir}${path.delimiter}${process.env.PATH}`, home, claudeConfigDir: fakeClaude.configDir, now: () => ASOF }),
      listSamples: () => latestClaudeWindowSamples(db),
    });
    const codex = new CodexUsageWindows({
      now: () => ASOF,
      read: codexUsageReader({ launchPath: `${base.fake.binDir}${path.delimiter}${process.env.PATH}`, home, codexHome: base.fake.codexHome, deadlineMs: 5_000, graceMs: 200, now: () => ASOF }),
    });
    const svc = new ProviderServiceImpl({ db, listRigs: () => [], env: { CODEX_HOME: base.fake.codexHome } as NodeJS.ProcessEnv, now: () => ASOF,
      usageWindows: { enabled: () => enabled, windows: codex, claude } });
    return { ...base, svc, fakeClaude };
  }
  const post = (app: Hono, provider: string) => app.request("/api/provider/usage/refresh", { method: "POST", body: JSON.stringify({ provider }) });

  it("reads start nothing; rows are Codex's then Claude's; Claude's windows show before any refresh, its identity not read yet", async () => {
    const { svc, fake, fakeClaude } = await both();
    const usage = (await svc.getReadModel()).usage!;
    expect(usage.map((r) => [r.provider, r.identity === null ? null : (r.identity as { source: string }).source, r.source.kind, r.windows.length]))
      .toEqual([["codex", null, "codex_app_server", 0], ["claude", "unresolved", "claude_statusline_samples", 2]]);
    expect([fake.spawns(), fakeClaude.authCalls(), fakeClaude.otherStarts().length]).toEqual([0, 0, 0]);
    const none = await both(true, false);
    expect((await none.svc.getReadModel()).usage!.at(-1)).toMatchObject({ provider: "claude", identity: null, unavailableReason: "no Claude seat has reported status-line rate limits yet" });
  });

  it("a Claude refresh reads only Claude, answers with Claude's rows only, and the status carries them", async () => {
    const { svc, app, fake } = await both();
    const res = await post(app(svc), "claude");
    expect(res.status).toBe(200);
    const body = await res.json() as { refresh: { outcome: string }; usage: Array<{ provider: string; identity: { orgId: string }; windows: Array<{ window: string; level: string }> }> };
    expect(body.refresh).toMatchObject({ outcome: "ok", coalesced: false });
    expect(body.usage.map((r) => [r.provider, r.identity.orgId, r.windows.map((w) => `${w.window}:${w.level}`)])).toEqual([
      ["claude", "org-1", ["five_hour:ok", "weekly:nearing"]],
    ]);
    expect(fake.spawns()).toBe(0);
    const status = (await svc.getReadModel()).usage!;
    expect(status.map((r) => r.provider)).toEqual(["codex", "claude"]);
  }, 30_000);

  it("a Codex refresh answers with Codex rows only, as before", async () => {
    const { svc, app, fakeClaude } = await both();
    const body = await (await post(app(svc), "codex")).json() as { usage: Array<{ provider: string }> };
    expect(body.usage.map((r) => r.provider)).toEqual(["codex"]);
    expect(fakeClaude.authCalls()).toBe(0);
  });

  it("switch off: the Claude refresh is 409 naming the key; saved Codex profiles are noted on Codex rows only", async () => {
    const off = await both(false);
    const res = await post(off.app(off.svc), "claude");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "usage_windows_disabled", message: "Claude usage windows are off. Turn them on with: rig config set provider.usage_windows true" });
    const on = await both();
    fs.mkdirSync(path.join(on.fake.codexHome, "auth-profiles"));
    fs.writeFileSync(path.join(on.fake.codexHome, "auth-profiles", "work.json"), "{}");
    const usage = (await on.svc.getReadModel()).usage!;
    expect(usage.map((r) => [r.provider, r.savedProfiles?.names ?? null])).toEqual([["codex", ["work"]], ["claude", null]]);
  });

  it("an unknown provider is a 400; Claude on a service without its reader is a 400", async () => {
    const { svc, app } = await both();
    expect((await post(app(svc), "gemini")).status).toBe(400);
    const { svc: codexOnly, app: appOf } = setup({ enabled: true });
    expect((await post(appOf(codexOnly), "claude")).status).toBe(400);
  });
});
