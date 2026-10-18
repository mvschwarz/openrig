import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { getDaemonStatus, type LifecycleDeps } from "../src/daemon-lifecycle.js";

// OPENRIG_URL=http://host:port/ (trailing slash) addresses the same daemon as
// http://host:port; the CLI must not request //healthz or //api/... from it.
describe("OPENRIG_URL with a trailing slash", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("getDaemonStatus probes <url>/healthz, not <url>//healthz", async () => {
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:7555/");
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: url === "http://127.0.0.1:7555/healthz" };
    });
    const deps = { fetch } as unknown as LifecycleDeps;
    const status = await getDaemonStatus(deps);
    expect(urls).toEqual(["http://127.0.0.1:7555/healthz"]);
    expect(status).toMatchObject({ state: "running", healthy: true, port: 7555, host: "127.0.0.1" });
  });

  it("a default DaemonClient requests <url>/api/..., not <url>//api/...", async () => {
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:7555//");
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new DaemonClient(undefined, { fetchImpl });
    await client.get("/api/ps");
    expect(urls).toContain("http://127.0.0.1:7555/api/ps");
    expect(urls.some((url) => url.includes("7555//"))).toBe(false);
  });
});
