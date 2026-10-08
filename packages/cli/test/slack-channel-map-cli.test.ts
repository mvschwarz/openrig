// #192 — `rig slack channel-map list|set|remove` and `rig slack verify` across every mapped
// channel. Real daemon config surface over a temp home; Slack is an injected fetch (no network).
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slackCommand } from "../src/commands/slack.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "@openrig/daemon/gateway-slack";

const homes: string[] = [];
afterEach(() => { homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })); process.exitCode = 0; vi.unstubAllEnvs(); });

function setup(channelMap?: Array<{ match: string; channel: string }>) {
  const home = mkdtempSync(join(tmpdir(), "slack-channel-map-cli-"));
  homes.push(home);
  saveConfig({ ...DEFAULT_CONFIG, channel: "C0DEFAULT", ...(channelMap ? { channelMap } : {}) }, home);
  const logs: string[] = [];
  const run = (argv: string[], fetchImpl?: Parameters<typeof slackCommand>[0]["fetchImpl"]) =>
    slackCommand({ home, log: (m) => logs.push(m), fetchImpl }).parseAsync(["node", "slack", ...argv]);
  return { home, logs, run };
}

describe("rig slack channel-map", () => {
  it("set adds and replaces entries, keeps the rest of the config, and records a configure receipt", async () => {
    const { home, logs, run } = setup();
    await run(["channel-map", "set", "my-rig", "C0EXAMPLE1", "--actor", "operator@kernel"]);
    await run(["channel-map", "set", "pr@my-rig", "C0EXAMPLE2", "--actor", "operator@kernel"]);
    await run(["channel-map", "set", "my-rig", "C0EXAMPLE3", "--actor", "operator@kernel"]);
    const cfg = loadConfig(home);
    expect(cfg.channelMap).toEqual([{ match: "my-rig", channel: "C0EXAMPLE3" }, { match: "pr@my-rig", channel: "C0EXAMPLE2" }]);
    expect(cfg.channel).toBe("C0DEFAULT");
    expect(process.exitCode ?? 0).toBe(0);
    expect(logs.filter((l) => l.startsWith("Next: Invite the app to every mapped channel"))).toHaveLength(3);
    const receipts = readFileSync(join(home, "state", "human-channel-operations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(receipts.filter((r) => r.effect === "applied")).toHaveLength(3);
    expect(receipts.at(-1)).toMatchObject({ action: "configure", subject: "slack", reason: "configure the slack channel map" });
  });

  it("set refuses an invalid entry with the teaching error and writes nothing", async () => {
    const { home, logs, run } = setup([{ match: "my-rig", channel: "C0EXAMPLE1" }]);
    const before = readFileSync(join(home, "slack-connector.json"), "utf8");
    await run(["channel-map", "set", "alice@external", "C0EXAMPLE2", "--actor", "operator@kernel"]);
    expect(process.exitCode).toBe(1);
    expect(logs.at(-1)).toMatch(/^✗ channel map not changed: channelMap\[1\]\.match 'alice@external' is not a seat/);
    expect(readFileSync(join(home, "slack-connector.json"), "utf8")).toBe(before);
  });

  // A map field written by a newer OpenRig (here PR2's `inbound`) must never be lost: every map
  // write refuses, exits 1, leaves the file byte-identical and records no channel operation.
  const newerFieldCases: Array<[string, string[]]> = [
    ["set of a DIFFERENT entry (pr@my-rig) while my-rig carries a newer field", ["set", "pr@my-rig", "C0EXAMPLE2"]],
    ["set of the SAME entry (my-rig) that carries the newer field", ["set", "my-rig", "C0EXAMPLE2"]],
    ["remove of the SAME entry (my-rig) that carries the newer field", ["remove", "my-rig"]],
    ["remove of a match that is not in the map", ["remove", "other-rig"]],
  ];
  it.each(newerFieldCases)("refuses %s: exit 1, file unchanged, no receipt", async (_label, verb) => {
    const { home, logs, run } = setup();
    const file = join(home, "slack-connector.json");
    const receipts = join(home, "state", "human-channel-operations.jsonl");
    writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, channel: "C0DEFAULT", channelMap: [{ match: "my-rig", channel: "C0EXAMPLE1", inbound: "lead@my-rig" }] }));
    const before = readFileSync(file, "utf8");
    await run(["channel-map", ...verb, "--actor", "operator@kernel"]);
    expect(process.exitCode).toBe(1);
    expect(logs.at(-1)).toBe("✗ channel map not changed: channelMap[0] ('my-rig') has unsupported field(s) inbound: " +
      "slack-connector.json was written by a newer OpenRig version. Upgrade OpenRig, or edit the file by hand to remove them; nothing was changed.");
    expect(logs.some((l) => l.startsWith("Next:") || l.startsWith("wrote "))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(receipts) ? readFileSync(receipts, "utf8") : "").toBe(""); // no started/applied receipt at all
  });

  // A hand-edited duplicate makes the file unloadable: every verb says so (no silent exit) and
  // points at the one fix that works, editing the file, since no verb can load it.
  it.each([["list"], ["set", "my-rig", "C0EXAMPLE2"], ["remove", "my-rig"]])("%s on a hand-edited duplicate entry: names the fix, exit 1, file unchanged", async (...verb) => {
    const { home, logs, run } = setup();
    const file = join(home, "slack-connector.json");
    writeFileSync(file, JSON.stringify({ ...DEFAULT_CONFIG, channel: "C0DEFAULT", channelMap: [{ match: "my-rig", channel: "C0EXAMPLE1" }, { match: "my-rig", channel: "C0EXAMPLE2" }] }));
    const before = readFileSync(file, "utf8");
    await run(["channel-map", ...verb, ...(verb[0] === "list" ? [] : ["--actor", "operator@kernel"])]);
    expect(process.exitCode).toBe(1);
    expect(logs).toEqual(["✗ channelMap has two entries for 'my-rig': edit slack-connector.json by hand and keep one entry"]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("remove drops an entry; removing the last entry returns the file to its pre-map shape", async () => {
    const { home, run } = setup();
    const pristine = readFileSync(join(home, "slack-connector.json"), "utf8");
    await run(["channel-map", "set", "my-rig", "C0EXAMPLE1", "--actor", "operator@kernel"]);
    await run(["channel-map", "remove", "my-rig", "--actor", "operator@kernel"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(loadConfig(home)).not.toHaveProperty("channelMap");
    expect(readFileSync(join(home, "slack-connector.json"), "utf8")).toBe(pristine);
  });

  it("remove of an unknown match fails visibly and changes nothing", async () => {
    const { home, logs, run } = setup([{ match: "my-rig", channel: "C0EXAMPLE1" }]);
    await run(["channel-map", "remove", "other-rig", "--actor", "operator@kernel"]);
    expect(process.exitCode).toBe(1);
    expect(logs.at(-1)).toContain("no channel map entry for 'other-rig'");
    expect(loadConfig(home).channelMap).toEqual([{ match: "my-rig", channel: "C0EXAMPLE1" }]);
  });

  it("list shows the default and each entry, in text and JSON", async () => {
    const { logs, run } = setup([{ match: "my-rig", channel: "C0EXAMPLE1" }, { match: "pr@my-rig", channel: "C0EXAMPLE2" }]);
    await run(["channel-map", "list"]);
    expect(logs).toEqual(["default -> C0DEFAULT", "my-rig -> C0EXAMPLE1", "pr@my-rig -> C0EXAMPLE2"]);
    logs.length = 0;
    await run(["channel-map", "list", "--json"]);
    expect(JSON.parse(logs[0]!)).toEqual({
      default: "C0DEFAULT",
      entries: [{ match: "my-rig", channel: "C0EXAMPLE1" }, { match: "pr@my-rig", channel: "C0EXAMPLE2" }],
    });
  });

  it("list without a map says every item uses the default channel", async () => {
    const { logs, run } = setup();
    await run(["channel-map", "list"]);
    expect(logs.at(-1)).toBe("no channel map entries: every item uses the default channel");
  });
});

describe("rig slack verify with a channel map", () => {
  // Membership answers per channel; everything else is a granted-scope auth.test.
  const slack = (members: Record<string, boolean>, infoChannels: string[]) => async (url: string) => {
    const target = new URL(url);
    if (target.pathname.endsWith("/auth.test")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "x-oauth-scopes": DEFAULT_CONFIG.requiredScopes.join(", ") } });
    }
    const channel = target.searchParams.get("channel") ?? "";
    infoChannels.push(channel);
    return new Response(JSON.stringify({ ok: true, channel: { is_member: members[channel] ?? false, name: `name-${channel}` } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const map = [{ match: "my-rig", channel: "C0EXAMPLE1" }, { match: "other-rig", channel: "C0EXAMPLE1" }, { match: "pr@my-rig", channel: "C0EXAMPLE2" }];

  it("checks membership once per unique channel and is READY only when the app is in all of them", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-local-fixture-only");
    const { logs, run } = setup(map);
    const asked: string[] = [];
    await run(["verify"], slack({ C0DEFAULT: true, C0EXAMPLE1: true, C0EXAMPLE2: true }, asked) as never);
    expect(asked).toEqual(["C0DEFAULT", "C0EXAMPLE1", "C0EXAMPLE2"]);
    expect(logs).toContain("✓ channel member (name-C0DEFAULT)");
    expect(logs).toContain("✓ channel member (name-C0EXAMPLE1) for my-rig, other-rig");
    expect(logs).toContain("✓ channel member (name-C0EXAMPLE2) for pr@my-rig");
    expect(logs.at(-1)).toBe("READY");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("names the mapped channel the app is missing from and fails", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-local-fixture-only");
    const { logs, run, home } = setup(map);
    await run(["verify"], slack({ C0DEFAULT: true, C0EXAMPLE1: true, C0EXAMPLE2: false }, []) as never);
    expect(logs).toContain("✗ NOT a member of channel C0EXAMPLE2 for pr@my-rig — invite the app");
    expect(logs.at(-1)).toBe("NOT ready");
    expect(process.exitCode).toBe(1);
    const receipts = readFileSync(join(home, "state", "human-channel-operations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(receipts.at(-1)).toMatchObject({ action: "verify", after: { ready: false } });
  });

  it("JSON lists every channel's membership; without a map the JSON shape is unchanged", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-local-fixture-only");
    const mapped = setup(map);
    await mapped.run(["verify", "--json"], slack({ C0DEFAULT: true, C0EXAMPLE1: false, C0EXAMPLE2: true }, []) as never);
    const out = JSON.parse(mapped.logs[0]!);
    expect(out.ready).toBe(false);
    expect(out.channels.map((c: { channel: string; isDefault: boolean; matches: string[]; member: { isMember: boolean } }) => [c.channel, c.isDefault, c.matches, c.member.isMember])).toEqual([
      ["C0DEFAULT", true, [], true],
      ["C0EXAMPLE1", false, ["my-rig", "other-rig"], false],
      ["C0EXAMPLE2", false, ["pr@my-rig"], true],
    ]);
    process.exitCode = 0;
    const plain = setup();
    await plain.run(["verify", "--json"], slack({ C0DEFAULT: true }, []) as never);
    const single = JSON.parse(plain.logs[0]!);
    expect(single).not.toHaveProperty("channels");
    expect(single).toMatchObject({ ready: true, member: { isMember: true } });
  });
});

describe("rig slack status with a channel map", () => {
  const offline = () => ({ get: vi.fn(async () => { throw new Error("offline"); }), post: vi.fn() });
  it("adds one channel-map row; an ignored newer field fails that row without pointing at the manifest", async () => {
    const { home } = setup([{ match: "my-rig", channel: "C0EXAMPLE1" }]);
    const logs: string[] = [];
    await slackCommand({ home, log: (m) => logs.push(m), clientFactory: offline as never }).parseAsync(["node", "slack", "status"]);
    expect(logs).toContain("  ✓ channel-map: 1 entry over 1 channel(s); `rig slack verify` checks membership in each");
    writeFileSync(join(home, "slack-connector.json"), JSON.stringify({ ...loadConfig(home), channelMap: [{ match: "my-rig", channel: "C0EXAMPLE1", inbound: "lead@my-rig" }] }));
    logs.length = 0;
    await slackCommand({ home, log: (m) => logs.push(m), clientFactory: offline as never }).parseAsync(["node", "slack", "status", "--json"]);
    const out = JSON.parse(logs[0]!);
    expect(out.readiness.find((r: { label: string }) => r.label === "channel-map")).toMatchObject({ ok: false });
    expect(out.readiness.find((r: { label: string }) => r.label === "channel-map").detail).toContain("IGNORED unsupported field(s) channelMap[0].inbound");
  });

  it("the channel-map warning alone does not send the operator to the manifest", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-local-fixture-only");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-local-fixture-only");
    const { home } = setup();
    writeFileSync(join(home, "slack-connector.json"), JSON.stringify({ ...DEFAULT_CONFIG, enabled: true, channel: "C0DEFAULT",
      channelMap: [{ match: "my-rig", channel: "C0EXAMPLE1", inbound: "lead@my-rig" }] }));
    const logs: string[] = [];
    await slackCommand({ home, log: (m) => logs.push(m), clientFactory: offline as never }).parseAsync(["node", "slack", "status", "--json"]);
    const out = JSON.parse(logs[0]!);
    expect(out.readiness.filter((r: { ok: boolean }) => !r.ok).map((r: { label: string }) => r.label)).toEqual(["channel-map"]);
    expect(out.next).toBeNull();
    expect(JSON.stringify(out)).not.toContain("xoxb-local-fixture-only");
  });
});
