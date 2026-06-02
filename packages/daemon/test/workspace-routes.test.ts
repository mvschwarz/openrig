// PL-007 Workspace Primitive v0 — workspace HTTP route tests.
//
// Pins:
//   - POST /api/workspace/validate returns the structured gap report
//   - 400 on missing root
//   - 400 on invalid workspace kind
//   - kind-agnostic invocation (no workspaceKind) returns 0 gaps when no
//     contract enforced

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workspaceRoutes } from "../src/routes/workspace.js";

let dir: string;
let app: Hono;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl007-route-"));
  app = new Hono();
  app.route("/api/workspace", workspaceRoutes());
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("workspace HTTP routes (PL-007)", () => {
  it("POST /validate returns structured gap report on knowledge canon", async () => {
    fs.writeFileSync(path.join(dir, "a.md"), "---\ndoc: a\nstatus: active\ncreated: 2026-05-04\nowner: x\n---\n", "utf-8");
    fs.writeFileSync(path.join(dir, "missing.md"), "---\ndoc: m\nstatus: active\ncreated: 2026-05-04\n---\n", "utf-8");
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir, workspaceKind: "knowledge" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { totalFiles: number; gapCount: number; gaps: Array<{ kind: string; field: string | null }> };
    expect(body.totalFiles).toBe(2);
    expect(body.gapCount).toBe(1);
    expect(body.gaps[0]?.field).toBe("owner");
  });

  it("POST /validate rejects missing root with 400", async () => {
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /validate rejects unknown workspace kind", async () => {
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir, workspaceKind: "rd-pod" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /validate without workspaceKind runs structural-only check", async () => {
    fs.writeFileSync(path.join(dir, "a.md"), "---\ndoc: a\n---\n", "utf-8");
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { gapCount: number; workspaceKind: string | null };
    expect(body.gapCount).toBe(0);
    expect(body.workspaceKind).toBeNull();
  });
});

