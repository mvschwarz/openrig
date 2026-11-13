// OPR.0.6.0.5 — `rig slack manifest` is offline: it runs on the real lazily-imported daemon
// surface with no daemon client, no tokens and no network.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { slackCommand, type SlackDeps } from "../src/commands/slack.js";
import { buildSlackAppManifest, FEATURE_SCOPES, BASELINE_REQUIRED_SCOPES } from "@openrig/daemon/gateway-slack";

const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function offline(overrides: Partial<SlackDeps> = {}): { deps: SlackDeps; logs: string[] } {
  const logs: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "slack-manifest-")); homes.push(home);
  return {
    logs,
    deps: {
      home,
      log: (m) => logs.push(m),
      clientFactory: () => { throw new Error("manifest must not contact the daemon"); },
      fetchImpl: async () => { throw new Error("manifest must not use the network"); },
      ...overrides,
    },
  };
}
const run = (deps: SlackDeps, argv: string[]) => slackCommand(deps).parseAsync(["node", "slack", ...argv]);
const runWithExitOverride = (deps: SlackDeps, argv: string[]) => {
  const command = slackCommand(deps);
  command.exitOverride();
  command.commands.find((candidate) => candidate.name() === "manifest")!.exitOverride();
  return command.parseAsync(["node", "slack", ...argv]);
};

