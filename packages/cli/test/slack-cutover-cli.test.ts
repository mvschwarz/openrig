// S10 CUTOVER, CLI side — the relay runners are RETIRED and must refuse with teaching (never
// silently no-op, never run a second delivery path): successor replaces predecessor. The admin
// verbs (enable/disable) route to the daemon, where the seeding rule executes before the wire
// goes live. setup/status ride the daemon-homed config surface unchanged.
import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { slackCommand, type SlackDeps } from "../src/commands/slack.js";
import { buildSlackAppManifest, FEATURE_SCOPES, BASELINE_REQUIRED_SCOPES } from "@openrig/daemon/gateway-slack";
const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));

function run(cmd: ReturnType<typeof slackCommand>, argv: string[]): Promise<void> {
  return cmd.parseAsync(["node", "slack", ...argv]).then(() => {});
}

function makeDeps(overrides: Partial<SlackDeps> = {}): { deps: SlackDeps; logs: string[]; posts: { path: string }[] } {
  const logs: string[] = [];
  const posts: { path: string }[] = [];
  const cfg = {
    enabled: false, inboundDestination: "operator-agent@kernel",
    outboundDestinations: [], sourceLabel: "vm", channel: "C1", requiredScopes: ["chat:write"],
    secretsEnvFile: null, queueUrl: null, minimumLevelThatPosts: "NOTICE", minimumLevelThatInterrupts: "ALERT",
  };
  const deps: SlackDeps = {
    home: (() => { const home = mkdtempSync(join(tmpdir(), "slack-verb-")); homes.push(home); return home; })(),
    log: (m) => logs.push(m),
    surface: async () => ({
      loadConfig: () => ({ ...cfg }),
      saveConfig: () => "/tmp/slack-connector.json",
      staticReadiness: () => [],
      resolveSecret: () => null,
      checkEnvFilePermissions: () => null,
      verifyScopes: async () => ({ ok: true, granted: [], missing: [] }),
      verifyChannelMembership: async () => ({ ok: true, isMember: true }),
      buildSlackAppManifest, FEATURE_SCOPES, BASELINE_REQUIRED_SCOPES,
    }),
    clientFactory: () => ({
      post: async <T>(path: string) => {
        posts.push({ path });
        return { status: 200, data: { ok: true, seeded: 2, onlineStatus: "slack outbound ENABLED at enable-time: 2 pre-existing alert(s) seeded as history (not reposted); only alerts created after this point will deliver." } as T };
      },
    }),
    ...overrides,
  };
  return { deps, logs, posts };
}

