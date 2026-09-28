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

describe("rig slack manifest (offline)", () => {
  it("prints the shipped manifest as YAML from the real surface", async () => {
    const { deps, logs } = offline();
    await run(deps, ["manifest"]);
    expect(logs).toHaveLength(1);
    expect(parse(logs[0]!)).toEqual(buildSlackAppManifest().manifest);
  });

  it("--url prints Slack's prefill link carrying exactly that YAML", async () => {
    const { deps, logs } = offline();
    await run(deps, ["manifest", "--url"]);
    const prefix = "https://api.slack.com/apps?new_app=1&manifest_yaml=";
    expect(logs[0]!.startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(logs[0]!.slice(prefix.length))).toBe(buildSlackAppManifest().yaml);
  });

  it("--json returns the manifest, scope and event lists, and a reason for every scope", async () => {
    const { deps, logs } = offline();
    await run(deps, ["manifest", "--json"]);
    const out = JSON.parse(logs[0]!);
    const bundle = buildSlackAppManifest();
    expect(out.manifest).toEqual(bundle.manifest);
    expect(new Set(out.scopes)).toEqual(new Set(bundle.scopes));
    expect(new Set(out.events)).toEqual(new Set(bundle.events));
    for (const scope of out.scopes) expect(out.why[scope]).not.toBe("unexplained");
    for (const scope of BASELINE_REQUIRED_SCOPES) expect(out.why[scope]).toContain("checked by `rig slack verify`");
    for (const f of FEATURE_SCOPES) expect(out.why[f.scope]).toContain("not checked by verify");
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
    verifyChannelMembership: async () => ({ ok: true, isMember: true }),
    buildSlackAppManifest, FEATURE_SCOPES, BASELINE_REQUIRED_SCOPES,
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
