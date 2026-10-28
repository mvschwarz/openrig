import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/client.js";
import { getDaemonStatus, stopDaemon, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { normalizeOpenRigUrl } from "../src/openrig-compat.js";
import { resolveStartupProofEndpoint } from "../src/commands/startup-proof.js";
import { crashCartEvidenceUrl } from "../src/commands/crash-cart.js";

// OPENRIG_URL=http://host:port/ (trailing slash) addresses the same daemon as
// http://host:port; the CLI must not request //healthz or //api/... from it.
describe("OPENRIG_URL with a trailing slash", () => {
  afterEach(() => vi.unstubAllEnvs());

  function probeDeps(ok: (url: string) => boolean) {
    const urls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: ok(url) };
    });
    const exists = vi.fn(() => false);
    const readFile = vi.fn(() => null);
    return { urls, exists, readFile, deps: { fetch, exists, readFile } as unknown as LifecycleDeps };
  }

  it.each([
    ["http://127.0.0.1:7433/", "http://127.0.0.1:7433"],
    ["http://127.0.0.1:7433//", "http://127.0.0.1:7433"],
    ["http://h:7433/p/", "http://h:7433/p"],
    ["https://h/", "https://h"],
    ["http://h:7433/?a=b/", "http://h:7433/?a=b/"],
    ["http://h:7433/p/?x", "http://h:7433/p/?x"],
    ["http://h:7433/p/#x/", "http://h:7433/p/#x/"],
    ["http://h:7433", "http://h:7433"],
    ["/", "/"],
    ["//", "//"],
    ["http://", "http://"],
  ])("normalizeOpenRigUrl(%s) is %s (a query or fragment URL stays as written)", (raw, normalized) => {
    expect(normalizeOpenRigUrl(raw)).toBe(normalized);
  });

  it("getDaemonStatus probes <origin>/healthz, not <origin>//healthz", async () => {
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:7555/");
    const { urls, deps } = probeDeps((url) => url === "http://127.0.0.1:7555/healthz");
    const status = await getDaemonStatus(deps);
    expect(urls).toEqual(["http://127.0.0.1:7555/healthz"]);
    expect(status).toMatchObject({ state: "running", healthy: true, port: 7555, host: "127.0.0.1" });
  });

  // Commands reach OPENRIG_URL through getDaemonUrl's http://host:port rebuild, so the probe
  // only changes for a plain http origin; a prefix or https URL is probed exactly as before.
  it.each([
    ["http://127.0.0.1:7555/p/", "http://127.0.0.1:7555/p//healthz"],
    ["https://127.0.0.1:7555/", "https://127.0.0.1:7555//healthz"],
    ["http://127.0.0.1:7555/?x=1", "http://127.0.0.1:7555/?x=1/healthz"],
    // No explicit port (or :80, which URL reports as none): status would hand commands 7433,
    // so the probe must not succeed on port 80 for them.
    ["http://127.0.0.1/", "http://127.0.0.1//healthz"],
    ["http://127.0.0.1:80/", "http://127.0.0.1:80//healthz"],
  ])("getDaemonStatus probes %s as main does (%s)", async (url, probed) => {
    vi.stubEnv("OPENRIG_URL", url);
    const { urls, deps } = probeDeps(() => false);
    await getDaemonStatus(deps);
    expect(urls).toEqual([probed]);
  });

  it("a slash-only OPENRIG_URL stays an explicit target and never selects the local daemon", async () => {
    vi.stubEnv("OPENRIG_URL", "/");
    const { urls, exists, readFile, deps } = probeDeps(() => true);
    await getDaemonStatus(deps);
    expect(urls).toEqual(["//healthz"]);
    expect(exists).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(new DaemonClient().baseUrl).toBe("/");
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

  it("a default DaemonClient keeps a path prefix and scheme", () => {
    vi.stubEnv("OPENRIG_URL", "https://h:7433/p/");
    expect(new DaemonClient().baseUrl).toBe("https://h:7433/p");
  });

  it("the startup-proof endpoint reads OPENRIG_URL through the same normalization", () => {
    const endpoint = resolveStartupProofEndpoint({
      env: { OPENRIG_URL: "http://127.0.0.1:7555/", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" },
      readFile: () => { throw new Error("no endpoint file"); },
    });
    expect(endpoint).toEqual({ baseUrl: "http://127.0.0.1:7555", token: "tok" });
  });

  it.each([
    ["http://127.0.0.1:7555/p/?x=1", "http://127.0.0.1:7555/p/?x=1/api/ps"],
    ["http://127.0.0.1:7555/p/#frag", "http://127.0.0.1:7555/p/#frag/api/ps"],
  ])("a default DaemonClient keeps main's base for %s", async (url, requested) => {
    vi.stubEnv("OPENRIG_URL", url);
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      urls.push(String(u));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = new DaemonClient(undefined, { fetchImpl });
    expect(client.baseUrl).toBe(url);
    await client.get("/api/ps");
    expect(urls).toContain(requested);
  });

  it("the startup-proof endpoint picks RIGGED_URL like every other reader when OPENRIG_URL is empty", () => {
    const endpoint = resolveStartupProofEndpoint({
      env: { OPENRIG_URL: "", RIGGED_URL: "http://127.0.0.1:7556/", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" },
      readFile: () => { throw new Error("no endpoint file"); },
    });
    expect(endpoint).toEqual({ baseUrl: "http://127.0.0.1:7556", token: "tok" });
  });

  it.each([
    [{ OPENRIG_URL: "   ", RIGGED_URL: "http://127.0.0.1:7556" }, "http://127.0.0.1:7556"],
    [{ OPENRIG_URL: " http://127.0.0.1:7555/ " }, "http://127.0.0.1:7555"],
  ])("the startup-proof endpoint trims and skips blank URLs as before (%o)", (urls, baseUrl) => {
    const endpoint = resolveStartupProofEndpoint({
      env: { ...urls, OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" },
      readFile: () => { throw new Error("no endpoint file"); },
    });
    expect(endpoint).toEqual({ baseUrl, token: "tok" });
  });

  // The shared reader leaves a query or fragment URL as written, so these two callers keep main's own trim before
  // /healthz: rig daemon stop trims every trailing slash, and crash-cart's evidence probe one, as its detector does.
  it.each([
    ["http://127.0.0.1:7555/?x=1/", "http://127.0.0.1:7555/?x=1/healthz"],
    ["http://127.0.0.1:7555/?x=1///", "http://127.0.0.1:7555/?x=1/healthz"],
    ["http://127.0.0.1:7555/#frag/", "http://127.0.0.1:7555/#frag/healthz"],
  ])("rig daemon stop with OPENRIG_URL=%s checks %s", async (url, check) => {
    vi.stubEnv("OPENRIG_URL", url);
    const { urls, deps } = probeDeps(() => true);
    await expect(stopDaemon(deps)).rejects.toThrow(`Checked ${check};`);
    expect(urls).toEqual([check]);
  });

  it.each([
    ["http://127.0.0.1:7555/?x=1/", "http://127.0.0.1:7555/?x=1/healthz"],
    ["http://127.0.0.1:7555/?x=1//", "http://127.0.0.1:7555/?x=1//healthz"],
    ["http://127.0.0.1:7555/#frag/", "http://127.0.0.1:7555/#frag/healthz"],
  ])("crash-cart's evidence probe for OPENRIG_URL=%s is %s", (url, probe) => {
    expect(crashCartEvidenceUrl(normalizeOpenRigUrl(url), undefined)).toBe(probe);
  });
});
