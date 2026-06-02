// Slice-21 FR-5 — `rig workspace doctor` CLI subcommand tests.
//
// Covers:
//   - default behavior posts to /api/workspace/doctor with empty body
//   - --workspace passes body.workspaceRoot
//   - --json passes through the structured report
//   - human output groups by category (workspace / missions / daemon)
//   - exit-code semantics for fail / warn-with-strict / warn-without-strict / all-ok
//
// Mirrors the queue.test.ts pattern: vi.mock daemon-lifecycle to skip
// the live status probe; clientFactory delivers stub HTTP responses.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  workspaceCommand,
  renderHumanDoctorReport,
  type WorkspaceDeps,
} from "../src/commands/workspace.js";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/daemon-lifecycle.js",
  );
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({
      state: "running",
      healthy: true,
      pid: 1234,
      port: 7433,
    })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface DoctorReportFixture {
  workspaceRoot: string;
  checks: Array<{
    check: string;
    status: "ok" | "warn" | "fail";
    message: string;
    fixHint?: string;
  }>;
  summary: { ok: number; warn: number; fail: number };
  daemonResolvedAt: string;
}

function healthyReport(workspaceRoot = "/ws"): DoctorReportFixture {
  return {
    workspaceRoot,
    checks: [
      { check: "workspace_root_reachable", status: "ok", message: `workspace root '${workspaceRoot}' is a reachable directory` },
      { check: "missions_folder_present", status: "ok", message: `missions folder '${workspaceRoot}/missions' is present` },
      { check: "file_allowlist_sane", status: "ok", message: "files.allowlist has 1 usable entry covering workspace root" },
      { check: "daemon_points_at_this_workspace", status: "ok", message: "daemon and caller agree on workspace root" },
      { check: "daemon_reload_needed", status: "ok", message: "config file mtime is older than daemon start" },
      { check: "optional_slice_docs", status: "ok", message: "every slice has a README" },
      { check: "mission_notes_presence", status: "ok", message: "every mission has MISSION_NOTES.md" },
    ],
    summary: { ok: 7, warn: 0, fail: 0 },
    daemonResolvedAt: "2026-06-01T12:00:00.000Z",
  };
}

function makeDeps(response: { status: number; data: unknown }): {
  deps: WorkspaceDeps;
  post: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(async (_path: string, _body: unknown) => response);
  return {
    post,
    deps: {
      lifecycleDeps: {} as LifecycleDeps,
      clientFactory: () => ({
        post,
        get: vi.fn(),
        getText: vi.fn(),
        postText: vi.fn(),
      }) as unknown as ReturnType<WorkspaceDeps["clientFactory"]>,
    },
  };
}

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