// Slice-21 FR-5 — POST /api/workspace/doctor route tests.
//
// Wires a stub SettingsStore via Hono middleware (matching production
// pattern at server.ts:430 where `c.set("settingsStore", ...)`).
// SettingsStore is constructed with a temp config-file path so the
// suite doesn't touch ~/.openrig.
describe("workspace doctor HTTP route (slice-21 FR-5)", () => {
  let doctorDir: string;
  let doctorApp: Hono;
  let configPath: string;

  beforeEach(async () => {
    doctorDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr5-route-"));
    // Build a healthy workspace shape under doctorDir.
    fs.mkdirSync(path.join(doctorDir, "missions", "getting-started"), { recursive: true });
    fs.writeFileSync(path.join(doctorDir, "missions", "getting-started", "MISSION_NOTES.md"), "");
    fs.mkdirSync(path.join(doctorDir, "missions", "getting-started", "slices", "s1"), { recursive: true });
    fs.writeFileSync(path.join(doctorDir, "missions", "getting-started", "slices", "s1", "README.md"), "");

    // Stub SettingsStore-shaped object — we only need the surface the
    // doctor route uses: resolveOne + configPath. SettingsStore's
    // public surface is large; the stub mirrors the resolveOne return
    // shape (value/source/defaultValue).
    configPath = path.join(doctorDir, ".test-config.json");
    fs.writeFileSync(configPath, "{}");
    // Config-file mtime is forced to epoch (1970-01-01) so the route's
    // process.uptime()-derived daemon start is GUARANTEED newer than
    // the config mtime regardless of Vitest worker uptime. A relative
    // offset like Date.now() - 60_000 flips check #5 to warn when the
    // worker has been alive longer than the offset (banked guard
    // BLOCKER on FR-5c qitem-20260602042720-e27ec982).
    const epochMtime = new Date(0);
    fs.utimesSync(configPath, epochMtime, epochMtime);

    const stubStore = {
      configPath,
      resolveOne(key: string) {
        switch (key) {
          case "workspace.root":
            return { value: doctorDir, source: "env", defaultValue: doctorDir };
          case "workspace.slices_root":
            return { value: path.join(doctorDir, "missions"), source: "default", defaultValue: path.join(doctorDir, "missions") };
          case "files.allowlist":
            return { value: `workspace:${fs.realpathSync(doctorDir)}`, source: "default", defaultValue: `workspace:${doctorDir}` };
          default:
            return { value: "", source: "default", defaultValue: "" };
        }
      },
    };

    doctorApp = new Hono();
    doctorApp.use("*", async (c, next) => {
      c.set("settingsStore" as never, stubStore as never);
      await next();
    });
    doctorApp.route("/api/workspace", workspaceRoutes());
  });

  afterEach(() => {
    try { fs.rmSync(doctorDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("POST /doctor returns 200 with a 7-check DoctorReport on a healthy workspace", async () => {
    const res = await doctorApp.request("/api/workspace/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      workspaceRoot: string;
      checks: Array<{ check: string; status: string }>;
      summary: { ok: number; warn: number; fail: number };
      daemonResolvedAt: string;
    };
    expect(body.workspaceRoot).toBe(doctorDir);
    expect(body.checks).toHaveLength(7);
    expect(body.summary.ok).toBe(7);
    expect(body.summary.warn).toBe(0);
    expect(body.summary.fail).toBe(0);
    expect(body.daemonResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // Discriminator-flip: caller-supplied workspaceRoot must be honored.
  // Without the body.workspaceRoot branch the route would always check
  // the daemon-resolved workspace.
  it("POST /doctor honors body.workspaceRoot for the workspace under check", async () => {
    const altRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fr5-route-alt-"));
    try {
      const res = await doctorApp.request("/api/workspace/doctor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceRoot: altRoot }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        workspaceRoot: string;
        checks: Array<{ check: string; status: string; evidence?: Record<string, unknown> }>;
        summary: { ok: number; warn: number; fail: number };
      };
      expect(body.workspaceRoot).toBe(altRoot);
      // Check #4 (daemon_points_at_this_workspace) must FAIL because
      // daemon's resolved root differs from the caller-supplied one.
      const daemonCheck = body.checks.find((c) => c.check === "daemon_points_at_this_workspace");
      expect(daemonCheck?.status).toBe("fail");
    } finally {
      fs.rmSync(altRoot, { recursive: true, force: true });
    }
  });

  // Discriminator-flip: 503 when SettingsStore is missing. Without
  // the `if (!store) return 503` guard the route would crash.
  it("POST /doctor returns 503 when settingsStore is unavailable", async () => {
    const bareApp = new Hono();
    bareApp.route("/api/workspace", workspaceRoutes());
    const res = await bareApp.request("/api/workspace/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("settings_unavailable");
  });

  // Discriminator-flip: empty body must be tolerated. Without the
  // .catch(() => ({})) guard the JSON parse would throw and 500
  // would land instead of the report.
  it("POST /doctor tolerates empty body (no Content-Type, no JSON)", async () => {
    const res = await doctorApp.request("/api/workspace/doctor", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { workspaceRoot: string };
    expect(body.workspaceRoot).toBe(doctorDir);
  });

  // GUARD/QA BLOCKING-A2 discriminator: when the CLI forwards an
  // OPENRIG_FILES_ALLOWLIST overlay via body.filesAllowlistOverride,
  // the daemon route MUST use that value for check #3 instead of the
  // daemon's own SettingsStore-resolved files.allowlist. Without the
  // override branch the operator's env-var would silently no-op.
  it("POST /doctor honors body.filesAllowlistOverride for check #3", async () => {
    // workspace:. is a relative path; per FR-5b BLOCKER-1 the
    // canonical decoder drops it and check #3 fails with zero usable
    // entries. The daemon SettingsStore stub returns a HEALTHY
    // allowlist (workspace:${doctorDir}); without the override
    // branch the doctor would happily report ok. With the override
    // it correctly fails.
    const res = await doctorApp.request("/api/workspace/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filesAllowlistOverride: "workspace:." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      checks: Array<{ check: string; status: string; evidence?: { allowlistSource?: string } }>;
      summary: { ok: number; warn: number; fail: number };
    };
    const allowlistCheck = body.checks.find((c) => c.check === "file_allowlist_sane");
    expect(allowlistCheck?.status).toBe("fail");
    // Evidence must report source="env" so the operator knows the
    // override was applied (not the daemon's own resolution).
    expect(allowlistCheck?.evidence?.allowlistSource).toBe("env");
    expect(body.summary.fail).toBeGreaterThanOrEqual(1);
  });

  // Discriminator-flip: empty-string filesAllowlistOverride must NOT
  // suppress the daemon's own SettingsStore allowlist. Without the
  // length > 0 guard, an empty override would falsify the check.
  it("ignores empty-string filesAllowlistOverride (uses daemon's SettingsStore)", async () => {
    const res = await doctorApp.request("/api/workspace/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filesAllowlistOverride: "" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      checks: Array<{ check: string; status: string; evidence?: { allowlistSource?: string } }>;
    };
    const allowlistCheck = body.checks.find((c) => c.check === "file_allowlist_sane");
    expect(allowlistCheck?.status).toBe("ok");
    // The stub returns source="default" for files.allowlist; verify
    // we routed through SettingsStore, not the empty override.
    expect(allowlistCheck?.evidence?.allowlistSource).toBe("default");
  });

  // GUARD BLOCKER-1 (qitem-20260602042720-e27ec982) determinism
  // discriminator: even under a long process.uptime() (simulating a
  // long-running Vitest worker), the healthy fixture must still
  // return summary {ok:7, warn:0, fail:0}. A regression where the
  // route-test config mtime was set relative to Date.now() instead
  // of an absolute-old epoch would flip check #5 to warn under any
  // worker uptime greater than the relative offset.
  it("POST /doctor stays healthy under simulated long worker uptime", async () => {
    const origUptime = process.uptime;
    // Force daemon start to a far past time (≈10 years ago at the
    // current Date.now()); the epoch-1970 config mtime must still be
    // older.
    Object.defineProperty(process, "uptime", {
      value: () => 60 * 60 * 24 * 365 * 10,
      writable: true,
      configurable: true,
    });
    try {
      const res = await doctorApp.request("/api/workspace/doctor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        summary: { ok: number; warn: number; fail: number };
        checks: Array<{ check: string; status: string }>;
      };
      expect(body.summary).toEqual({ ok: 7, warn: 0, fail: 0 });
      const reload = body.checks.find((c) => c.check === "daemon_reload_needed");
      expect(reload?.status).toBe("ok");
    } finally {
      Object.defineProperty(process, "uptime", {
        value: origUptime,
        writable: true,
        configurable: true,
      });
    }
  });
});
