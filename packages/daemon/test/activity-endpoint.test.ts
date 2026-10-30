// OPR.0.4.3.28 B2 — the daemon self-provisioned activity-hook token + endpoint.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { expectPrivateFile } from "./helpers/private-file.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { ensureActivityHookToken, writeActivityEndpointFile, readActivityEndpointFile, deriveActivityUrl } from "../src/domain/activity-endpoint.js";

describe("activity-endpoint (OPR.0.4.3.28 B2)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-s28-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("generates a token when none is persisted, and persists it mode-0600", () => {
    const token = ensureActivityHookToken(stateDir);
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes hex
    const tokenPath = nodePath.join(stateDir, "activity-hook-token");
    expect(fs.existsSync(tokenPath)).toBe(true);
    expect(fs.readFileSync(tokenPath, "utf-8").trim()).toBe(token);
    // mode-guarded (owner-only)
    expectPrivateFile(tokenPath);
  });

  it("REUSES the persisted token across calls (stable across daemon restarts)", () => {
    const first = ensureActivityHookToken(stateDir);
    const second = ensureActivityHookToken(stateDir); // simulates a later daemon boot
    expect(second).toBe(first);
  });

  it("writes + reads back the endpoint snapshot {baseUrl, token}", () => {
    writeActivityEndpointFile(stateDir, { baseUrl: "http://127.0.0.1:7433", token: "abc123" });
    const endpointPath = nodePath.join(stateDir, "activity-endpoint.json");
    expectPrivateFile(endpointPath);
    const read = readActivityEndpointFile(stateDir);
    expect(read).toEqual({ baseUrl: "http://127.0.0.1:7433", token: "abc123" });
  });

  // OPR.0.4.3.28 Blocker 2 — the URL must honor an explicit daemon bind host
  // (the daemon binds only that host), with wildcard/absent → loopback.
  it("deriveActivityUrl uses an explicit (tailnet/hostname) host verbatim", () => {
    expect(deriveActivityUrl("100.64.0.5", "7433")).toBe("http://100.64.0.5:7433");
    expect(deriveActivityUrl("my-box.tail-scale.ts.net", "7433")).toBe("http://my-box.tail-scale.ts.net:7433");
    expect(deriveActivityUrl("localhost", "7433")).toBe("http://localhost:7433");
  });

  it.runIf(process.platform === "win32")("seals an existing token without rotating the value inherited by running seats", () => {
    const file = nodePath.join(stateDir, "activity-hook-token");
    fs.writeFileSync(file, "synthetic-existing-token");
    expect(ensureActivityHookToken(stateDir)).toBe("synthetic-existing-token");
    expect(fs.readFileSync(file, "utf8")).toBe("synthetic-existing-token");
    expectPrivateFile(file);
  });

  it.runIf(process.platform === "win32")("keeps the prior endpoint and removes owned staging if atomic publication fails", () => {
    const prior = { baseUrl: "http://127.0.0.1:17401", token: "synthetic-old" };
    writeActivityEndpointFile(stateDir, prior);
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("owned publication blocked"); });
    writeActivityEndpointFile(stateDir, { baseUrl: "http://127.0.0.1:17402", token: "synthetic-next" });
    expect(readActivityEndpointFile(stateDir)).toEqual(prior);
    expect(fs.readdirSync(stateDir)).toEqual(["activity-endpoint.json"]);
    expectPrivateFile(nodePath.join(stateDir, "activity-endpoint.json"));
  });

  it("updates the endpoint snapshot with exact values", () => {
    writeActivityEndpointFile(stateDir, { baseUrl: "http://127.0.0.1:17401", token: "synthetic-old" });
    const next = { baseUrl: "http://127.0.0.1:17402", token: "synthetic-next-Ω" };
    writeActivityEndpointFile(stateDir, next);
    expect(readActivityEndpointFile(stateDir)).toEqual(next);
    expectPrivateFile(nodePath.join(stateDir, "activity-endpoint.json"));
  });

  it("deriveActivityUrl brackets specific IPv6 hosts (#493)", () => {
    expect(deriveActivityUrl("::1", "7433")).toBe("http://[::1]:7433");
    expect(deriveActivityUrl("2001:db8::1", "9000")).toBe("http://[2001:db8::1]:9000");
    expect(deriveActivityUrl("[::1]", "7433")).toBe("http://[::1]:7433");
  });

  it("deriveActivityUrl maps wildcard/bind-all hosts to loopback (not connectable)", () => {
    expect(deriveActivityUrl("0.0.0.0", "7433")).toBe("http://127.0.0.1:7433");
    expect(deriveActivityUrl("::", "7433")).toBe("http://127.0.0.1:7433");
  });

  it("deriveActivityUrl falls back to loopback + DEFAULT_PORT when host/port absent", () => {
    expect(deriveActivityUrl(undefined, undefined)).toBe("http://127.0.0.1:7433");
    expect(deriveActivityUrl(undefined, "9001")).toBe("http://127.0.0.1:9001");
  });

  it("readActivityEndpointFile returns null when absent or malformed", () => {
    expect(readActivityEndpointFile(stateDir)).toBeNull();
    fs.writeFileSync(nodePath.join(stateDir, "activity-endpoint.json"), "{not json");
    expect(readActivityEndpointFile(stateDir)).toBeNull();
    fs.writeFileSync(nodePath.join(stateDir, "activity-endpoint.json"), JSON.stringify({ baseUrl: "" }));
    expect(readActivityEndpointFile(stateDir)).toBeNull();
  });
});