let originalExitCode: number | string | undefined;

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("rig workspace doctor — request shape", () => {
  it("POSTs to /api/workspace/doctor with empty body when no --workspace", async () => {
    const { deps, post } = makeDeps({ status: 200, data: healthyReport() });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync(["node", "rig", "doctor"]);
    } finally {
      out.restore();
    }
    expect(post).toHaveBeenCalledWith("/api/workspace/doctor", {});
  });

  // Discriminator-flip: when --workspace is passed, body.workspaceRoot
  // must carry the resolved absolute path. Without path.resolve(), a
  // relative input like "./ws" would land as "./ws" on the wire and
  // the daemon check #4 would compare against an un-normalized value.
  it("POSTs body.workspaceRoot (absolute) when --workspace is supplied", async () => {
    const { deps, post } = makeDeps({ status: 200, data: healthyReport("/ws-override") });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync([
        "node", "rig", "doctor", "--workspace", "/ws-override",
      ]);
    } finally {
      out.restore();
    }
    expect(post).toHaveBeenCalledWith("/api/workspace/doctor", { workspaceRoot: "/ws-override" });
  });

  it("resolves relative --workspace to absolute path before posting", async () => {
    const { deps, post } = makeDeps({ status: 200, data: healthyReport() });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync([
        "node", "rig", "doctor", "--workspace", "./local-ws",
      ]);
    } finally {
      out.restore();
    }
    const [, body] = post.mock.calls[0]!;
    const sent = body as { workspaceRoot: string };
    expect(sent.workspaceRoot.startsWith("/")).toBe(true);
    expect(sent.workspaceRoot.endsWith("/local-ws")).toBe(true);
  });

  // GUARD/QA BLOCKING-A2 discriminator: CLI-side
  // OPENRIG_FILES_ALLOWLIST must propagate to the daemon as
  // body.filesAllowlistOverride. Without this, an operator setting
  // the env in their CLI shell sees no doctor behavior change because
  // the daemon's env-resolution is decoupled from the CLI process.
  it("forwards OPENRIG_FILES_ALLOWLIST from process.env as body.filesAllowlistOverride", async () => {
    const original = process.env.OPENRIG_FILES_ALLOWLIST;
    process.env.OPENRIG_FILES_ALLOWLIST = "workspace:.";
    const { deps, post } = makeDeps({ status: 200, data: healthyReport() });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync(["node", "rig", "doctor"]);
    } finally {
      out.restore();
      if (original === undefined) delete process.env.OPENRIG_FILES_ALLOWLIST;
      else process.env.OPENRIG_FILES_ALLOWLIST = original;
    }
    const [, body] = post.mock.calls[0]!;
    const sent = body as { workspaceRoot?: string; filesAllowlistOverride?: string };
    expect(sent.filesAllowlistOverride).toBe("workspace:.");
  });

  // Discriminator-flip: an unset OPENRIG_FILES_ALLOWLIST must NOT
  // attach an override (the daemon should use SettingsStore as the
  // source of truth, not silently apply an empty-string).
  it("omits filesAllowlistOverride from body when OPENRIG_FILES_ALLOWLIST is unset", async () => {
    const original = process.env.OPENRIG_FILES_ALLOWLIST;
    delete process.env.OPENRIG_FILES_ALLOWLIST;
    const { deps, post } = makeDeps({ status: 200, data: healthyReport() });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync(["node", "rig", "doctor"]);
    } finally {
      out.restore();
      if (original === undefined) delete process.env.OPENRIG_FILES_ALLOWLIST;
      else process.env.OPENRIG_FILES_ALLOWLIST = original;
    }
    const [, body] = post.mock.calls[0]!;
    const sent = body as { filesAllowlistOverride?: string };
    expect(sent.filesAllowlistOverride).toBeUndefined();
  });

  // Discriminator-flip: empty-string env value is treated as unset
  // (no override sent). Without the length > 0 check, an empty value
  // would land as filesAllowlistOverride="" and the daemon route
  // would treat that as an explicit override.
  it("treats empty-string OPENRIG_FILES_ALLOWLIST as unset (no override sent)", async () => {
    const original = process.env.OPENRIG_FILES_ALLOWLIST;
    process.env.OPENRIG_FILES_ALLOWLIST = "";
    const { deps, post } = makeDeps({ status: 200, data: healthyReport() });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync(["node", "rig", "doctor"]);
    } finally {
      out.restore();
      if (original === undefined) delete process.env.OPENRIG_FILES_ALLOWLIST;
      else process.env.OPENRIG_FILES_ALLOWLIST = original;
    }
    const [, body] = post.mock.calls[0]!;
    const sent = body as { filesAllowlistOverride?: string };
    expect(sent.filesAllowlistOverride).toBeUndefined();
  });
});

