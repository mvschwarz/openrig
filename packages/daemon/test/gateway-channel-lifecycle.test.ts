import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { loadConfig, saveConfig, DEFAULT_CONFIG } from "../src/domain/gateway/slack/config.js";
import { addHumanFragment, writeProjection } from "../src/domain/gateway/human-registry.js";

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));

function fixture(opts: { registerHuman?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "channel-lifecycle-"));
  homes.push(home);
  if (opts.registerHuman !== false) addHumanFragment({ entityId: "alex", class: "human", displayName: "Alex", address: "alex@external",
    connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "env:private-pointer", role: "primary" }],
    prefs: { deliveryClass: "B" } }, home);
  saveConfig({ ...DEFAULT_CONFIG, secretsEnvFile: "private-pointer", channel: "C-private" }, home);
  const restart = vi.fn();
  const list = vi.fn(() => []);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, { list } as never);
    c.set("gatewaySubsystem" as never, { restart, status: () => ({ state: loadConfig(home).enabled ? "active" : "disabled" }) } as never);
    await next();
  });
  app.route("/", gatewayRoutes({ home }));
  const post = (verb: string, body: object = {}) => app.request(`/slack/${verb}`, {
    method: "POST", headers: { "content-type": "application/json", "x-openrig-session": "operator@rig" }, body: JSON.stringify(body),
  });
  const receipts = () => readFileSync(join(home, "state", "human-channel-operations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { home, app, restart, list, post, receipts };
}

describe("human channel lifecycle at the daemon door", () => {
  it("preserves disabled state when the existing backlog cannot be resolved", async () => {
    const f = fixture();
    writeFileSync(join(f.home, "gateway", "humans.generated.yaml"), "invalid projection");
    const response = await f.post("enable");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "human_registry_unavailable" });
    expect(loadConfig(f.home).enabled).toBe(false);
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.receipts().at(-1)).toMatchObject({ effect: "failed", after: null });
  });
  it("returns actionable JSON when the first enable has no human registry, without applying delivery state", async () => {
    const f = fixture({ registerHuman: false });
    const before = readFileSync(join(f.home, "slack-connector.json"), "utf8");
    const response = await f.post("enable");
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({
      error: "human_registry_unavailable",
      message: expect.stringContaining("rig gateway human add"),
    });
    expect(readFileSync(join(f.home, "slack-connector.json"), "utf8")).toBe(before);
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    expect(existsSync(join(f.home, "state", "slack-outbound-seen.jsonl"))).toBe(false);
    expect(f.receipts().map(row => row.effect)).toEqual(["started", "failed"]);
    expect(f.receipts().at(-1)).toMatchObject({ before: { enabled: false }, after: null });
  });

  it("allows a valid empty registry to seed the backlog", async () => {
    const f = fixture({ registerHuman: false });
    expect(writeProjection(f.home).ok).toBe(true);
    const response = await f.post("enable");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, seeded: 0 });
    expect(loadConfig(f.home).enabled).toBe(true);
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.list).toHaveBeenCalledTimes(1);
  });

  it("keeps enable no-op and disable available when the human registry is missing", async () => {
    const f = fixture({ registerHuman: false });
    saveConfig({ ...loadConfig(f.home), enabled: true }, f.home);
    expect((await f.post("enable")).status).toBe(200);
    expect(f.receipts().at(-1)).toMatchObject({ effect: "no-op" });
    expect(f.restart).not.toHaveBeenCalled();
    expect((await f.post("disable", { reason: "offline maintenance" })).status).toBe(200);
    expect(loadConfig(f.home).enabled).toBe(false);
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.list).not.toHaveBeenCalled();
  });

  it("serializes concurrent enables so a repeat cannot reseed newly pending work", async () => {
    const f = fixture();
    const responses = await Promise.all([f.post("enable"), f.post("enable")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect(f.receipts().filter((row) => row.effect !== "started").map((row) => row.effect)).toEqual(["applied", "no-op"]);
  });
  it("attributes changes, distinguishes repeats, and requires a shutdown reason before changing state", async () => {
    const f = fixture();
    expect((await f.post("enable", { actor: "other@rig", reason: "resume delivery" })).status).toBe(200);
    expect(loadConfig(f.home).enabled).toBe(true);
    expect((await f.post("enable", { reason: "replay" })).status).toBe(200);
    expect(f.restart).toHaveBeenCalledTimes(1);
    expect(f.list).toHaveBeenCalledTimes(1);
    expect((await f.post("disable")).status).toBe(400);
    expect(loadConfig(f.home).enabled).toBe(true);
    expect((await f.post("disable", { reason: "bounded maintenance" })).status).toBe(200);
    expect((await f.post("disable", { reason: "repeat maintenance" })).status).toBe(200);
    expect(f.restart).toHaveBeenCalledTimes(2);
    const rows = f.receipts().filter((row) => row.effect !== "started");
    expect(rows.map((row) => row.effect)).toEqual(["applied", "no-op", "applied", "no-op"]);
    expect(rows[0]).toMatchObject({ actor: "operator@rig", provenance: "transport:v1", reason: "resume delivery", before: { enabled: false }, after: { enabled: true } });
    expect(rows[2]).toMatchObject({ reason: "bounded maintenance", before: { enabled: true }, after: { enabled: false } });
    expect(JSON.stringify(rows)).not.toMatch(/private-pointer|C-private|other@rig/);
  });

  it("requires a recordable actor without inventing an identity", async () => {
    const f = fixture();
    const response = await f.app.request("/slack/enable", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(response.status).toBe(400);
    expect(loadConfig(f.home).enabled).toBe(false);
    expect(f.restart).not.toHaveBeenCalled();
  });
});
