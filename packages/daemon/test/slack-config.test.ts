import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig, configFileExists, staticReadiness, DEFAULT_CONFIG } from "../src/domain/gateway/slack/config.js";
import { parseEnvFile, resolveSecret, checkEnvFilePermissions, type SecretFsOps } from "../src/domain/gateway/slack/secrets.js";

describe("Slice-11 config — first-class + honest unconfigured (item 5)", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "slice11-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("loadConfig returns defaults when absent (no throw); inbound-dest first-class default", () => {
    expect(configFileExists(home)).toBe(false);
    const cfg = loadConfig(home);
    expect(cfg.enabled).toBe(false);
    expect(cfg.inboundDestination).toBe("operator-agent@kernel");
    expect(cfg.alertTag).toBe("founder-alert");
  });

  it("save + reload round-trips; inbound destination is overridable (T1075)", () => {
    const p = saveConfig({ ...DEFAULT_CONFIG, inboundDestination: "ops-desk@kernel", channel: "C123", enabled: true }, home);
    expect(fs.existsSync(p)).toBe(true);
    const cfg = loadConfig(home);
    expect(cfg.inboundDestination).toBe("ops-desk@kernel");
    expect(cfg.channel).toBe("C123");
    expect(cfg.enabled).toBe(true);
    // config file carries NO secret values (only refs) — item 10
    const raw = fs.readFileSync(p, "utf8");
    expect(raw).not.toMatch(/xox[bp]-|xapp-|hooks\.slack\.com/);
  });

  it("staticReadiness honestly reports what's missing without throwing (S10: bot+channel gate outbound; webhook retired)", () => {
    const cfg = loadConfig(home);
    const r = staticReadiness(cfg, /*bot*/ false, /*app*/ false);
    const byLabel = Object.fromEntries(r.map((x) => [x.label, x.ok]));
    expect(byLabel["bot-token"]).toBe(false);
    expect(byLabel["app-token (Socket Mode)"]).toBe(false);
    expect(byLabel["enabled"]).toBe(false);
    expect(byLabel["outbound-webhook"]).toBeUndefined(); // the webhook row retired with the relay
    // when secrets resolve, those flip
    const r2 = staticReadiness({ ...cfg, channel: "C1", enabled: true }, true, true);
    const by2 = Object.fromEntries(r2.map((x) => [x.label, x.ok]));
    expect(by2["bot-token"] && by2["app-token (Socket Mode)"] && by2["channel"] && by2["enabled"]).toBe(true);
  });
});

describe("Slice-11 secrets — resolution + hygiene (item 7 + 10)", () => {
  it("parseEnvFile parses KEY=VALUE, trims quotes, ignores comments/blanks", () => {
    const m = parseEnvFile('# c\nSLACK_WEBHOOK_URL="https://x"\n\nSLACK_APP_TOKEN=xapp-1\nbad line\n');
    expect(m.SLACK_WEBHOOK_URL).toBe("https://x");
    expect(m.SLACK_APP_TOKEN).toBe("xapp-1");
    expect(Object.keys(m)).toHaveLength(2);
  });

  it("resolveSecret: env var wins; env-file fallback; null when unset", () => {
    const fsops: SecretFsOps = { readFileSync: () => "SLACK_WEBHOOK_URL=https://from-file", statMode: () => 0o600 };
    // env var precedence
    expect(resolveSecret("SLACK_WEBHOOK_URL", { env: { SLACK_WEBHOOK_URL: "https://from-env" }, envFile: "/x", fsops })).toBe("https://from-env");
    // env-file fallback
    expect(resolveSecret("SLACK_WEBHOOK_URL", { env: {}, envFile: "/x", fsops })).toBe("https://from-file");
    // B4: the NORMAL OPENRIG_SLACK_* alias (OPENRIG_ + name) resolves
    expect(resolveSecret("SLACK_APP_TOKEN", { env: { OPENRIG_SLACK_APP_TOKEN: "xapp-EXAMPLE-fake" } })).toBe("xapp-EXAMPLE-fake");
    expect(resolveSecret("SLACK_WEBHOOK_URL", { env: { OPENRIG_SLACK_WEBHOOK_URL: "https://from-alias" } })).toBe("https://from-alias");
    // B4 regression pin: the DOUBLED OPENRIG_SLACK_SLACK_* form must NOT resolve
    expect(resolveSecret("SLACK_APP_TOKEN", { env: { OPENRIG_SLACK_SLACK_APP_TOKEN: "doubled-wrong" } })).toBeNull();
    // unresolved → null (honest)
    expect(resolveSecret("MISSING", { env: {} })).toBeNull();
  });

  it("checkEnvFilePermissions flags group/world-readable secret files (item 10)", () => {
    const strict: SecretFsOps = { readFileSync: () => "", statMode: () => 0o600 };
    const loose: SecretFsOps = { readFileSync: () => "", statMode: () => 0o644 };
    const absent: SecretFsOps = { readFileSync: () => "", statMode: () => null };
    expect(checkEnvFilePermissions("/s.env", strict)).toBeNull();
    expect(checkEnvFilePermissions("/s.env", loose)).toMatch(/0600/);
    expect(checkEnvFilePermissions("/s.env", absent)).toBeNull();
  });
});
