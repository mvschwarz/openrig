// The MCP adapter's per-request client tells the daemon whose grant it checked (X-OpenRig-Principal), and only this host's
// own daemon: an endpoint that's forwarded (a loopback port reaching another instance) or remote never receives it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonClient } from "../src/client.js";

const PRINCIPAL = { source: "file" as const, id: "alice" };
const BASE = "http://127.0.0.1:7999";

describe("DaemonClient's principal header goes only to this host's own daemon", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "client-principal-"));
    vi.stubEnv("OPENRIG_HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** The headers of the first daemon request, with the endpoint answering /healthz as `endpointId`. */
  async function headersSent(opts: { direct?: boolean; endpointId?: string; remote?: boolean; principal?: { source: "file" | "grant-service"; id: string } }): Promise<Record<string, string>> {
    vi.stubEnv("OPENRIG_URL", opts.direct ? BASE : "");
    const sent: Array<Record<string, string>> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/healthz")) return Response.json({ ok: true, ...(opts.endpointId ? { selfHostId: opts.endpointId } : {}) });
      sent.push({ ...(init?.headers as Record<string, string>) });
      return Response.json([]);
    }) as typeof fetch;
    const client = new DaemonClient(BASE, { sessionName: "alice@team", principal: opts.principal ?? PRINCIPAL, fetchImpl });
    client.originSelfHostId = "this-host";
    if (opts.remote) client.remoteTarget = true;
    await client.get("/api/queue/list");
    return sent[0]!;
  }

  it("sends it to an endpoint that answers with this host's own id, configured or not", async () => {
    for (const headers of [await headersSent({ endpointId: "this-host" }), await headersSent({ direct: true, endpointId: "this-host" })]) {
      expect(headers["X-OpenRig-Principal"]).toBe(JSON.stringify(PRINCIPAL));
      expect(headers["X-OpenRig-Session"]).toBe("alice@team");
    }
  });

  it("carries a name beyond Latin-1 as JSON escapes, which a real request's headers accept and the daemon parses back", async () => {
    const principal = { source: "file" as const, id: "测试-café" };
    const headers = await headersSent({ endpointId: "this-host", principal });
    const value = headers["X-OpenRig-Principal"]!;
    expect(value).toMatch(/^[\x20-\x7e]*$/);
    expect(() => new Headers(headers)).not.toThrow();
    expect(JSON.parse(value)).toEqual(principal);
  });

  it("never sends it to a forwarded endpoint (another instance's id, or none) or a remote target", async () => {
    for (const headers of [
      await headersSent({ direct: true, endpointId: "other-host" }),
      await headersSent({ direct: true }),
      // rig mcp serve --port <forwarded port>: no OPENRIG_URL, an explicit loopback URL that reaches another instance.
      await headersSent({ endpointId: "other-host" }),
      await headersSent({}),
      await headersSent({ remote: true }),
    ]) {
      expect(headers["X-OpenRig-Principal"]).toBeUndefined();
    }
  });
});
