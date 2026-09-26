// OpenCode runtime adapter + resume adapter hermetic tests (mirrors
// muse-runtime-adapter.test.ts). No live OpenCode: launch/resume/fork COMMAND
// CONSTRUCTION, pane-driven readiness, approval-flag posture, token
// validation, and the opencode.db session-id query (against a scratch sqlite
// db with the real `session` shape) are all pure/fake-backed. The live legs
// are the VM proof contract.

import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import {
  OpencodeRuntimeAdapter, buildOpencodeFreshCommand, buildOpencodeResumeCommand,
  buildOpencodeForkCommand, assessOpencodePane, queryLatestOpencodeSessionId,
  queryOpencodeSessionIdsSince,
  defaultOpencodeDbPath, type OpencodeAdapterFsOps,
} from "../src/adapters/opencode-runtime-adapter.js";
import { OpencodeResumeAdapter, assessOpencodeResumeProbe } from "../src/adapters/opencode-resume.js";
import { opencodePostureFlag } from "../src/adapters/yolo-mode.js";
import { observeOpencodeApproval } from "../src/domain/permission-drift.js";
import { validateResumeToken, resumeTypeForRuntime } from "../src/domain/resume-token-validation.js";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";
import { verifyOpencodeRuntimeAvailable } from "../src/domain/rigspec-preflight.js";

const SESSION = "devopencode-a@some-rig";
const SESSION_ID = "ses_f3bb408d9ffeA9wfnyVhkcmv6C";
const CHILD_ID = "ses_aaaaaaaaaaaaaaaaaaaaaaaaAA";
const OPENCODE_FLOOR_EFFECT = {
  runtime: "opencode",
  axis: "permission",
  state: "observed",
  value: "default",
} as const;

function mockTmux(overrides?: {
  sendText?: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys?: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent?: (target: string, lines?: number) => Promise<string | null>;
  hasSession?: (target: string) => Promise<boolean>;
  getPaneCommand?: (target: string) => Promise<string | null>;
}) {
  return {
    sendText: overrides?.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? vi.fn(async () => ""),
    hasSession: overrides?.hasSession ?? vi.fn(async () => true),
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "opencode"),
  } as unknown as TmuxAdapter;
}

/** In-memory fs. `files` maps absolute path -> content. */
function memFs(files: Record<string, string> = {}): OpencodeAdapterFsOps & { files: Record<string, string>; dirs: Set<string> } {
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files || dirs.has(p),
    mkdirp: (p) => { dirs.add(p); },
    listFiles: () => [],
  };
}

function adapterWith(
  fs: OpencodeAdapterFsOps,
  tmux: TmuxAdapter,
  extra?: {
    readLatestSessionId?: (cwd: string | null, minTime?: number | null) => Promise<string | null>;
    listSessionIdsSince?: (cwd: string | null, minTime: number) => Promise<string[]>;
  },
) {
  return new OpencodeRuntimeAdapter({ tmux, fsOps: fs, sleep: async () => {}, ...extra });
}

// ── command builders ────────────────────────────────────────────────────────

describe("opencode command builders", () => {
  it("builds the fresh command with the project dir, model, and no posture flag on the floor", () => {
    const cmd = buildOpencodeFreshCommand({ cwd: "/work", model: "anthropic/claude-sonnet-4-5", postureArg: "" });
    expect(cmd).toBe("opencode '/work' --model 'anthropic/claude-sonnet-4-5'");
  });

  it("appends --auto under the YOLO posture (uniform across fresh/resume/fork)", () => {
    expect(buildOpencodeFreshCommand({ cwd: "/work", postureArg: " --auto" })).toContain("--auto");
    expect(buildOpencodeResumeCommand({ sessionId: "abc", cwd: "/work", postureArg: " --auto" })).toContain("--auto");
    expect(buildOpencodeForkCommand({ parentId: "abc", cwd: "/work", postureArg: " --auto" })).toContain("--auto");
  });

  it("builds resume as exact-id continuation, never the bare --continue picker", () => {
    const cmd = buildOpencodeResumeCommand({ sessionId: SESSION_ID, cwd: "/work", postureArg: "" });
    expect(cmd).toContain(`opencode '/work' --session '${SESSION_ID}'`);
    expect(cmd).not.toContain("--continue");
  });

  it("builds fork from the parent id with --fork", () => {
    const cmd = buildOpencodeForkCommand({ parentId: SESSION_ID, cwd: "/work", postureArg: "" });
    expect(cmd).toContain(`--session '${SESSION_ID}' --fork`);
  });
});

