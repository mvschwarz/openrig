import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import {
  addHumanFragment,
  projectionPath,
  type HumanFragment,
} from "../src/domain/gateway/human-registry.js";
import {
  loadRelayProfiles,
  validateRelayUrl,
  parseRelaySecretsRef,
  authenticateRelayInboundToken,
} from "../src/domain/gateway/relay-config.js";

function relayHuman(
  entityId: string,
  connectorRef: string,
  secretsRef: string,
  handle: string = entityId,
): Record<string, unknown> {
  return {
    entityId,
    class: "human",
    displayName: entityId,
    address: `${entityId}@external`,
    connectorBindings: [
      {
        kind: "relay",
        connectorRef,
        secretsRef,
        role: "primary",
        handle,
      },
    ],
    prefs: { deliveryClass: "B" },
  };
}

describe("relay-config: URL and secretsRef validation", () => {
  it("accepts file:<absolute-path> and rejects relative or non-file secretsRef", () => {
    expect(parseRelaySecretsRef("file:/etc/openrig/relay.env")).toEqual({
      ok: true,
      envFile: "/etc/openrig/relay.env",
    });
    expect(parseRelaySecretsRef("/etc/openrig/relay.env").ok).toBe(false);
    expect(parseRelaySecretsRef("file:relative/relay.env").ok).toBe(false);
    expect(parseRelaySecretsRef("vault://slack/main").ok).toBe(false);
    expect(parseRelaySecretsRef("file://localhost/etc/relay.env").ok).toBe(false);
  });

  it("validates http loopback URLs (127.0.0.0/8, ::1, localhost) and rejects non-http, non-loopback, or embedded credentials without echoing secrets", () => {
    expect(validateRelayUrl("http://127.0.0.1:8787/relay").ok).toBe(true);
    expect(validateRelayUrl("http://127.255.0.1:9000/hook").ok).toBe(true);
    expect(validateRelayUrl("http://[::1]:8787/relay").ok).toBe(true);
    expect(validateRelayUrl("http://localhost:8787/relay").ok).toBe(true);

    expect(validateRelayUrl("https://127.0.0.1:8787/relay").ok).toBe(false);
    expect(validateRelayUrl("http://0.0.0.0:8787/relay").ok).toBe(false);
    expect(validateRelayUrl("http://192.168.1.10:8787/relay").ok).toBe(false);
    expect(validateRelayUrl("http://example.com:8787/relay").ok).toBe(false);
    expect(validateRelayUrl("http://2130706433:8787/relay").ok).toBe(false);

    const credUrl = validateRelayUrl("http://admin:ultra-secret-pass@127.0.0.1:8787/relay");
    expect(credUrl.ok).toBe(false);
    if (!credUrl.ok) {
      expect(credUrl.reason).toMatch(/credentials/i);
      expect(credUrl.reason).not.toContain("ultra-secret-pass");
      expect(credUrl.reason).not.toContain("admin");
    }
  });
});