const PUBLIC_MANIFEST = {
  display_information: {
    name: "OpenRig",
    description: "Connects an OpenRig instance to Slack over Socket Mode.",
  },
  features: { bot_user: { display_name: "OpenRig", always_online: false } },
  oauth_config: { scopes: { bot: [
    "app_mentions:read", "channels:history", "channels:read", "chat:write",
    "files:read", "files:write", "reactions:read", "users:read",
  ] } },
  settings: {
    event_subscriptions: { bot_events: ["app_mention", "message.channels", "reaction_added"] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};
const PUBLIC_SCOPES = [
  "app_mentions:read", "channels:history", "channels:read", "chat:write",
  "files:read", "files:write", "reactions:read", "users:read",
];
const PUBLIC_EVENTS = ["app_mention", "message.channels", "reaction_added"];
const PUBLIC_MANIFEST_YAML = [
  "display_information:",
  "  name: OpenRig",
  "  description: Connects an OpenRig instance to Slack over Socket Mode.",
  "features:",
  "  bot_user:",
  "    display_name: OpenRig",
  "    always_online: false",
  "oauth_config:",
  "  scopes:",
  "    bot:",
  "      - app_mentions:read",
  "      - channels:history",
  "      - channels:read",
  "      - chat:write",
  "      - files:read",
  "      - files:write",
  "      - reactions:read",
  "      - users:read",
  "settings:",
  "  event_subscriptions:",
  "    bot_events:",
  "      - app_mention",
  "      - message.channels",
  "      - reaction_added",
  "  interactivity:",
  "    is_enabled: true",
  "  org_deploy_enabled: false",
  "  socket_mode_enabled: true",
  "  token_rotation_enabled: false",
].join("\n") + "\n";
const PUBLIC_MANIFEST_URL = "https://api.slack.com/apps?new_app=1&manifest_yaml=" + encodeURIComponent(PUBLIC_MANIFEST_YAML);
const PUBLIC_SCOPE_WHY = {
  "app_mentions:read": "feature, not checked by verify: the app_mention event the inbound path admits (ADMITTED_EVENT_TYPES)",
  "channels:history": "baseline: checked by `rig slack verify`",
  "channels:read": "baseline: checked by `rig slack verify`",
  "chat:write": "baseline: checked by `rig slack verify`",
  "files:read": "feature, not checked by verify: inbound attachments: authenticated url_private download (slack-subsystem inbound file port)",
  "files:write": "feature, not checked by verify: outbound attachments: files.getUploadURLExternal / files.completeUploadExternal (slack-api)",
  "reactions:read": "feature, not checked by verify: the reaction_added event the inbound path admits: a reaction on an ask reaches the asking seat (InboundRouter.routeReaction)",
  "users:read": "feature, not checked by verify: named-bot delivery: bots.info names the app a bot's post in the bot inbox belongs to (InboundRouter.routeBot)",
};

describe("rig slack manifest (offline)", () => {
  it("prints the shipped manifest as YAML from the real surface", async () => {
    const { deps, logs } = offline();
    await run(deps, ["manifest"]);
    expect(logs).toEqual([PUBLIC_MANIFEST_YAML.trimEnd()]);
    expect(parse(logs[0]!)).toEqual(PUBLIC_MANIFEST);
  });

  it("--url prints Slack's prefill link carrying exactly that YAML", async () => {
    const { deps, logs } = offline();
    await run(deps, ["manifest", "--url"]);
    expect(logs).toEqual([PUBLIC_MANIFEST_URL]);
  });

  it("--json returns the manifest, scope and event lists, and a reason for every scope", async () => {
    const { deps, logs } = offline();
    await run(deps, ["manifest", "--json"]);
    const out = JSON.parse(logs[0]!);
    const expected = { manifest: PUBLIC_MANIFEST, url: PUBLIC_MANIFEST_URL, scopes: PUBLIC_SCOPES, events: PUBLIC_EVENTS, why: PUBLIC_SCOPE_WHY };
    expect(out).toEqual(expected);
    expect(logs[0]).toBe(JSON.stringify(expected));
  });

  it("keeps the opt-in private manifest offline in YAML, URL and JSON forms", async () => {
    const yaml = offline();
    await runWithExitOverride(yaml.deps, ["manifest", "--private-channel"]);
    const privateBundle = buildSlackAppManifest(undefined, { privateChannel: true });
    expect(privateBundle.scopes).toEqual([
      "app_mentions:read", "channels:history", "channels:read", "chat:write",
      "files:read", "files:write", "groups:history", "groups:read", "reactions:read", "users:read",
    ]);
    expect(privateBundle.events).toEqual(["app_mention", "message.channels", "message.groups", "reaction_added"]);
    expect(yaml.logs).toEqual([privateBundle.yaml.trimEnd()]);
    expect(parse(yaml.logs[0]!)).toEqual(privateBundle.manifest);

    const url = offline();
    await runWithExitOverride(url.deps, ["manifest", "--private-channel", "--url"]);
    const prefix = "https://api.slack.com/apps?new_app=1&manifest_yaml=";
    expect(url.logs[0]!.startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(url.logs[0]!.slice(prefix.length))).toBe(privateBundle.yaml);

    const json = offline();
    await runWithExitOverride(json.deps, ["manifest", "--private-channel", "--json"]);
    const out = JSON.parse(json.logs[0]!);
    expect(out.manifest).toEqual(privateBundle.manifest);
    expect(out.scopes).toEqual(privateBundle.scopes);
    expect(out.events).toEqual(privateBundle.events);
    expect(out.scopes).toEqual(expect.arrayContaining(["groups:history", "groups:read"]));
    expect(out.events).toContain("message.groups");
    expect(out.why["groups:history"]).not.toBe("unexplained");
    expect(out.why["groups:read"]).not.toBe("unexplained");
    for (const scope of ["groups:history", "groups:read"]) expect(out.why[scope]).toContain("rig slack manifest --private-channel");
  });

  it("help routes to the setup doc and states verify checks only the baseline", () => {
    const { deps } = offline();
    const manifest = slackCommand(deps).commands.find((c) => c.name() === "manifest")!;
    let help = "";
    manifest.configureOutput({ writeOut: (s) => { help += s; } });
    manifest.outputHelp();
    expect(help).toContain("docs/reference/slack-app-setup.md");
    expect(help).toContain("$OPENRIG_HOME/reference/slack-app-setup.md");
    expect(help).toContain("does not prove attachments or mentions");
    expect(help).toContain("paste the plain YAML output");
  });
});

describe("next-step routing names `rig slack manifest` first", () => {
  const readiness = (ok: boolean) => [{ label: "bot-token", ok, detail: ok ? "set" : "unset" }];
  const surface = (ok: boolean) => async () => ({
    loadConfig: () => ({ enabled: false, inboundDestination: "x", outboundDestinations: [], sourceLabel: "s", channel: null,
      requiredScopes: [...BASELINE_REQUIRED_SCOPES], secretsEnvFile: null, queueUrl: null,
      minimumLevelThatPosts: "NOTICE" as const, minimumLevelThatInterrupts: "ALERT" as const }),
    saveConfig: () => "/unused",
    staticReadiness: () => readiness(ok),
    resolveSecret: () => null,
    checkEnvFilePermissions: () => null,
    verifyScopes: async () => ({ ok: true, granted: [], missing: [] }),
    verifyChannelMembership: async () => ({ ok: true, isMember: true, isPrivate: null }),
    buildSlackAppManifest, FEATURE_SCOPES, BASELINE_REQUIRED_SCOPES,
    PRIVATE_CHANNEL_SCOPES: ["groups:history", "groups:read"],
  });

  it("status, unconfigured: text and JSON both name the manifest step", async () => {
    const text = offline({ surface: surface(false) as SlackDeps["surface"] });
    await run(text.deps, ["status"]);
    expect(text.logs.join("\n")).toMatch(/First step: `rig slack manifest --url`/);
    const json = offline({ surface: surface(false) as SlackDeps["surface"] });
    await run(json.deps, ["status", "--json"]);
    expect(JSON.parse(json.logs[0]!).next).toContain("rig slack manifest --url");
  });

  it("status, configured: no manifest step", async () => {
    const { deps, logs } = offline({ surface: surface(true) as SlackDeps["surface"] });
    await run(deps, ["status", "--json"]);
    expect(JSON.parse(logs[0]!).next).toBeNull();
  });

  it("setup's next-step hint starts with the manifest", async () => {
    const { deps, logs } = offline();
    await run(deps, ["setup", "--channel", "C123", "--reason", "fixture", "--actor", "fixture-operator"]);
    expect(logs.find((l) => l.startsWith("Next:"))).toMatch(/^Next: if you have no Slack app yet, start with `rig slack manifest --url`/);
  });
});