// ── trust posture ───────────────────────────────────────────────────────────

describe("opencode approval posture", () => {
  it("floor is the harness default (no flag); YOLO selects --auto", () => {
    expect(opencodePostureFlag({})).toBe("");
    expect(opencodePostureFlag({ OPENRIG_YOLO: "1" })).toBe(" --auto");
    expect(opencodePostureFlag({ OPENRIG_YOLO: "true" })).toBe(" --auto");
  });

  it("a resolved per-seat posture overrides the env in BOTH directions", () => {
    expect(opencodePostureFlag({ OPENRIG_YOLO: "1" }, "floor")).toBe("");
    expect(opencodePostureFlag({}, "full_bypass")).toBe(" --auto");
  });

  it("observes the posture for the applied-launch record", () => {
    expect(observeOpencodeApproval("")).toEqual(OPENCODE_FLOOR_EFFECT);
    expect(observeOpencodeApproval(" --auto")).toEqual({ runtime: "opencode", axis: "permission", state: "observed", value: "autoApprove" });
    expect(observeOpencodeApproval("--bogus").state).toBe("unknown");
  });
});

// ── token validation ────────────────────────────────────────────────────────

describe("opencode resume tokens", () => {
  it("maps the opencode runtime to the id-shaped opencode_session_id type", () => {
    expect(resumeTypeForRuntime("opencode")).toBe("opencode_session_id");
    const v = validateResumeToken("opencode", ` ${SESSION_ID} `);
    expect(v).toEqual({ ok: true, resumeType: "opencode_session_id", token: SESSION_ID });
  });

  it("rejects malformed tokens without echoing them", () => {
    const bad = validateResumeToken("opencode", "has spaces;$(evil)");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).not.toContain("evil");
    expect(validateResumeToken("opencode", "").ok).toBe(false);
  });
});

// ── opencode.db session-id query ────────────────────────────────────────────

