// Test suite for plugin-primitive Phase 3a slice 3.2 Phase 2 — PluginVendorService
// (vendoring + auto-fetch with 404-tolerant fallback).
//
// Per IMPL-PRD §2.5 + DESIGN.md §5.5 + orch-lead 2026-05-10:
//   - vendored copy is source of truth at v0
//   - auto-fetch tolerates 404 + falls back to vendored
//   - repo (github.com/mvschwarz/openrig-plugins) currently empty (LICENSE only)
//   - 5s network timeout per IMPL-PRD §2.5
//   - silent fallback on any failure
//
// Service responsibilities (HG-2.3, HG-2.4, HG-2.5):
//   1. ensureVendored(): copy from packages/daemon/assets/plugins/<name>/
//      to ~/.openrig/plugins/<name>/ on first launch (idempotent: hash-skip
//      if already vendored at same content)
//   2. attemptAutoFetch(): try fetch from github.com/mvschwarz/openrig-plugins;
//      tolerate 404/network/timeout; log outcome; never throw
//   3. ensureLatest(): orchestrates ensureVendored + attemptAutoFetch

import { describe, it, expect, vi } from "vitest";
import { PluginVendorService } from "../src/domain/plugin-vendor-service.js";

// Injectable fs ops for test mock
function mockFs(initialFiles?: Record<string, string>) {
  const store: Record<string, string> = { ...initialFiles };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store || Object.keys(store).some((k) => k.startsWith(p + "/")),
    mkdirp: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    rmrf: (p: string) => {
      for (const k of Object.keys(store)) {
        if (k === p || k.startsWith(p + "/")) delete store[k];
      }
    },
    _store: store,
  };
}

const VENDORED_OPENRIG_CORE = {
  "/asset-root/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
  "/asset-root/openrig-core/.codex-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0","description":"v"}',
  "/asset-root/openrig-core/skills/openrig-user/SKILL.md": "# openrig-user vendored",
  "/asset-root/openrig-core/hooks/claude.json": '{"hooks":{}}',
};

describe("PluginVendorService — vendoring (HG-2.3)", () => {
  it("ensureVendored copies vendored asset tree to user plugin dir on first launch", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");

    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0"}');
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.codex-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0","description":"v"}');
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/skills/openrig-user/SKILL.md"]).toBe("# openrig-user vendored");
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/hooks/claude.json"]).toBe('{"hooks":{}}');
  });

  it("ensureVendored is idempotent — re-running with same content does not re-write (hash-skip)", async () => {
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
      "/home/test/.openrig/plugins/openrig-core/.codex-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0","description":"v"}',
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-user/SKILL.md": "# openrig-user vendored",
      "/home/test/.openrig/plugins/openrig-core/hooks/claude.json": '{"hooks":{}}',
    });
    const writeCounts: Record<string, number> = {};
    const origWrite = fs.writeFile;
    fs.writeFile = (p: string, c: string) => { writeCounts[p] = (writeCounts[p] ?? 0) + 1; origWrite(p, c); };

    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");

    // Hash-match → no writes
    expect(Object.values(writeCounts).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("ensureVendored skips silently when vendored asset doesn't exist (no source to copy)", async () => {
    const fs = mockFs({});
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await expect(svc.ensureVendored("nonexistent-plugin")).resolves.not.toThrow();
    expect(fs._store["/home/test/.openrig/plugins/nonexistent-plugin/anything"]).toBeUndefined();
  });
});

describe("PluginVendorService — auto-fetch (HG-2.4 + HG-2.5)", () => {
  it("attemptAutoFetch tolerates 404 silently — does not throw, falls back to vendored (HG-2.5)", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const logger = vi.fn();
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger,
    });

    await expect(svc.attemptAutoFetch("openrig-core")).resolves.not.toThrow();
    // Vendored copy still available (404-tolerant fallback contract)
    expect(fs._store["/asset-root/openrig-core/.claude-plugin/plugin.json"]).toBeDefined();
  });

  it("attemptAutoFetch tolerates network errors silently (DNS / connection refused / etc.)", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockRejectedValue(new Error("ENOTFOUND github.com"));
    const logger = vi.fn();
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger,
    });

    await expect(svc.attemptAutoFetch("openrig-core")).resolves.not.toThrow();
  });

  it("attemptAutoFetch tolerates 5s timeout silently (slow network)", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 100)));
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await expect(svc.attemptAutoFetch("openrig-core")).resolves.not.toThrow();
  });

  it("attemptAutoFetch logs outcome (success or fallback) for operator observability", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const logger = vi.fn();
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger,
    });

    await svc.attemptAutoFetch("openrig-core");

    // Some log call describing the outcome (404, fallback, etc.)
    expect(logger).toHaveBeenCalled();
    const allLogs = logger.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allLogs).toMatch(/openrig-core|404|fallback|fetch/i);
  });

  it("attemptAutoFetch hits the github.com/mvschwarz/openrig-plugins URL (or release tarball pattern)", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await svc.attemptAutoFetch("openrig-core");

    expect(httpClient).toHaveBeenCalled();
    const url = httpClient.mock.calls[0]?.[0] as string;
    expect(url).toMatch(/github\.com\/mvschwarz\/openrig-plugins|api\.github\.com.*mvschwarz\/openrig-plugins/);
  });
});

describe("PluginVendorService — ensureLatest orchestration", () => {
  it("ensureLatest calls ensureVendored first then attemptAutoFetch (vendored fallback ALWAYS available)", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await svc.ensureLatest("openrig-core");

    // Vendored copy lands first (so fallback is always there even if fetch fails)
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json"]).toBeDefined();
    // And fetch was attempted
    expect(httpClient).toHaveBeenCalled();
  });

  it("ensureLatest returns successfully even when fetch 404s + vendored exists", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const httpClient = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await expect(svc.ensureLatest("openrig-core")).resolves.not.toThrow();
  });
});