describe("relay-config: loadRelayProfiles(home)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "relay-cfg-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("handles an empty human registry (noHumans) cleanly as ok with zero relay profiles", () => {
    const loaded = loadRelayProfiles(home);
    expect(loaded.ok).toBe(true);
    expect(loaded.registryError).toBeNull();
    expect(loaded.profiles.size).toBe(0);
  });

  it("reports registryError when the human registry projection is corrupt", () => {
    const envFile = join(home, "relay.env");
    writeFileSync(
      envFile,
      "OPENRIG_RELAY_URL=http://127.0.0.1:8787/out\nOPENRIG_RELAY_OUTBOUND_TOKEN=out-1\nOPENRIG_RELAY_INBOUND_TOKEN=in-1\n",
      { mode: 0o600 },
    );
    expect(addHumanFragment(relayHuman("mike", "bridge-1", `file:${envFile}`), home).ok).toBe(true);
    writeFileSync(projectionPath(home), "corrupted: hand-edited\n");

    const loaded = loadRelayProfiles(home);
    expect(loaded.ok).toBe(false);
    expect(loaded.registryError).toMatch(/HAND-EDITED|DRIFT/i);
  });

  it("loads a valid 0600 relay profile, exposes private credentials only via non-enumerable property, and never serializes secrets", () => {
    const envFile = join(home, "relay.env");
    writeFileSync(
      envFile,
      [
        "OPENRIG_RELAY_URL=http://127.0.0.1:8787/out",
        "OPENRIG_RELAY_OUTBOUND_TOKEN=secret-outbound-token-xyz",
        "OPENRIG_RELAY_INBOUND_TOKEN=secret-inbound-token-abc",
      ].join("\n"),
      { mode: 0o600 },
    );
    expect(addHumanFragment(relayHuman("mike", "bridge-1", `file:${envFile}`, "mike-alias"), home).ok).toBe(true);

    const loaded = loadRelayProfiles(home);
    expect(loaded.ok).toBe(true);
    const profile = loaded.get("bridge-1");
    expect(profile).toBeDefined();
    expect(profile!.ready).toBe(true);
    expect(profile!.state).toBe("ready");
    expect(profile!.configured).toBe(true);
    expect(profile!.endpointUrl).toBe("http://127.0.0.1:8787/out");
    expect(profile!.credentials).toEqual({
      url: "http://127.0.0.1:8787/out",
      outboundToken: "secret-outbound-token-xyz",
      inboundToken: "secret-inbound-token-abc",
    });

    const json = JSON.stringify({ loaded, profile });
    const yaml = stringifyYaml(profile);
    expect(json).not.toContain("secret-outbound-token-xyz");
    expect(json).not.toContain("secret-inbound-token-abc");
    expect(yaml).not.toContain("secret-outbound-token-xyz");
    expect(yaml).not.toContain("secret-inbound-token-abc");
    expect(Object.keys(profile!)).not.toContain("credentials");

    const authOk = authenticateRelayInboundToken(loaded, "secret-inbound-token-abc");
    expect(authOk.ok).toBe(true);
    if (authOk.ok) expect(authOk.connectorRef).toBe("bridge-1");

    expect(authenticateRelayInboundToken(loaded, "secret-outbound-token-xyz").ok).toBe(false);
    expect(authenticateRelayInboundToken(loaded, "wrong").ok).toBe(false);
  });

  it("warns on group/world accessible secret file or identical directional tokens while keeping the profile ready (0600 and 0400 produce no warning), and still rejects missing keys/files without falling back to process.env", () => {
    const mode0400File = join(home, "mode0400.env");
    writeFileSync(
      mode0400File,
      "OPENRIG_RELAY_URL=http://127.0.0.1:8787/out\nOPENRIG_RELAY_OUTBOUND_TOKEN=o-400\nOPENRIG_RELAY_INBOUND_TOKEN=i-400\n",
      { mode: 0o400 },
    );
    chmodSync(mode0400File, 0o400);

    const insecureFile = join(home, "insecure.env");
    writeFileSync(
      insecureFile,
      "OPENRIG_RELAY_URL=http://127.0.0.1:8787/out\nOPENRIG_RELAY_OUTBOUND_TOKEN=o1-secret\nOPENRIG_RELAY_INBOUND_TOKEN=i1-secret\n",
      { mode: 0o644 },
    );
    chmodSync(insecureFile, 0o644);

    const equalTokensFile = join(home, "equal.env");
    writeFileSync(
      equalTokensFile,
      "OPENRIG_RELAY_URL=http://127.0.0.1:8787/out\nOPENRIG_RELAY_OUTBOUND_TOKEN=same-secret-tok\nOPENRIG_RELAY_INBOUND_TOKEN=same-secret-tok\n",
      { mode: 0o600 },
    );

    const missingKeyFile = join(home, "missing-key.env");
    writeFileSync(
      missingKeyFile,
      "OPENRIG_RELAY_URL=http://127.0.0.1:8787/out\nOPENRIG_RELAY_OUTBOUND_TOKEN=only-out\n",
      { mode: 0o600 },
    );

    const savedUrl = process.env.OPENRIG_RELAY_URL;
    const savedOut = process.env.OPENRIG_RELAY_OUTBOUND_TOKEN;
    const savedIn = process.env.OPENRIG_RELAY_INBOUND_TOKEN;
    process.env.OPENRIG_RELAY_URL = "http://127.0.0.1:9999/env-fallback";
    process.env.OPENRIG_RELAY_OUTBOUND_TOKEN = "env-out-token";
    process.env.OPENRIG_RELAY_INBOUND_TOKEN = "env-in-token";

    try {
      expect(addHumanFragment(relayHuman("u0", "r-0400", `file:${mode0400File}`), home).ok).toBe(true);
      expect(addHumanFragment(relayHuman("u1", "r-insecure", `file:${insecureFile}`), home).ok).toBe(true);
      expect(addHumanFragment(relayHuman("u2", "r-equal", `file:${equalTokensFile}`), home).ok).toBe(true);
      expect(addHumanFragment(relayHuman("u3", "r-missing-key", `file:${missingKeyFile}`), home).ok).toBe(true);
      expect(addHumanFragment(relayHuman("u4", "r-missing-file", `file:${join(home, "nope.env")}`), home).ok).toBe(true);

      const loaded = loadRelayProfiles(home);

      // 0400 has zero group/other bits -> ready with zero warnings
      const p0400 = loaded.get("r-0400")!;
      expect(p0400.ready).toBe(true);
      expect(p0400.warnings).toEqual([]);
      expect(p0400.reason).not.toMatch(/warning|insecure/i);

      // 0644 has group/other bits -> warns like Slack, does NOT make profile unready
      const pInsecure = loaded.get("r-insecure")!;
      expect(pInsecure.ready).toBe(true);
      expect(pInsecure.state).toBe("ready");
      expect(pInsecure.credentials).toEqual({
        url: "http://127.0.0.1:8787/out",
        outboundToken: "o1-secret",
        inboundToken: "i1-secret",
      });
      expect(pInsecure.warnings.length).toBeGreaterThan(0);
      expect(pInsecure.warnings[0]).toMatch(/0644/);
      expect(pInsecure.warnings[0]).toMatch(/group\/other/i);
      expect(pInsecure.reason).toMatch(/warning.*0644/i);
      expect(pInsecure.reason).not.toContain("o1-secret");
      expect(pInsecure.reason).not.toContain("i1-secret");

      // Same token in both directions -> allowed and ready, with a useful redacted warning
      const pEqual = loaded.get("r-equal")!;
      expect(pEqual.ready).toBe(true);
      expect(pEqual.state).toBe("ready");
      expect(pEqual.credentials).toEqual({
        url: "http://127.0.0.1:8787/out",
        outboundToken: "same-secret-tok",
        inboundToken: "same-secret-tok",
      });
      expect(pEqual.warnings.length).toBeGreaterThan(0);
      expect(pEqual.warnings[0]).toMatch(/OPENRIG_RELAY_OUTBOUND_TOKEN.*OPENRIG_RELAY_INBOUND_TOKEN|separate/i);
      expect(pEqual.reason).toMatch(/warning/i);
      expect(pEqual.reason).not.toContain("same-secret-tok");
      expect(authenticateRelayInboundToken(loaded, "same-secret-tok")).toMatchObject({
        ok: true,
        connectorRef: "r-equal",
      });

      // Missing key or missing file still not-ready
      expect(loaded.get("r-missing-key")!.ready).toBe(false);
      expect(loaded.get("r-missing-key")!.reason).toMatch(/OPENRIG_RELAY_INBOUND_TOKEN/);
      expect(loaded.get("r-missing-key")!.credentials).toBeNull();

      expect(loaded.get("r-missing-file")!.ready).toBe(false);
      expect(loaded.get("r-missing-file")!.reason).toMatch(/missing or unreadable/i);
      expect(loaded.get("r-missing-file")!.credentials).toBeNull();
    } finally {
      if (savedUrl === undefined) delete process.env.OPENRIG_RELAY_URL;
      else process.env.OPENRIG_RELAY_URL = savedUrl;
      if (savedOut === undefined) delete process.env.OPENRIG_RELAY_OUTBOUND_TOKEN;
      else process.env.OPENRIG_RELAY_OUTBOUND_TOKEN = savedOut;
      if (savedIn === undefined) delete process.env.OPENRIG_RELAY_INBOUND_TOKEN;
      else process.env.OPENRIG_RELAY_INBOUND_TOKEN = savedIn;
    }
  });

  it("enforces consistent shared profiles across people and rejects ambiguous reused inbound tokens across refs", () => {
    const fileA = join(home, "a.env");
    const fileB = join(home, "b.env");
    const fileC = join(home, "c.env");
    writeFileSync(
      fileA,
      "OPENRIG_RELAY_URL=http://127.0.0.1:8787/a\nOPENRIG_RELAY_OUTBOUND_TOKEN=out-a\nOPENRIG_RELAY_INBOUND_TOKEN=dup-in-secret\n",
      { mode: 0o600 },
    );
    writeFileSync(
      fileB,
      "OPENRIG_RELAY_URL=http://127.0.0.1:8788/b\nOPENRIG_RELAY_OUTBOUND_TOKEN=out-b\nOPENRIG_RELAY_INBOUND_TOKEN=dup-in-secret\n",
      { mode: 0o600 },
    );
    writeFileSync(
      fileC,
      "OPENRIG_RELAY_URL=http://localhost:8789/c\nOPENRIG_RELAY_OUTBOUND_TOKEN=out-c\nOPENRIG_RELAY_INBOUND_TOKEN=unique-in-secret\n",
      { mode: 0o600 },
    );

    const h1 = relayHuman("mike", "shared-inconsistent", `file:${fileA}`, "mike") as unknown as HumanFragment;
    const h2 = relayHuman("dana", "shared-inconsistent", `file:${fileB}`, "dana") as unknown as HumanFragment;
    const inconsistent = loadRelayProfiles(home, { entities: [h1, h2] });
    expect(inconsistent.get("shared-inconsistent")!.ready).toBe(false);
    expect(inconsistent.get("shared-inconsistent")!.reason).toMatch(/inconsistent provisioning/i);

    const a1 = relayHuman("mike", "relay-a", `file:${fileA}`, "mike") as unknown as HumanFragment;
    const b1 = relayHuman("dana", "relay-b", `file:${fileB}`, "dana") as unknown as HumanFragment;
    const c1 = relayHuman("alex", "relay-c", `file:${fileC}`, "alex") as unknown as HumanFragment;
    const c2 = relayHuman("sam", "relay-c", `file:${fileC}`, "sam") as unknown as HumanFragment;
    const ambiguous = loadRelayProfiles(home, { entities: [a1, b1, c1, c2] });

    expect(ambiguous.get("relay-a")!.ready).toBe(false);
    expect(ambiguous.get("relay-a")!.reason).toMatch(/ambiguous.*OPENRIG_RELAY_INBOUND_TOKEN/i);
    expect(ambiguous.get("relay-a")!.reason).not.toContain("dup-in-secret");

    expect(ambiguous.get("relay-b")!.ready).toBe(false);
    expect(ambiguous.get("relay-b")!.reason).toMatch(/ambiguous.*OPENRIG_RELAY_INBOUND_TOKEN/i);

    expect(ambiguous.get("relay-c")!.ready).toBe(true);
    expect(ambiguous.get("relay-c")!.humans.map((h) => h.entityId)).toEqual(["alex", "sam"]);
    expect(authenticateRelayInboundToken(ambiguous, "dup-in-secret").ok).toBe(false);
    expect(authenticateRelayInboundToken(ambiguous, "unique-in-secret")).toMatchObject({
      ok: true,
      connectorRef: "relay-c",
    });
  });

  it("evaluates OPENRIG_RELAY_MODE=pull as ready without OPENRIG_RELAY_URL or OPENRIG_RELAY_OUTBOUND_TOKEN and validates mode/token errors", () => {
    const pullValidFile = join(home, "pull-valid.env");
    const pullNoTokenFile = join(home, "pull-no-token.env");
    const badModeFile = join(home, "bad-mode.env");
    const pullDupA = join(home, "pull-dup-a.env");
    const pushDupB = join(home, "push-dup-b.env");

    writeFileSync(
      pullValidFile,
      "OPENRIG_RELAY_MODE=pull\nOPENRIG_RELAY_INBOUND_TOKEN=pull-inbound-tok-1\n",
      { mode: 0o600 },
    );
    writeFileSync(pullNoTokenFile, "OPENRIG_RELAY_MODE=pull\n", { mode: 0o600 });
    writeFileSync(
      badModeFile,
      "OPENRIG_RELAY_MODE=hybrid\nOPENRIG_RELAY_INBOUND_TOKEN=bad-mode-tok\n",
      { mode: 0o600 },
    );
    writeFileSync(
      pullDupA,
      "OPENRIG_RELAY_MODE=pull\nOPENRIG_RELAY_INBOUND_TOKEN=shared-pull-push-tok\n",
      { mode: 0o600 },
    );
    writeFileSync(
      pushDupB,
      "OPENRIG_RELAY_URL=http://127.0.0.1:8787/out\nOPENRIG_RELAY_OUTBOUND_TOKEN=out-b\nOPENRIG_RELAY_INBOUND_TOKEN=shared-pull-push-tok\n",
      { mode: 0o600 },
    );

    const hPull = relayHuman("pull-user", "relay-pull", `file:${pullValidFile}`) as unknown as HumanFragment;
    const hNoTok = relayHuman("notok-user", "relay-pull-notok", `file:${pullNoTokenFile}`) as unknown as HumanFragment;
    const hBadMode = relayHuman("badmode-user", "relay-bad-mode", `file:${badModeFile}`) as unknown as HumanFragment;

    const loaded = loadRelayProfiles(home, { entities: [hPull, hNoTok, hBadMode] });

    const pPull = loaded.get("relay-pull")!;
    expect(pPull.ready).toBe(true);
    expect(pPull.state).toBe("ready");
    expect(pPull.mode).toBe("pull");
    expect(pPull.endpointUrl).toBeNull();
    expect(pPull.warnings).toEqual([]);
    expect(pPull.reason).toBe("relay profile verified (pull outbox mode and inbound token configured)");
    expect(pPull.credentials).toEqual({
      url: null,
      outboundToken: null,
      inboundToken: "pull-inbound-tok-1",
    });
    expect(authenticateRelayInboundToken(loaded, "pull-inbound-tok-1")).toMatchObject({
      ok: true,
      connectorRef: "relay-pull",
    });

    const pNoTok = loaded.get("relay-pull-notok")!;
    expect(pNoTok.ready).toBe(false);
    expect(pNoTok.mode).toBe("pull");
    expect(pNoTok.reason).toMatch(/missing OPENRIG_RELAY_INBOUND_TOKEN/);
    expect(pNoTok.credentials).toBeNull();

    const pBadMode = loaded.get("relay-bad-mode")!;
    expect(pBadMode.ready).toBe(false);
    expect(pBadMode.reason).toMatch(/invalid OPENRIG_RELAY_MODE \(must be 'push' or 'pull'\)/);
    expect(pBadMode.credentials).toBeNull();

    // Cross-profile inbound token collision between pull and push profiles is rejected
    const hDupPull = relayHuman("u-dup-1", "relay-dup-pull", `file:${pullDupA}`) as unknown as HumanFragment;
    const hDupPush = relayHuman("u-dup-2", "relay-dup-push", `file:${pushDupB}`) as unknown as HumanFragment;
    const dupLoaded = loadRelayProfiles(home, { entities: [hDupPull, hDupPush] });
    expect(dupLoaded.get("relay-dup-pull")!.ready).toBe(false);
    expect(dupLoaded.get("relay-dup-pull")!.reason).toMatch(/ambiguous.*OPENRIG_RELAY_INBOUND_TOKEN/i);
    expect(dupLoaded.get("relay-dup-push")!.ready).toBe(false);
    expect(dupLoaded.get("relay-dup-push")!.reason).toMatch(/ambiguous.*OPENRIG_RELAY_INBOUND_TOKEN/i);
  });
});