describe("queryLatestOpencodeSessionId", () => {
  function scratchDb(rows: Array<{ id: string; directory: string; created: number; updated: number }>): string {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "opencode-test-"));
    const dbPath = nodePath.join(dir, "opencode.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)");
    const stmt = db.prepare("INSERT INTO session (id, directory, time_created, time_updated) VALUES (?, ?, ?, ?)");
    for (const r of rows) stmt.run(r.id, r.directory, r.created, r.updated);
    db.close();
    return dbPath;
  }

  it("returns the newest session for the cwd, null for unknown dirs and broken stores", () => {
    const dbPath = scratchDb([
      { id: "ses_old", directory: "/work", created: 1000, updated: 1000 },
      { id: SESSION_ID, directory: "/work", created: 2000, updated: 2000 },
      { id: "ses_other", directory: "/elsewhere", created: 3000, updated: 3000 },
    ]);
    expect(queryLatestOpencodeSessionId(dbPath, "/work")).toBe(SESSION_ID);
    expect(queryLatestOpencodeSessionId(dbPath, "/nowhere")).toBeNull();
    expect(queryLatestOpencodeSessionId(dbPath, null)).toBe("ses_other"); // global latest
    expect(queryLatestOpencodeSessionId("/definitely/missing/opencode.db", "/work")).toBeNull();
  });

  it("minTimeCreatedMs excludes rows created before launch (stale generations, pod-mates)", () => {
    const dbPath = scratchDb([
      { id: "ses_prevgen", directory: "/work", created: 1000, updated: 9000 },
      { id: "ses_podmate", directory: "/work", created: 2000, updated: 8000 },
      { id: SESSION_ID, directory: "/work", created: 5000, updated: 5000 },
    ]);
    // Unfiltered, the recently-active stale row wins by time_updated.
    expect(queryLatestOpencodeSessionId(dbPath, "/work")).toBe("ses_prevgen");
    // Scoped to the launch instant, only the fresh row qualifies.
    expect(queryLatestOpencodeSessionId(dbPath, "/work", 4000)).toBe(SESSION_ID);
    expect(queryLatestOpencodeSessionId(dbPath, "/work", 6000)).toBeNull();
  });

  it("resolves the default db path under XDG_DATA_HOME or ~/.local/share", () => {
    expect(defaultOpencodeDbPath("/home/seat")).toBe("/home/seat/.local/share/opencode/opencode.db");
  });

  it("queryOpencodeSessionIdsSince lists every qualifying row for ambiguity detection", () => {
    const dbPath = scratchDb([
      { id: "ses_old", directory: "/work", created: 1000, updated: 9000 },
      { id: SESSION_ID, directory: "/work", created: 5000, updated: 5000 },
      { id: "ses_other", directory: "/elsewhere", created: 6000, updated: 6000 },
    ]);
    expect(queryOpencodeSessionIdsSince(dbPath, "/work", 4000)).toEqual([SESSION_ID]);
    expect(queryOpencodeSessionIdsSince(dbPath, "/work", 1000)).toEqual(["ses_old", SESSION_ID]);
    expect(queryOpencodeSessionIdsSince(dbPath, "/work", 9000)).toEqual([]);
  });
});

// ── launchHarness ───────────────────────────────────────────────────────────

