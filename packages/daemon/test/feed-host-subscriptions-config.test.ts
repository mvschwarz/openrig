// OPR.0.4.4.15 (guard G15-P1 fold) — the ONE registered dynamic key class:
// feed.subscriptions.<hostId>.enabled. These tests pin the fold's whole
// contract: round-trip persistence, delimiter + reserved-segment guards
// (warn-and-ignore on the read side, reject-loud on the write side),
// unknown NON-matching keys keeping the existing 400/throw behavior
// byte-for-byte, and CLI/daemon twin parity (the host-registry twin
// discipline: shared fixtures through BOTH implementations).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsStore,
  parseFeedHostSubscriptionKey as daemonParse,
} from "../src/domain/user-settings/settings-store.js";
import { ConfigStore, parseFeedHostSubscriptionKey as cliParse } from "../../cli/src/config-store.js";

import { aggregateAttention } from "../src/domain/feed/attention-aggregator.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feed-host-cfg-"));
  configPath = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function store(): SettingsStore {
  return new SettingsStore(configPath);
}

describe("dynamic feed-host subscription keys — daemon store", () => {
  it("set/resolve/list round-trip; reset removes the whole host node", () => {
    const s = store();
    s.set("feed.subscriptions.vps-b.enabled", "true");
    s.set("feed.subscriptions.mac_mini2.enabled", "false");
    expect(s.resolveFeedHostSubscription("feed.subscriptions.vps-b.enabled")).toEqual({ value: true, source: "file", defaultValue: false });
    expect(s.resolveFeedHostSubscription("feed.subscriptions.never-set.enabled")).toEqual({ value: false, source: "default", defaultValue: false });
    expect(s.listFeedHostSubscriptions()).toEqual([
      { hostId: "vps-b", enabled: true },
      { hostId: "mac_mini2", enabled: false },
    ]);
    s.reset("feed.subscriptions.vps-b.enabled");
    expect(s.listFeedHostSubscriptions()).toEqual([{ hostId: "mac_mini2", enabled: false }]);
    // The file layout nests under feed.subscriptions.<hostId>.enabled.
    const fc = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, never>;
    expect(fc).toEqual({ feed: { subscriptions: { mac_mini2: { enabled: false } } } });
  });

  it.each(["cli", "daemon"])("%s writes a dotted host as one literal node and attention includes it until reset", async (writer) => {
    const cli = new ConfigStore(configPath);
    const daemon = store();
    const key = "feed.subscriptions.mac.local.enabled";
    const selected = writer === "cli" ? cli : daemon;
    selected.set(key, "true");
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({ feed: { subscriptions: { "mac.local": { enabled: true } } } });
    expect(cli.get(key)).toBe(true);
    expect(daemon.resolveFeedHostSubscription(key)?.value).toBe(true);
    expect(daemon.listFeedHostSubscriptions()).toEqual([{ hostId: "mac.local", enabled: true }]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ qitemId: "remote-ask" }]), { status: 200 }));
    const deps = {
      listLocalAttention: () => [],
      listSubscriptions: () => daemon.listFeedHostSubscriptions(),
      loadRegistry: () => ({ ok: true as const, registry: { hosts: [{ id: "mac.local", transport: "http" as const, url: "http://mac.local:7433", bearer_env: "TEST_TOKEN" }] } }),
      env: { TEST_TOKEN: "fixture-only" },
      fetchImpl,
    };
    expect(await aggregateAttention(deps)).toMatchObject({ items: [{ qitemId: "remote-ask", hostId: "mac.local" }], hosts: [{ hostId: "local", status: "ok" }, { hostId: "mac.local", status: "ok" }] });
    expect(fetchImpl).toHaveBeenCalledOnce();
    selected.set(key, "false");
    expect((await aggregateAttention(deps)).hosts).toEqual([{ hostId: "local", status: "ok" }]);
    selected.reset(key);
    expect(daemon.listFeedHostSubscriptions()).toEqual([]);
    expect(cli.get(key)).toBe(false);
  });

  it("write side rejects loudly: non-boolean values, reserved segments, invalid host ids, and every non-matching unknown key (existing behavior byte-preserved)", () => {
    const s = store();
    expect(() => s.set("feed.subscriptions.vps-b.enabled", "yes")).toThrow(/expected "true" or "false"/);
    // Reserved segments never parse as host ids → the flat-key/unknown path owns them.
    expect(() => s.set("feed.subscriptions.approvals.enabled", "true")).toThrow(/Unknown config key/);
    expect(() => s.set("feed.subscriptions.auditLog.enabled", "true")).toThrow(/Unknown config key/);
    expect(() => s.set("feed.subscriptions.bad host.enabled", "true")).toThrow(/Unknown config key/);
    // Per-host key set is CLOSED to {enabled} in v1.
    expect(() => s.set("feed.subscriptions.vps-b.altitude", "high")).toThrow(/Unknown config key/);
    // The pre-existing unknown-key negative, untouched.
    expect(() => s.set("totally.unknown.key", "x")).toThrow(/Unknown config key/);
  });

  it("read side warn-and-ignores malformed persisted nodes without dropping valid ones (the ratified guard)", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        feed: {
          subscriptions: {
            approvals: true, // flat toggle leaf — silently fine, not a host
            "vps-b": { enabled: true },
            auditLog: { enabled: true }, // reserved OBJECT node — warned + ignored
            "bad seg!": { enabled: true }, // invalid segment — warned + ignored
            "half-baked": { enabled: "yes" }, // non-boolean — warned + ignored
          },
        },
      }),
    );
    const warnings: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      warnings.push(String(chunk));
      return true;
    }) as never);
    expect(store().listFeedHostSubscriptions()).toEqual([{ hostId: "vps-b", enabled: true }]);
    expect(warnings.join("")).toContain("auditLog");
    expect(warnings.join("")).toContain("bad seg!");
    expect(warnings.join("")).toContain("half-baked");
  });
});

describe("dynamic feed-host subscription keys — CLI/daemon twin parity", () => {
  const PARSE_FIXTURES: Array<{ key: string; hostId: string | null }> = [
    { key: "feed.subscriptions.vps-b.enabled", hostId: "vps-b" },
    { key: "feed.subscriptions.mac_mini2.enabled", hostId: "mac_mini2" },
    { key: "feed.subscriptions.approvals.enabled", hostId: null }, // reserved (key-level)
    { key: "feed.subscriptions.auditLog.enabled", hostId: null }, // reserved (file-level)
    { key: "feed.subscriptions.enabled.enabled", hostId: null }, // reserved
    { key: "feed.subscriptions.vps.b.enabled", hostId: "vps.b" }, // literal host id
    { key: "feed.subscriptions.mac.local.enabled", hostId: "mac.local" },
    { key: "feed.subscriptions.mac.local.enabled.enabled", hostId: "mac.local.enabled" },
    { key: "feed.subscriptions.bad host.enabled", hostId: null },
    { key: "feed.subscriptions.vps-b.altitude", hostId: null }, // closed per-host set
    { key: "feed.subscriptions..enabled", hostId: null }, // empty segment
    { key: "workspace.root", hostId: null }, // unrelated key
  ];

  it("both parsers agree fixture-for-fixture (a divergence = one twin drifted)", () => {
    for (const f of PARSE_FIXTURES) {
      const d = daemonParse(f.key);
      const c = cliParse(f.key);
      expect(d?.hostId ?? null).toBe(f.hostId);
      expect(c?.hostId ?? null).toBe(f.hostId);
    }
  });
});
