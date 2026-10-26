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
  async function headersSent(opts: { direct?: boolean; endpointId?: string; remote?: boolean }): Promise<Record<string, string>> {
    vi.stubEnv("OPENRIG_URL", opts.direct ? BASE : "");
    const sent: Array<Record<string, string>> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/healthz")) return Response.json({ ok: true, ...(opts.endpointId ? { selfHostId: opts.endpointId } : {}) });
      sent.push({ ...(init?.headers as Record<string, string>) });
      return Response.json([]);
    }) as typeof fetch;
    const client = new DaemonClient(BASE, { sessionName: "alice@team", principal: PRINCIPAL, fetchImpl });
    client.originSelfHostId = "this-host";
    if (opts.remote) client.remoteTarget = true;
    await client.get("/api/queue/list");
    return sent[0]!;
  }

  it("sends it with no direct endpoint configured, or to one that answers with this host's own id", async () => {
    for (const headers of [await headersSent({}), await headersSent({ direct: true, endpointId: "this-host" })]) {
      expect(headers["X-OpenRig-Principal"]).toBe(JSON.stringify(PRINCIPAL));
      expect(headers["X-OpenRig-Session"]).toBe("alice@team");
    }
  });

  it("never sends it to a forwarded endpoint (another instance's id, or none) or a remote target", async () => {
    for (const headers of [
      await headersSent({ direct: true, endpointId: "other-host" }),
      await headersSent({ direct: true }),
      await headersSent({ remote: true }),
    ]) {
      expect(headers["X-OpenRig-Principal"]).toBeUndefined();
    }
  });
});