describe("OpencodeRuntimeAdapter.launchHarness", () => {
  const binding = { tmuxSession: SESSION, cwd: "/work", model: "anthropic/claude-sonnet-4-5" } as never;

  it("refuses without a bound tmux session", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness({ cwd: "/work" } as never, { name: SESSION });
    expect(result.ok).toBe(false);
  });

  it("refuses resumeToken + forkSource together", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness(binding, {
      name: SESSION, resumeToken: SESSION_ID, forkSource: { kind: "native_id", value: SESSION_ID },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/mutually exclusive/);
  });

  it("fresh launch types the opencode command and reports no token yet (capture-later posture)", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result).toEqual({ ok: true, appliedLaunch: OPENCODE_FLOOR_EFFECT });
    const typed = sendText.mock.calls[0]![1] as string;
    expect(typed).toContain("opencode '/work'");
    expect(typed).not.toContain("--continue");
  });

  it("fresh launch captures the cwd-scoped session id as the resume token", async () => {
    const seen: Array<[string | null, number | null | undefined]> = [];
    const before = Date.now();
    const adapter = adapterWith(memFs(), mockTmux(), {
      readLatestSessionId: async (cwd, minTime) => { seen.push([cwd, minTime]); return "fresh-seat-session-id"; },
    });
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result).toEqual({ ok: true, resumeToken: "fresh-seat-session-id", resumeType: "opencode_session_id", appliedLaunch: OPENCODE_FLOOR_EFFECT });
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("/work");
    // The launch timestamp scopes the read: only rows created at/after launch qualify.
    expect(typeof seen[0]![1]).toBe("number");
    expect(seen[0]![1]!).toBeGreaterThanOrEqual(before);
    expect(seen[0]![1]!).toBeLessThanOrEqual(Date.now());
  });

  it("fork rejects a malformed parent id before typing anything", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "native_id", value: "not a session!!" },
    });
    expect(result.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("resume types the exact-id command and returns the SAME token", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: SESSION_ID });
    expect(result).toEqual({ ok: true, resumeToken: SESSION_ID, resumeType: "opencode_session_id", appliedLaunch: OPENCODE_FLOOR_EFFECT });
    const typed = sendText.mock.calls[0]![1] as string;
    expect(typed).toContain(`--session '${SESSION_ID}'`);
  });

  it("resume with a malformed token fails validation BEFORE touching the pane", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendText }));
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: "not a session!!" });
    expect(result.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("resume with a dead id returns retry_fresh, never a silent fresh start", async () => {
    const adapter = adapterWith(
      memFs(),
      mockTmux({ capturePaneContent: async () => "Error: no such session" }),
    );
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: SESSION_ID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recovery).toBe("retry_fresh");
  });

  it("fork uses --fork and returns the NEW child session id, never the parent", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendText }), {
      listSessionIdsSince: async () => [CHILD_ID],
    });
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "native_id", value: SESSION_ID },
    });
    expect(result).toEqual({ ok: true, resumeToken: CHILD_ID, resumeType: "opencode_session_id", appliedLaunch: OPENCODE_FLOOR_EFFECT });
    const typed = sendText.mock.calls[0]![1] as string;
    expect(typed).toContain(`--session '${SESSION_ID}' --fork`);
  });

  it("fork FAILS when only the parent id ever surfaces (post-fork token rule)", async () => {
    const adapter = adapterWith(memFs(), mockTmux(), {
      listSessionIdsSince: async () => [SESSION_ID], // parent only, never a child
    });
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "native_id", value: SESSION_ID },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/post-fork/);
  });

  it("fork FAILS on ambiguity: two qualifying rows is loud-unresolved, never first-pick", async () => {
    const adapter = adapterWith(memFs(), mockTmux(), {
      listSessionIdsSince: async () => [CHILD_ID, "ses_podmate00000000000000001"],
    });
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "native_id", value: SESSION_ID },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/post-fork/);
  });

  it("fork refuses non-native_id ref kinds in v1", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "artifact_path", value: "/x" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/native_id/);
  });

  it("reports attention_required with pane evidence when opencode errors", async () => {
    const adapter = adapterWith(
      memFs(),
      mockTmux({ getPaneCommand: async () => "bash", capturePaneContent: async () => "[opencode] ERROR provider blew up" }),
    );
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.evidence).toContain("blew up");
    }
  });
});

// ── checkReady ──────────────────────────────────────────────────────────────

describe("OpencodeRuntimeAdapter.checkReady", () => {
  const binding = { tmuxSession: SESSION, cwd: "/work" } as never;

  it("is ready while opencode owns the pane", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    expect(await adapter.checkReady(binding)).toEqual({ ready: true });
  });

  it("is not ready at a shell, without a session, or on auth/error markers", async () => {
    const shell = adapterWith(memFs(), mockTmux({ getPaneCommand: async () => "bash" }));
    expect((await shell.checkReady(binding)).ready).toBe(false);

    const nosession = adapterWith(memFs(), mockTmux({ hasSession: async () => false }));
    expect((await nosession.checkReady(binding)).ready).toBe(false);

    const auth = adapterWith(memFs(), mockTmux({ capturePaneContent: async () => "Error: not authenticated — please run opencode auth login" }));
    const authVerdict = await auth.checkReady(binding);
    expect(authVerdict).toMatchObject({ ready: false, code: "login_required" });

    // Crash text after the CLI exited (pane back at a shell) still reports the error.
    const err = adapterWith(memFs(), mockTmux({
      getPaneCommand: async () => "bash",
      capturePaneContent: async () => "[opencode] ERROR: spawn failed",
    }));
    expect((await err.checkReady(binding)).code).toBe("opencode_error");

    const dead = adapterWith(memFs(), mockTmux({ capturePaneContent: async () => "no such session" }));
    expect((await dead.checkReady(binding)).code).toBe("no_saved_session");
  });

  it("assessOpencodePane never mistakes stale opencode scrollback at a shell for ready", () => {
    expect(assessOpencodePane("bash", "opencode output...").ready).toBe(false);
  });

  it("assessOpencodePane ignores agent error-like output while opencode owns the pane", () => {
    expect(assessOpencodePane("opencode", "npm test failed: exited code 1\nTraceback (most recent call last): ...").ready).toBe(true);
    expect(assessOpencodePane("opencode", "Error: not authenticated — please run opencode login").code).toBe("login_required");
    // A dead resume id still wins inside a running TUI.
    expect(assessOpencodePane("opencode", "Error: Session not found: ses_dead").code).toBe("no_saved_session");
  });
});