describe("S10 CLI cutover — retired relay runners refuse with teaching", () => {
  it("`rig slack outbound` REFUSES (exit 1) and teaches the subsystem path — it does not sweep", async () => {
    const { deps, logs } = makeDeps();
    process.exitCode = 0;
    await run(slackCommand(deps), ["outbound"]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("retired");
    expect(out).toContain("IN-DAEMON");
    expect(out).toContain("rig slack status");
    process.exitCode = 0;
  });

  it("`rig slack inbound` REFUSES (exit 1) with the same teaching — it does not open a socket loop", async () => {
    const { deps, logs } = makeDeps();
    process.exitCode = 0;
    await run(slackCommand(deps), ["inbound"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("retired");
    process.exitCode = 0;
  });
});

describe("S10 CLI cutover — admin verbs route to the daemon", () => {
  it.each(["enable", "disable"])("%s reports an HTTP refusal without claiming the effect", async (verb) => {
    const { deps, logs } = makeDeps({ clientFactory: () => ({ post: async <T>() => ({ status: 503, data: { error: "gateway_admin_unavailable" } as T }) }) });
    await run(slackCommand(deps), [verb, "--reason", "fixture operation"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("HTTP 503");
    process.exitCode = 0;
  });
  it("refuses a shutdown without a reason before contacting the daemon", async () => {
    const { deps, posts } = makeDeps();
    const cmd = slackCommand(deps);
    cmd.commands.find((command) => command.name() === "disable")!.exitOverride();
    await expect(run(cmd, ["disable"])).rejects.toThrow(/reason/);
    expect(posts).toHaveLength(0);
  });

  it("records unavailable verification honestly with no credential value", async () => {
    const { deps } = makeDeps();
    await run(slackCommand(deps), ["verify", "--json"]);
    const rows = readFileSync(join(deps.home!, "state", "human-channel-operations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.at(-1)).toMatchObject({ action: "verify", effect: "observed", after: { ready: null }, provenance: "claimed:v1" });
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
  it("`rig slack enable` POSTs /api/gateway/slack/enable and prints the honest online-status", async () => {
    const { deps, logs, posts } = makeDeps();
    await run(slackCommand(deps), ["enable"]);
    expect(posts.map((p) => p.path)).toEqual(["/api/gateway/slack/enable"]);
    expect(logs.join("\n")).toMatch(/ENABLED at enable-time: 2 pre-existing/);
  });

  it("`rig slack disable` POSTs /api/gateway/slack/disable", async () => {
    const { deps, posts } = makeDeps();
    await run(slackCommand(deps), ["disable", "--reason", "maintenance"]);
    expect(posts.map((p) => p.path)).toEqual(["/api/gateway/slack/disable"]);
  });

  it("`rig slack enable` against a DOWN daemon fails VISIBLY (exit 1), never silently", async () => {
    const { deps, logs } = makeDeps({
      clientFactory: () => ({ post: async () => { throw new Error("daemon unreachable"); } }),
    });
    process.exitCode = 0;
    await run(slackCommand(deps), ["enable"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("enable failed");
    process.exitCode = 0;
  });
});

describe("S10 CLI cutover — config surfaces survive on the daemon-homed modules", () => {
  it("retires the legacy alert-tag setup knob", () => {
    const { deps } = makeDeps();
    const setup = slackCommand(deps).commands.find((command) => command.name() === "setup");
    expect(setup?.options.map((option) => option.long)).not.toContain("--alert-tag");
  });

  it("`rig slack status` renders readiness from the surface (and names the in-daemon path)", async () => {
    const { deps, logs } = makeDeps();
    await run(slackCommand(deps), ["status"]);
    expect(logs.join("\n")).toContain("IN-DAEMON");
  });
});


describe("Slack verify reports optional capabilities from granted scopes", () => {
  const cases = [
    { name: "baseline grants", grants: BASELINE_REQUIRED_SCOPES, ready: true, known: true },
    { name: "all feature grants", grants: [...BASELINE_REQUIRED_SCOPES, ...FEATURE_SCOPES.map(f => f.scope)], ready: true, known: true },
    { name: "absent grant header", grants: null, ready: false, known: false },
    { name: "empty grant header", grants: [], ready: false, known: false },
    { name: "failed authentication", grants: BASELINE_REQUIRED_SCOPES, ready: false, known: false, error: "invalid_auth" },
  ];
  for (const json of [false, true]) {
    it.each(cases)(`$name (${json ? "JSON" : "human"}) retains baseline readiness and shows only known missing features`, async ({ grants, ready, known, error }) => {
      const surface = await import("@openrig/daemon/gateway-slack");
      const home = mkdtempSync(join(tmpdir(), "slack-scopes-"));
      homes.push(home);
      surface.saveConfig({ ...surface.DEFAULT_CONFIG, channel: "C-fixture" }, home);
      vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-local-fixture-only");
      const requests: string[] = [];
      const server = createServer((request, response) => {
        const pathname = new URL(request.url!, "http://fixture").pathname;
        requests.push(`${request.method} ${pathname}`);
        response.setHeader("content-type", "application/json");
        if (grants !== null) response.setHeader("x-oauth-scopes", grants.join(", "));
        response.end(JSON.stringify(pathname === "/api/auth.test"
          ? error ? { ok: false, error } : { ok: true }
          : { ok: true, channel: { is_member: true, name: "fixture" } }));
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const port = (server.address() as { port: number }).port;
      const logs: string[] = [];
      process.exitCode = 0;
      try {
        await run(slackCommand({ home, log: message => logs.push(message), fetchImpl: (url, init) => {
          const target = new URL(url);
          expect(target.hostname).toBe("slack.com");
          return fetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init);
        } }), json ? ["verify", "--json"] : ["verify"]);
        expect(process.exitCode).toBe(ready ? 0 : 1);
        expect(requests).toEqual(["POST /api/auth.test", "GET /api/conversations.info"]);
        const missing = known ? FEATURE_SCOPES.filter(f => !grants!.includes(f.scope)) : null;
        if (json) {
          expect(JSON.parse(logs[0]!)).toMatchObject({ ready, missingFeatures: missing });
        } else {
          expect(logs.at(-1)).toBe(ready ? "READY" : "NOT ready");
          const warnings = logs.filter(line => line.startsWith("⚠"));
          expect(warnings).toHaveLength(missing?.length ?? 0);
          for (const feature of missing ?? []) expect(warnings.join("\n")).toContain(`${feature.scope} missing: ${feature.usedBy}`);
        }
        const receipts = readFileSync(join(home, "state", "human-channel-operations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(receipts.at(-1)).toMatchObject({ action: "verify", effect: "observed", after: { ready: error ? null : ready } });
      } finally {
        process.exitCode = 0;
        vi.unstubAllEnvs();
        server.close();
        await once(server, "close");
      }
    });
  }
});

describe("Slack status separates local configuration from bounded daemon observation", () => {
  it("retains local JSON fields and reports the observed socket and pending interval without Slack I/O", async () => {
    const get=vi.fn(async <T>(path:string,opts:unknown)=>{
      expect(path).toBe("/api/gateway/slack/status");expect(opts).toEqual({timeoutMs:900});
      return {status:200,data:{state:"active",connector:{configurationDigest:"observed-digest",inbound:{state:"connected",generation:2},recovery:{state:"incomplete",reason:"pass-budget"}}} as T};
    });
    const fetchImpl=vi.fn(async()=>{throw new Error("no Slack call");});
    const {deps,logs,posts}=makeDeps({fetchImpl,clientFactory:()=>({get,post:vi.fn()})});
    await run(slackCommand(deps),["status","--json"]);
    expect(JSON.parse(logs[0]!)).toMatchObject({config:{enabled:false},readiness:[],permWarning:null,next:null,
      observation:{state:"active",connector:{configurationDigest:"observed-digest",recovery:{state:"incomplete"}}}});
    expect(posts).toEqual([]);expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["offline","malformed","slow"])("keeps configuration and labels live state unknown when %s",async mode=>{
    vi.useFakeTimers();
    try {
      const get=vi.fn(async<T>()=>{if(mode==="offline")throw new Error("offline");if(mode==="slow")return new Promise<never>(()=>{});return {status:200,data:{unexpected:true} as T};});
      const {deps,logs}=makeDeps({clientFactory:()=>({get,post:vi.fn()})});
      const pass=run(slackCommand(deps),["status","--json"]);await vi.advanceTimersByTimeAsync(2000);await pass;
      expect(JSON.parse(logs[0]!)).toMatchObject({config:{channel:"C1"},observation:{state:"unknown",reason:"daemon-unavailable"}});
    } finally {vi.useRealTimers();}
  });
});


describe("Slack recovery status times", () => {
  it("renders scanned and pending bounds as ISO times while preserving JSON timestamps", async () => {
    const coverage = { coverageStart: "1000.000000", coveredThrough: "1005.000000",
      pending: { upper: "1010.000000", nextLatest: "1008.123456" }, nextRetryAt: 1_015_000 };
    const get = vi.fn(async <T>() => ({ status: 200, data: { state: "active", connector: {
      recovery: { state: "backoff", coverage, limits: ["Slack plan limit excludes older history"] },
    } } as T }));
    const { deps, logs } = makeDeps({ clientFactory: () => ({ get, post: vi.fn() }) });
    await run(slackCommand(deps), ["status"]);
    const text = logs.join("\n");
    expect(text).toContain("Available history scanned: [1970-01-01T00:16:40.000Z, 1970-01-01T00:16:45.000Z)");
    expect(text).toContain("Pending interval to 1970-01-01T00:16:50.000Z; next page before 1970-01-01T00:16:48.123Z");
    expect(text).toContain("Retry after: 1970-01-01T00:16:55.000Z");
    expect(text).toContain("Slack plan limit");
    logs.length = 0; await run(slackCommand(deps), ["status", "--json"]);
    expect(JSON.parse(logs[0]!).observation.connector.recovery.coverage).toEqual(coverage);
  });
});
