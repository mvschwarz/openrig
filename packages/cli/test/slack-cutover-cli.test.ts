// S10 CUTOVER, CLI side — the relay runners are RETIRED and must refuse with teaching (never
// silently no-op, never run a second delivery path): successor replaces predecessor. The admin
// verbs (enable/disable) route to the daemon, where the seeding rule executes before the wire
// goes live. setup/status ride the daemon-homed config surface unchanged.
import { describe, it, expect } from "vitest";
import { slackCommand, type SlackDeps } from "../src/commands/slack.js";

function run(cmd: ReturnType<typeof slackCommand>, argv: string[]): Promise<void> {
  return cmd.parseAsync(["node", "slack", ...argv]).then(() => {});
}

function makeDeps(overrides: Partial<SlackDeps> = {}): { deps: SlackDeps; logs: string[]; posts: { path: string }[] } {
  const logs: string[] = [];
  const posts: { path: string }[] = [];
  const cfg = {
    enabled: false, inboundDestination: "operator-agent@kernel", alertTag: "founder-alert",
    outboundDestinations: [], sourceLabel: "vm", channel: "C1", requiredScopes: ["chat:write"],
    secretsEnvFile: null, queueUrl: null,
  };
  const deps: SlackDeps = {
    log: (m) => logs.push(m),
    surface: async () => ({
      loadConfig: () => ({ ...cfg }),
      saveConfig: () => "/tmp/slack-connector.json",
      staticReadiness: () => [],
      resolveSecret: () => null,
      checkEnvFilePermissions: () => null,
      verifyScopes: async () => ({ ok: true, granted: [], missing: [] }),
      verifyChannelMembership: async () => ({ ok: true, isMember: true }),
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
  it("`rig slack enable` POSTs /api/gateway/slack/enable and prints the honest online-status", async () => {
    const { deps, logs, posts } = makeDeps();
    await run(slackCommand(deps), ["enable"]);
    expect(posts.map((p) => p.path)).toEqual(["/api/gateway/slack/enable"]);
    expect(logs.join("\n")).toMatch(/ENABLED at enable-time: 2 pre-existing/);
  });

  it("`rig slack disable` POSTs /api/gateway/slack/disable", async () => {
    const { deps, posts } = makeDeps();
    await run(slackCommand(deps), ["disable"]);
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
  it("`rig slack status` renders readiness from the surface (and names the in-daemon path)", async () => {
    const { deps, logs } = makeDeps();
    await run(slackCommand(deps), ["status"]);
    expect(logs.join("\n")).toContain("IN-DAEMON");
  });
});