// ── resume adapter ──────────────────────────────────────────────────────────

describe("OpencodeResumeAdapter", () => {
  const resume = new OpencodeResumeAdapter(mockTmux(), { sleep: async () => {} });

  it("gates on opencode_session_id + token", () => {
    expect(resume.canResume("opencode_session_id", SESSION_ID)).toBe(true);
    expect(resume.canResume("opencode_session_id", null)).toBe(false);
    expect(resume.canResume("muse_id", SESSION_ID)).toBe(false);
    expect(resume.canResume(null, null)).toBe(false);
  });

  it("resumes by typing the exact-id command (never --continue)", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText });
    const r = new OpencodeResumeAdapter(tmux, { sleep: async () => {} });
    const result = await r.resume(SESSION, "opencode_session_id", SESSION_ID, "/work", null);
    expect(result).toEqual({ ok: true, appliedLaunch: OPENCODE_FLOOR_EFFECT });
    const typed = sendText.mock.calls[0]![1] as string;
    expect(typed).toContain(`--session '${SESSION_ID}'`);
    expect(typed).not.toContain("--continue");
  });

  it("refuses a malformed token before typing anything", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText });
    const r = new OpencodeResumeAdapter(tmux, { sleep: async () => {} });
    const result = await r.resume(SESSION, "opencode_session_id", "has spaces;$(evil)", "/work", null);
    expect(result).toMatchObject({ ok: false, code: "no_resume" });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("maps a dead id to retry_fresh and auth failure to attention_required with evidence", async () => {
    const dead = new OpencodeResumeAdapter(
      mockTmux({ capturePaneContent: async () => "No session found for id" }), { sleep: async () => {} },
    );
    expect(await dead.resume(SESSION, "opencode_session_id", SESSION_ID, "/work", null))
      .toMatchObject({ ok: false, code: "retry_fresh" });

    const auth = new OpencodeResumeAdapter(
      mockTmux({ capturePaneContent: async () => "line1\nnot authenticated" }), { sleep: async () => {} },
    );
    const authResult = await auth.resume(SESSION, "opencode_session_id", SESSION_ID, "/work", null);
    expect(authResult).toMatchObject({ ok: false, code: "attention_required" });
    expect((authResult as { evidence?: string }).evidence).toContain("not authenticated");
  });

  it("returns retry_fresh when the pane falls back to a shell", async () => {
    const r = new OpencodeResumeAdapter(
      mockTmux({ getPaneCommand: async () => "bash", capturePaneContent: async () => "" }),
      { sleep: async () => {}, maxWaitMs: 1 },
    );
    expect(await r.resume(SESSION, "opencode_session_id", SESSION_ID, "/work", null))
      .toMatchObject({ ok: false, code: "retry_fresh" });
  });

  it("cleans the typed command with C-c when Enter fails", async () => {
    const sendKeys = vi.fn(async (_t: string, keys: string[]): Promise<TmuxResult> =>
      keys[0] === "Enter"
        ? { ok: false as const, code: "send_failed", message: "enter failed" }
        : { ok: true as const });
    const r = new OpencodeResumeAdapter(mockTmux({ sendKeys }), { sleep: async () => {} });
    const result = await r.resume(SESSION, "opencode_session_id", SESSION_ID, "/work", null);
    expect(result.ok).toBe(false);
    expect(sendKeys.mock.calls.some((c) => c[1]?.[0] === "C-c")).toBe(true);
  });

  it("assessOpencodeResumeProbe is pure and local", () => {
    expect(assessOpencodeResumeProbe("opencode", "")).toBe("resumed");
    expect(assessOpencodeResumeProbe("bash", "no such session xyz")).toBe("no_saved_session");
    expect(assessOpencodeResumeProbe("opencode", "login required")).toBe("attention_required");
    expect(assessOpencodeResumeProbe("bash", "")).toBe("inconclusive");
  });
});

