// Test suite for plugin-primitive Phase 3a slice 3.2 Phase 2 — PluginVendorService
// (vendoring + auto-fetch with 404-tolerant fallback).
//
// Per IMPL-PRD §2.5 + DESIGN.md §5.5 + orch-lead 2026-05-10:
//   - vendored copy seeds an absent install; manifest version decides upgrades
//   - auto-fetch tolerates 404 + falls back to vendored
//   - repo (github.com/mvschwarz/openrig-plugins) currently empty (LICENSE only)
//   - 5s network timeout per IMPL-PRD §2.5
//   - silent fallback on any failure
//
// Service responsibilities (HG-2.3, HG-2.4, HG-2.5):
//   1. ensureVendored(): copy from packages/daemon/assets/plugins/<name>/
//      to ~/.openrig/plugins/<name>/ when absent or strictly newer
//   2. attemptAutoFetch(): try fetch from github.com/mvschwarz/openrig-plugins;
//      tolerate 404/network/timeout; log outcome; never throw
//   3. ensureLatest(): orchestrates ensureVendored + attemptAutoFetch

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
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
  "/asset-root/openrig-core/skills/openrig-skills/SKILL.md": "# openrig-skills index",
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
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md": "# openrig-skills index",
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

  it("does not let an older bundled plugin overwrite a newer installed plugin", async () => {
    const installedSkill = "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md";
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.2.0"}',
      [installedSkill]: "# newer installed canon",
    });
    const logger = vi.fn();
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger,
    });

    await svc.ensureVendored("openrig-core");

    expect(fs._store[installedSkill]).toBe("# newer installed canon");
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json"]).toContain('"0.2.0"');
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/not newer.*unchanged/i));
  });

  it("does not replace different installed bytes at the same plugin version", async () => {
    const installedSkill = "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md";
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
      [installedSkill]: "# same-version installed authority",
    });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");

    expect(fs._store[installedSkill]).toBe("# same-version installed authority");
  });

  it("upgrades an older installed plugin only when the bundled manifest version is newer", async () => {
    const source = {
      ...VENDORED_OPENRIG_CORE,
      "/asset-root/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.2.0"}',
      "/asset-root/openrig-core/.codex-plugin/plugin.json": '{"name":"openrig-core","version":"0.2.0"}',
      "/asset-root/openrig-core/skills/openrig-skills/SKILL.md": "# bundled 0.2.0",
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md": "# installed 0.1.0",
    };
    const fs = mockFs(source);
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");

    expect(fs._store["/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md"]).toBe("# bundled 0.2.0");
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json"]).toContain('"0.2.0"');
  });

  it("the shipped core upgrades 0.1.5 installs to daemon-publication instructions", async () => {
    const source = "/asset-root/openrig-core";
    const target = "/home/test/.openrig/plugins/openrig-core";
    const skill = "skills/claude-compaction-restore/SKILL.md";
    const files = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", skill];
    const bundled = Object.fromEntries(files.map(rel => [
      `${source}/${rel}`,
      readFileSync(new URL(`../assets/plugins/openrig-core/${rel}`, import.meta.url), "utf8"),
    ]));
    const fs = mockFs({
      ...bundled,
      [`${target}/.claude-plugin/plugin.json`]: '{"name":"openrig-core","version":"0.1.5"}',
      [`${target}/.codex-plugin/plugin.json`]: '{"name":"openrig-core","version":"0.1.5"}',
      [`${target}/${skill}`]: "Old instruction: atomically rename the map yourself.",
    });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root", userPluginsDir: "/home/test/.openrig/plugins",
      fs, httpClient: vi.fn(),
    });
    await svc.ensureVendored("openrig-core");
    for (const rel of files) expect(fs._store[`${target}/${rel}`]).toBe(bundled[`${source}/${rel}`]);
    expect(fs._store[`${target}/${skill}`]).toContain("The daemon publishes");
  });

  // #1077 — the relay forwards SessionStart's source, the occupant generation and the resume launch
  // marker. An install at the previous version must receive it rather than keep the old relay.
  it("the shipped core upgrades 0.1.8 installs to the relay that forwards resume launch evidence", async () => {
    const source = "/asset-root/openrig-core";
    const target = "/home/test/.openrig/plugins/openrig-core";
    const relay = "hooks/scripts/activity-relay.cjs";
    const files = [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", relay];
    const bundled = Object.fromEntries(files.map(rel => [
      `${source}/${rel}`,
      readFileSync(new URL(`../assets/plugins/openrig-core/${rel}`, import.meta.url), "utf8"),
    ]));
    for (const manifest of files.slice(0, 2)) {
      expect(JSON.parse(bundled[`${source}/${manifest}`]!).version).not.toBe("0.1.8");
    }
    const fs = mockFs({
      ...bundled,
      [`${target}/.claude-plugin/plugin.json`]: '{"name":"openrig-core","version":"0.1.8"}',
      [`${target}/.codex-plugin/plugin.json`]: '{"name":"openrig-core","version":"0.1.8"}',
      [`${target}/${relay}`]: "// 0.1.8 relay: session id only",
    });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root", userPluginsDir: "/home/test/.openrig/plugins",
      fs, httpClient: vi.fn(),
    });
    await svc.ensureVendored("openrig-core");
    for (const rel of files) expect(fs._store[`${target}/${rel}`]).toBe(bundled[`${source}/${rel}`]);
    expect(fs._store[`${target}/${relay}`]).toContain("OPENRIG_RESUME_LAUNCH");
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

  it("projects a plugin seed skill into both harness-global skill roots", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");
    svc.ensureSkillGlobally("openrig-core", "openrig-skills", [
      "/home/test/.claude/skills",
      "/home/test/.agents/skills",
    ]);

    expect(fs._store["/home/test/.claude/skills/openrig-skills/SKILL.md"]).toBe("# openrig-skills index");
    expect(fs._store["/home/test/.agents/skills/openrig-skills/SKILL.md"]).toBe("# openrig-skills index");
  });

  it("does not overwrite a pre-existing unversioned global skill target", async () => {
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md": "# bundled older",
      "/home/test/.agents/skills/openrig-skills/SKILL.md": "# externally managed newer canon",
    });
    const logger = vi.fn();
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger,
    });

    svc.ensureSkillGlobally("openrig-core", "openrig-skills", ["/home/test/.agents/skills"]);

    expect(fs._store["/home/test/.agents/skills/openrig-skills/SKILL.md"]).toBe("# externally managed newer canon");
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/unversioned\/external authority.*unchanged/i));
  });

  it("projects globally only when the bundled plugin version is newer than the target marker", async () => {
    const marker = "/home/test/.agents/skills/openrig-skills/.openrig-vendor-version";
    const skill = "/home/test/.agents/skills/openrig-skills/SKILL.md";
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.2.0"}',
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md": "# bundled 0.2.0",
      [marker]: "0.1.0\n",
      [skill]: "# projected 0.1.0",
    });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    svc.ensureSkillGlobally("openrig-core", "openrig-skills", ["/home/test/.agents/skills"]);

    expect(fs._store[skill]).toBe("# bundled 0.2.0");
    expect(fs._store[marker]).toBe("0.2.0\n");
  });

  it("does not overwrite an equal or newer globally projected skill", async () => {
    const marker = "/home/test/.agents/skills/openrig-skills/.openrig-vendor-version";
    const skill = "/home/test/.agents/skills/openrig-skills/SKILL.md";
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
      "/home/test/.openrig/plugins/openrig-core/skills/openrig-skills/SKILL.md": "# bundled 0.1.0",
      [marker]: "0.2.0\n",
      [skill]: "# projected 0.2.0",
    });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    svc.ensureSkillGlobally("openrig-core", "openrig-skills", ["/home/test/.agents/skills"]);

    expect(fs._store[skill]).toBe("# projected 0.2.0");
    expect(fs._store[marker]).toBe("0.2.0\n");
  });

  it("fails loudly when the required global seed is missing from the vendored plugin", async () => {
    const fs = mockFs(VENDORED_OPENRIG_CORE);
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
      logger: vi.fn(),
    });

    await svc.ensureVendored("openrig-core");
    expect(() =>
      svc.ensureSkillGlobally("openrig-core", "missing-seed", [
        "/home/test/.claude/skills",
        "/home/test/.agents/skills",
      ]),
    ).toThrow(/missing-seed/);
  });

  // The person-facing rigs skill installs from its packaged folder under OpenRig's own version.
  const RIGS = "/pkg/daemon/assets/skills/rigs";
  const service = (fs: ReturnType<typeof mockFs>, logger = vi.fn()) => new PluginVendorService({
    vendoredAssetsDir: "/asset-root",
    userPluginsDir: "/home/test/.openrig/plugins",
    fs,
    httpClient: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    logger,
  });

  it("projects a skill folder under an explicit version and leaves a copy installed another way alone", () => {
    const fs = mockFs({
      [`${RIGS}/SKILL.md`]: "# rigs 0.6.7",
      "/home/test/.agents/skills/rigs/SKILL.md": "# rigs installed by skills.sh",
    });
    const logger = vi.fn();

    service(fs, logger).ensureSkillDirGlobally(RIGS, "rigs", "0.6.7", ["/home/test/.claude/skills", "/home/test/.agents/skills"]);

    expect(fs._store["/home/test/.claude/skills/rigs/SKILL.md"]).toBe("# rigs 0.6.7");
    expect(fs._store["/home/test/.claude/skills/rigs/.openrig-vendor-version"]).toBe("0.6.7\n");
    expect(fs._store["/home/test/.agents/skills/rigs/SKILL.md"]).toBe("# rigs installed by skills.sh");
    expect(fs._store["/home/test/.agents/skills/rigs/.openrig-vendor-version"]).toBeUndefined();
    expect(logger).toHaveBeenCalledWith(expect.stringMatching(/'rigs'.*unversioned\/external authority.*unchanged/i));
  });

  it("refreshes a projected skill folder on a newer version, keeps it on an equal one, and refuses a version that isn't x.y.z", () => {
    const marker = "/home/test/.claude/skills/rigs/.openrig-vendor-version";
    const skill = "/home/test/.claude/skills/rigs/SKILL.md";
    const fs = mockFs({ [`${RIGS}/SKILL.md`]: "# rigs 0.6.8", [marker]: "0.6.7\n", [skill]: "# rigs 0.6.7" });
    const svc = service(fs);

    svc.ensureSkillDirGlobally(RIGS, "rigs", "0.6.8", ["/home/test/.claude/skills"]);
    expect(fs._store[skill]).toBe("# rigs 0.6.8");
    expect(fs._store[marker]).toBe("0.6.8\n");

    fs._store[`${RIGS}/SKILL.md`] = "# rigs edited, same version";
    svc.ensureSkillDirGlobally(RIGS, "rigs", "0.6.8", ["/home/test/.claude/skills"]);
    expect(fs._store[skill]).toBe("# rigs 0.6.8");

    expect(() => svc.ensureSkillDirGlobally(RIGS, "rigs", "unknown", ["/home/test/.claude/skills"])).toThrow(/invalid version 'unknown'/);
    expect(fs._store[marker]).toBe("0.6.8\n");
  });

  it("fails loudly when a skill folder to project is missing", () => {
    expect(() => service(mockFs()).ensureSkillDirGlobally(RIGS, "rigs", "0.6.7", ["/home/test/.claude/skills"])).toThrow(/'rigs' is missing at/);
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

  it("attemptAutoFetch passes timeoutMs=5000 to httpClient (per IMPL-PRD §2.5 5s timeout)", async () => {
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
    const opts = httpClient.mock.calls[0]?.[1] as { timeoutMs?: number } | undefined;
    expect(opts?.timeoutMs).toBe(5000);
  });

  it("attemptAutoFetch v0 success-path is probe-only — does NOT extract tarball or update vendored copy", async () => {
    // Per slice-3.2 v0 scope (per orch-lead 2026-05-10 + velocity-guard 60344b3 BLOCKING-CONCERN):
    //   - 404 is the expected normal-state response (repo currently empty per founder authorization)
    //   - Even on a 200 success, v0 does NOT extract or update — extraction/version-compare/update
    //     is explicitly scoped to slice 3.6 (marketplace-consumption phase)
    // This test pins the v0 contract so an accidental "implement extract" lands as a TDD-red
    // signal in slice 3.6 (where it's intentional) rather than silently in 3.2.
    const initialUserPlugin = "/home/test/.openrig/plugins/openrig-core/.claude-plugin/plugin.json";
    const initialContent = '{"name":"openrig-core","version":"0.1.0"}';
    const fs = mockFs({
      ...VENDORED_OPENRIG_CORE,
      [initialUserPlugin]: initialContent,
    });
    // Mock a successful 200 response (normally repo returns 404 today)
    const httpClient = vi.fn().mockResolvedValue({ ok: true, status: 200, body: "would-be-tarball-bytes" });
    const svc = new PluginVendorService({
      vendoredAssetsDir: "/asset-root",
      userPluginsDir: "/home/test/.openrig/plugins",
      fs,
      httpClient,
      logger: vi.fn(),
    });

    await svc.attemptAutoFetch("openrig-core");

    // User plugin content unchanged — v0 doesn't extract/install on 200
    expect(fs._store[initialUserPlugin]).toBe(initialContent);
    // No .version file written either
    expect(fs._store["/home/test/.openrig/plugins/openrig-core/.version"]).toBeUndefined();
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
