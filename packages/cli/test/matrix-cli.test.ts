import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { matrixCommand, type MatrixDeps } from "../src/commands/matrix.js";
import * as surface from "@openrig/daemon/gateway-matrix";
import { createProgram } from "../src/index.js";

let home: string;
let logs: string[];
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "matrix-cli-")); logs = []; process.exitCode = 0; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); process.exitCode = 0; vi.restoreAllMocks(); });
const run = (args: string[], extra: Partial<MatrixDeps> = {}) => matrixCommand({ home, log: (line) => logs.push(line), ...extra }).parseAsync(["node", "matrix", ...args]);
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("rig matrix", () => {
  it("registers setup, status, verify, enable and disable on the real program", () => {
    const cmd = createProgram().commands.find((command) => command.name() === "matrix");
    expect(cmd?.commands.map((command) => command.name())).toEqual(["setup", "status", "verify", "enable", "disable"]);
  });
  it("stores config separately from the token, without making Matrix calls", async () => {
    const fetchImpl = vi.fn(() => { throw new Error("unexpected network"); });
    await run(["setup", "--homeserver-url", "https://matrix.example.org", "--access-token", "test-token", "--default-room", "!room:example.org", "--device-id", "DEVICE"], { fetchImpl });
    expect(process.exitCode).toBe(0);
    const cfg = surface.loadConfig(home);
    expect(cfg).toMatchObject({ deviceId: "DEVICE", defaultRoom: "!room:example.org", enabled: false });
    expect(readFileSync(surface.configPathFor(home), "utf8")).not.toContain("test-token");
    expect(statSync(cfg.secretsEnvFile!).mode & 0o777).toBe(0o600);
    expect(surface.resolveAccessToken({ envFile: cfg.secretsEnvFile, env: {} })).toBe("test-token");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("reports incomplete/offline status without a homeserver call", async () => {
    await run(["status", "--json"], { clientFactory: () => ({ get: vi.fn().mockRejectedValue(new Error("offline")), post: vi.fn() }) });
    expect(JSON.parse(logs[0])).toMatchObject({ configured: false, enabled: false, running: { state: "unavailable" } });
  });
  it("stores a relative secrets path absolutely so another working directory can read it", async () => {
    const file = path.join(home, "shared.env");
    writeFileSync(file, "SLACK_BOT_TOKEN=slack-test-token\n");
    await run(["setup", "--homeserver-url", "https://matrix.example.org", "--secrets-env-file", path.relative(process.cwd(), file), "--access-token", "matrix-test-token"]);
    expect(process.exitCode).toBe(0);
    const cfg = surface.loadConfig(home);
    expect(cfg.secretsEnvFile).toBe(file);
    expect(surface.resolveAccessToken({ envFile: cfg.secretsEnvFile, env: {} })).toBe("matrix-test-token");
    expect(readFileSync(file, "utf8")).toContain("SLACK_BOT_TOKEN=slack-test-token\n");
  });
  it("verifies identity, optionally joins an alias, and sends the test via mocked fetch", async () => {
    surface.saveConfig({ ...surface.DEFAULT_CONFIG, homeserverUrl: "https://matrix.example.org", defaultRoom: "#room:example.org", secretsEnvFile: surface.saveAccessToken("test-token", home) }, home);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => url.endsWith("whoami") ? json({ user_id: "@bot:example.org" })
      : url.includes("/join/") ? json({ room_id: "!room:example.org" }) : url.endsWith("/state") ? json([]) : json({ event_id: "$sent" }));
    await run(["verify", "--join", "--send-test", "--json"], { fetchImpl });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(logs[0])).toMatchObject({ user_id: "@bot:example.org", room: "!room:example.org", testSent: true });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it("sends enable and disable to the daemon with reason and actor", async () => {
    const post = vi.fn().mockResolvedValue({ status: 200, data: { ok: true, onlineStatus: "matrix enabled" } });
    const deps = { clientFactory: () => ({ post, get: vi.fn() }) };
    await run(["enable", "--actor", "operator@kernel"], deps);
    await run(["disable", "--actor", "operator@kernel", "--reason", "maintenance"], deps);
    expect(post.mock.calls.map((call) => call[0])).toEqual(["/api/gateway/matrix/enable", "/api/gateway/matrix/disable"]);
    expect(post.mock.calls[1][1]).toMatchObject({ reason: "maintenance" });
  });
  it("reads a token file and preserves configuration on incremental setup", async () => {
    const tokenFile = path.join(home, "bot-token");
    writeFileSync(tokenFile, "file-token\n");
    await run(["setup", "--homeserver-url", "https://matrix.example.org", "--access-token-file", tokenFile]);
    await run(["setup", "--default-room", "!room:example.org"]);
    expect(process.exitCode).toBe(0);
    const cfg = surface.loadConfig(home);
    expect(cfg).toMatchObject({ homeserverUrl: "https://matrix.example.org", defaultRoom: "!room:example.org" });
    expect(surface.resolveAccessToken({ envFile: cfg.secretsEnvFile, env: {} })).toBe("file-token");
    expect(logs.join("\n")).not.toContain("file-token");
  });
  it("rejects conflicting credentials and an empty token without saving configuration", async () => {
    await run(["setup", "--access-token", "token", "--access-token-file", "unused"]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Choose --access-token or --access-token-file");
    logs = []; process.exitCode = 0;
    await run(["setup", "--access-token", ""]);
    expect(process.exitCode).toBe(1);
    expect(surface.loadConfig(home)).toEqual(surface.DEFAULT_CONFIG);
  });
  it("refuses an encrypted room on join-only verification without sending a test", async () => {
    surface.saveConfig({ ...surface.DEFAULT_CONFIG, homeserverUrl: "https://matrix.example.org", defaultRoom: "!room:example.org", secretsEnvFile: surface.saveAccessToken("test-token", home) }, home);
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => url.endsWith("whoami") ? json({ user_id: "@bot:example.org" })
      : url.includes("/join/") ? json({ room_id: "!room:example.org" }) : json([{ type: "m.room.encryption", state_key: "", content: {} }]));
    await run(["verify", "--join"], { fetchImpl });
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("encrypted rooms are unsupported");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("surfaces token expiry and daemon refusals as failed commands", async () => {
    surface.saveConfig({ ...surface.DEFAULT_CONFIG, homeserverUrl: "https://matrix.example.org", secretsEnvFile: surface.saveAccessToken("test-token", home) }, home);
    await run(["verify"], { fetchImpl: async () => new Response(JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "expired" }), { status: 401 }) });
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("rig matrix setup");
    logs = []; process.exitCode = 0;
    await run(["enable"], { clientFactory: () => ({ get: vi.fn(), post: vi.fn().mockResolvedValue({ status: 503, data: { ok: false } }) }) });
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("HTTP 503");
  });
});