// ── capture + preflight touch points ────────────────────────────────────────

describe("opencode capture and preflight", () => {
  it("derives opencode tokens from the session store; noop without the dep", async () => {
    const noop = await deriveResumeToken({ runtime: "opencode", sessionName: SESSION }, {});
    expect(noop).toEqual({ outcome: "noop" });

    const captured = await deriveResumeToken({ runtime: "opencode", sessionName: SESSION }, {
      opencodeSessionStore: { readSessionId: async () => ({ ok: true, sessionId: SESSION_ID }) },
    });
    expect(captured).toEqual({ outcome: "captured", resumeType: "opencode_session_id", token: SESSION_ID });

    const missing = await deriveResumeToken({ runtime: "opencode", sessionName: SESSION }, {
      opencodeSessionStore: { readSessionId: async () => ({ ok: false, reason: "missing_sidecar" }) },
    });
    expect(missing).toEqual({ outcome: "skipped", reason: "missing_sidecar" });

    const invalid = await deriveResumeToken({ runtime: "opencode", sessionName: SESSION }, {
      opencodeSessionStore: { readSessionId: async () => ({ ok: true, sessionId: "bad id!!" }) },
    });
    expect(invalid).toEqual({ outcome: "skipped", reason: "invalid_token" });
  });

  it("derive prefers the cwd-scoped read when the caller knows the seat cwd", async () => {
    const readSessionId = vi.fn(async () => ({ ok: true as const, sessionId: "ses_global" }));
    const readSessionIdForCwd = vi.fn(async (cwd: string | null) => {
      expect(cwd).toBe("/work");
      return { ok: true as const, sessionId: SESSION_ID };
    });
    const scoped = await deriveResumeToken({ runtime: "opencode", sessionName: SESSION, cwd: "/work" }, {
      opencodeSessionStore: { readSessionId, readSessionIdForCwd },
    });
    expect(scoped).toEqual({ outcome: "captured", resumeType: "opencode_session_id", token: SESSION_ID });
    expect(readSessionId).not.toHaveBeenCalled();

    const fallback = await deriveResumeToken({ runtime: "opencode", sessionName: SESSION }, {
      opencodeSessionStore: { readSessionId, readSessionIdForCwd },
    });
    expect(fallback).toEqual({ outcome: "captured", resumeType: "opencode_session_id", token: "ses_global" });
    expect(readSessionId).toHaveBeenCalledOnce();
  });

  it("the adapter readSessionId feeds the capture store shape", async () => {
    const adapter = adapterWith(memFs(), mockTmux(), {
      readLatestSessionId: async () => SESSION_ID,
    });
    expect(await adapter.readSessionId(SESSION)).toEqual({ ok: true, sessionId: SESSION_ID });

    const empty = adapterWith(memFs(), mockTmux(), {
      readLatestSessionId: async () => null,
    });
    expect(await empty.readSessionId(SESSION)).toEqual({ ok: false, reason: "missing_sidecar" });
  });

  it("verifyOpencodeRuntimeAvailable is empty without opencode members and errors when the binary is missing", async () => {
    const empty = await verifyOpencodeRuntimeAvailable({ pods: [] } as never, async () => "");
    expect(empty).toEqual([]);

    const missing = await verifyOpencodeRuntimeAvailable(
      { pods: [{ members: [{ runtime: "opencode" }] }] } as never,
      async () => { throw new Error("not found"); },
    );
    expect(missing.length).toBe(1);
    expect(missing[0]).toMatch(/opencode.*--version.*failed/);
  });
});