describe("rig workspace doctor — output formatters", () => {
  it("--json prints the report as a single-line JSON document", async () => {
    const report = healthyReport();
    const { deps } = makeDeps({ status: 200, data: report });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync(["node", "rig", "doctor", "--json"]);
    } finally {
      out.restore();
    }
    expect(out.logs).toHaveLength(1);
    const parsed = JSON.parse(out.logs[0]!) as DoctorReportFixture;
    expect(parsed.summary).toEqual({ ok: 7, warn: 0, fail: 0 });
    expect(parsed.checks).toHaveLength(7);
  });

  it("default human output groups checks under workspace / missions / daemon categories", async () => {
    const { deps } = makeDeps({ status: 200, data: healthyReport() });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync(["node", "rig", "doctor"]);
    } finally {
      out.restore();
    }
    const joined = out.logs.join("\n");
    expect(joined).toContain("workspace doctor — /ws");
    expect(joined).toContain("summary: 7 ok, 0 warn, 0 fail");
    expect(joined).toContain("workspace:");
    expect(joined).toContain("missions:");
    expect(joined).toContain("daemon:");
    // Discriminator: each check name must appear under the correct
    // group section. We assert the category labels appear BEFORE the
    // check names that belong to them.
    const wsIdx = joined.indexOf("workspace:");
    const wsCheckIdx = joined.indexOf("workspace_root_reachable");
    const missionsIdx = joined.indexOf("missions:");
    const missionsCheckIdx = joined.indexOf("missions_folder_present");
    const daemonIdx = joined.indexOf("daemon:");
    const daemonCheckIdx = joined.indexOf("daemon_points_at_this_workspace");
    expect(wsIdx).toBeLessThan(wsCheckIdx);
    expect(missionsIdx).toBeLessThan(missionsCheckIdx);
    expect(daemonIdx).toBeLessThan(daemonCheckIdx);
  });

  // Discriminator-flip: fixHint MUST render below the failing check.
  // Without `if (c.fixHint) console.log(...)` operators don't see how
  // to fix the failure.
  it("human output renders fixHint under failing/warning checks", () => {
    const report: DoctorReportFixture = {
      workspaceRoot: "/ws",
      checks: [
        { check: "workspace_root_reachable", status: "fail", message: "workspace root '/ws' does not exist", fixHint: "run `rig config init-workspace`" },
        { check: "missions_folder_present", status: "ok", message: "ok" },
        { check: "file_allowlist_sane", status: "ok", message: "ok" },
        { check: "daemon_points_at_this_workspace", status: "ok", message: "ok" },
        { check: "daemon_reload_needed", status: "ok", message: "ok" },
        { check: "optional_slice_docs", status: "ok", message: "ok" },
        { check: "mission_notes_presence", status: "ok", message: "ok" },
      ],
      summary: { ok: 6, warn: 0, fail: 1 },
      daemonResolvedAt: "2026-06-01T12:00:00.000Z",
    };
    const out = captureStdout();
    try {
      renderHumanDoctorReport(report);
    } finally {
      out.restore();
    }
    const joined = out.logs.join("\n");
    expect(joined).toContain("[FAIL] workspace_root_reachable");
    expect(joined).toContain("Fix: run `rig config init-workspace`");
  });

  // Discriminator-flip: a check absent from DOCTOR_CHECK_GROUPS falls
  // into "other:" rather than vanishing. Protects against silent
  // future-check drop-off.
  it("human output renders ungrouped checks under 'other:'", () => {
    const report: DoctorReportFixture = {
      workspaceRoot: "/ws",
      checks: [
        { check: "future_unknown_check", status: "warn", message: "new check the formatter didn't know about" },
      ],
      summary: { ok: 0, warn: 1, fail: 0 },
      daemonResolvedAt: "2026-06-01T12:00:00.000Z",
    };
    const out = captureStdout();
    try {
      renderHumanDoctorReport(report);
    } finally {
      out.restore();
    }
    const joined = out.logs.join("\n");
    expect(joined).toContain("other:");
    expect(joined).toContain("future_unknown_check");
  });
});

describe("rig workspace doctor — exit-code semantics", () => {
  it("exits 0 when summary is all-ok (default mode)", async () => {
    const { deps } = makeDeps({ status: 200, data: healthyReport() });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync(["node", "rig", "doctor"]);
    } finally {
      out.restore();
    }
    expect(process.exitCode).toBe(0);
  });

  // Discriminator-flip: any fail must trip exit code 1 even without
  // --strict.
  it("exits 1 when summary has at least one fail (default mode)", async () => {
    const failing = healthyReport();
    failing.checks[0]!.status = "fail";
    failing.summary = { ok: 6, warn: 0, fail: 1 };
    const { deps } = makeDeps({ status: 200, data: failing });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync(["node", "rig", "doctor"]);
    } finally {
      out.restore();
    }
    expect(process.exitCode).toBe(1);
  });

  // Discriminator-flip: warns are NOT failures in default mode.
  it("exits 0 when summary has warns but no fails (default mode)", async () => {
    const warning = healthyReport();
    warning.checks[6]!.status = "warn";
    warning.summary = { ok: 6, warn: 1, fail: 0 };
    const { deps } = makeDeps({ status: 200, data: warning });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync(["node", "rig", "doctor"]);
    } finally {
      out.restore();
    }
    expect(process.exitCode).toBe(0);
  });

  // Discriminator-flip: --strict turns warns into exit-1.
  it("exits 1 when summary has warns and --strict is set", async () => {
    const warning = healthyReport();
    warning.checks[6]!.status = "warn";
    warning.summary = { ok: 6, warn: 1, fail: 0 };
    const { deps } = makeDeps({ status: 200, data: warning });
    const out = captureStdout();
    try {
      await workspaceCommand(deps).parseAsync(["node", "rig", "doctor", "--strict"]);
    } finally {
      out.restore();
    }
    expect(process.exitCode).toBe(1);
  });

  // Discriminator-flip: HTTP 5xx → exit 1.
  it("exits 1 when daemon returns 5xx", async () => {
    const { deps } = makeDeps({ status: 503, data: { error: "settings_unavailable" } });
    const out = captureStdout();
    const stderrOrig = process.stderr.write;
    process.stderr.write = ((_chunk: unknown) => true) as typeof process.stderr.write;
    try {
      await workspaceCommand(deps).parseAsync(["node", "rig", "doctor"]);
    } finally {
      out.restore();
      process.stderr.write = stderrOrig;
    }
    expect(process.exitCode).toBe(1);
  });
});
