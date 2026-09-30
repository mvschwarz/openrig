// Muse runtime adapter + resume adapter hermetic tests (mirrors
// pi-runtime-adapter.test.ts). No live Muse: launch/resume COMMAND
// CONSTRUCTION, pane-driven readiness, trust-flag posture, and token
// validation are all pure/fake-backed. The live legs are the VM proof contract.

import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import {
  MuseRuntimeAdapter, buildMuseFreshCommand, buildMuseResumeCommand,
  assessMusePane, type MuseAdapterFsOps,
} from "../src/adapters/muse-runtime-adapter.js";
import { MuseResumeAdapter, assessMuseResumeProbe } from "../src/adapters/muse-resume.js";
import { musePostureFlag } from "../src/adapters/yolo-mode.js";
import { observeMuseTrust } from "../src/domain/permission-drift.js";
import { validateResumeToken, resumeTypeForRuntime } from "../src/domain/resume-token-validation.js";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";
import { verifyMuseRuntimeAvailable } from "../src/domain/rigspec-preflight.js";

const SESSION = "devmuse-a@some-rig";
const SESSION_ID = "muse-sess-0197a2f0";

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
    getPaneCommand: overrides?.getPaneCommand ?? vi.fn(async () => "muse"),
  } as unknown as TmuxAdapter;
}

/** In-memory fs. `files` maps absolute path -> content. */
function memFs(
  files: Record<string, string> = {},
  tree: Record<string, string[]> = {},
  mtimes: Record<string, number> = {},
): MuseAdapterFsOps & { files: Record<string, string>; dirs: Set<string> } {
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    readFile: (p) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files || dirs.has(p) || p in mtimes,
    mkdirp: (p) => { dirs.add(p); },
    listFiles: (p) => tree[p] ?? [],
    mtimeMs: (p) => (p in mtimes ? mtimes[p]! : null),
  };
}

function adapterWith(
  fs: MuseAdapterFsOps,
  tmux: TmuxAdapter,
  extra?: { readLatestSessionId?: () => Promise<string | null> },
) {
  return new MuseRuntimeAdapter({ tmux, fsOps: fs, sleep: async () => {}, ...extra });
}

// ── command builders ────────────────────────────────────────────────────────

describe("muse command builders", () => {
  it("builds fresh as interactive muse with --workspace (never one-shot exec)", () => {
    const cmd = buildMuseFreshCommand({ cwd: "/work", model: "opus", postureArg: "" });
    expect(cmd).toBe("muse --workspace '/work' --model 'opus'");
    expect(cmd).not.toContain("exec");
  });

  it("appends --yolo under the YOLO posture (uniform across fresh/resume)", () => {
    expect(buildMuseFreshCommand({ cwd: "/work", postureArg: " --yolo" })).toContain("--yolo");
    expect(buildMuseResumeCommand({ sessionId: "abc", cwd: "/work", postureArg: " --yolo" })).toContain("--yolo");
  });

  it("builds resume as exact-id continuation with no workspace flag or picker", () => {
    const cmd = buildMuseResumeCommand({ sessionId: SESSION_ID, cwd: "/work", postureArg: "" });
    expect(cmd).toBe(`muse resume '${SESSION_ID}'`);
    expect(cmd).not.toContain("--last");
    expect(cmd).not.toContain("--cwd");
    expect(cmd).not.toContain("--workspace");
  });
});

// ── trust posture ───────────────────────────────────────────────────────────

describe("muse trust posture", () => {
  it("floor is the harness default (no flag); YOLO selects --yolo", () => {
    expect(musePostureFlag({})).toBe("");
    expect(musePostureFlag({ OPENRIG_YOLO: "1" })).toBe(" --yolo");
    expect(musePostureFlag({ OPENRIG_YOLO: "true" })).toBe(" --yolo");
  });

  it("a resolved per-seat posture overrides the env in BOTH directions", () => {
    expect(musePostureFlag({ OPENRIG_YOLO: "1" }, "floor")).toBe("");
    expect(musePostureFlag({}, "full_bypass")).toBe(" --yolo");
  });

  it("observes the posture for the applied-launch record", () => {
    expect(observeMuseTrust("")).toEqual({ runtime: "muse", axis: "permission", state: "observed", value: "default" });
    expect(observeMuseTrust(" --yolo")).toEqual({ runtime: "muse", axis: "permission", state: "observed", value: "fullBypass" });
    expect(observeMuseTrust("--bogus").state).toBe("unknown");
  });
});

// ── token validation ────────────────────────────────────────────────────────

describe("muse resume tokens", () => {
  it("maps the muse runtime to the id-shaped muse_id type", () => {
    expect(resumeTypeForRuntime("muse")).toBe("muse_id");
    const v = validateResumeToken("muse", ` ${SESSION_ID} `);
    expect(v).toEqual({ ok: true, resumeType: "muse_id", token: SESSION_ID });
  });

  it("rejects malformed tokens without echoing them", () => {
    const bad = validateResumeToken("muse", "has spaces;$(evil)");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).not.toContain("evil");
    expect(validateResumeToken("muse", "").ok).toBe(false);
  });
});

// ── launchHarness ───────────────────────────────────────────────────────────

describe("MuseRuntimeAdapter.launchHarness", () => {
  it("refuses without a bound tmux session", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const result = await adapter.launchHarness({ tmuxSession: null, cwd: "/work" } as never, { name: SESSION });
    expect(result.ok).toBe(false);
  });

  it("refuses resumeToken + forkSource together", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const binding = { tmuxSession: SESSION, cwd: "/work" } as never;
    const result = await adapter.launchHarness(binding, {
      name: SESSION, resumeToken: SESSION_ID, forkSource: { kind: "native_id", value: SESSION_ID },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/mutually exclusive/);
  });

  it("fresh launch types the interactive command and reports ok without fabricating a token", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendText }));
    const binding = { tmuxSession: SESSION, cwd: "/work", model: "opus" } as never;
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resumeToken).toBeUndefined();
    expect(sendText).toHaveBeenCalledOnce();
    const typed = sendText.mock.calls[0]![1] as string;
    expect(typed).toContain("muse --workspace '/work'");
    expect(typed).not.toContain("exec");
  });

  it("resume launch returns the validated token", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    const binding = { tmuxSession: SESSION, cwd: "/work" } as never;
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: SESSION_ID });
    expect(result).toMatchObject({ ok: true, resumeToken: SESSION_ID, resumeType: "muse_id" });
  });

  it("fresh launch captures the newest session id as the resume token", async () => {
    const adapter = adapterWith(memFs(), mockTmux(), {
      readLatestSessionId: async () => "fresh-seat-session-id",
    });
    const binding = { tmuxSession: SESSION, cwd: "/work" } as never;
    const result = await adapter.launchHarness(binding, { name: SESSION });
    expect(result).toMatchObject({ ok: true, resumeToken: "fresh-seat-session-id", resumeType: "muse_id" });
  });

  it("resume rejects a malformed token before typing anything", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendText }));
    const binding = { tmuxSession: SESSION, cwd: "/work" } as never;
    const result = await adapter.launchHarness(binding, { name: SESSION, resumeToken: "not a valid id!!" });
    expect(result.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("fork is refused outright: the Muse CLI has no fork primitive", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const adapter = adapterWith(memFs(), mockTmux({ sendText }));
    const binding = { tmuxSession: SESSION, cwd: "/work" } as never;
    const result = await adapter.launchHarness(binding, {
      name: SESSION, forkSource: { kind: "native_id", value: SESSION_ID },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no fork primitive/);
    expect(sendText).not.toHaveBeenCalled();
  });
});

// ── session-store scan ──────────────────────────────────────────────────────

describe("muse session-store scan", () => {
  const CHILD = "aaaaaaaa-1111-2222-3333-444444444444";
  const PARENT = "bbbbbbbb-1111-2222-3333-444444444444";
  const ROOT = "/store";
  const tree = {
    [ROOT]: ["2026"],
    [`${ROOT}/2026`]: ["09"],
    [`${ROOT}/2026/09`]: ["21"],
    [`${ROOT}/2026/09/21`]: [CHILD, PARENT, "not-a-session"],
  };
  const log = (id: string) => `${ROOT}/2026/09/21/${id}/session.jsonl`;

  it("returns the newest session.jsonl by mtime, skipping non-uuid dirs", async () => {
    const fs = memFs({}, tree, { [log(CHILD)]: 200, [log(PARENT)]: 100 });
    const adapter = new MuseRuntimeAdapter({
      tmux: mockTmux(), fsOps: fs, sleep: async () => {}, sessionStoreRoot: ROOT,
    });
    expect(await adapter.readSessionId(SESSION)).toEqual({ ok: true, sessionId: CHILD });
  });

  it("returns missing_sidecar when nothing is captured yet", async () => {
    const fs = memFs();
    const adapter = new MuseRuntimeAdapter({
      tmux: mockTmux(), fsOps: fs, sleep: async () => {}, sessionStoreRoot: ROOT,
    });
    expect(await adapter.readSessionId(SESSION)).toEqual({ ok: false, reason: "missing_sidecar" });
  });

  it("readSessionIdForCwd returns the newest session whose log records the cwd", async () => {
    const logged = (cwd: string) => `{"payload":{"workspace_root":${JSON.stringify(cwd)}}}`;
    const fs = memFs(
      { [log(CHILD)]: logged("/other"), [log(PARENT)]: logged("/work") },
      tree,
      { [log(CHILD)]: 200, [log(PARENT)]: 100 },
    );
    const adapter = new MuseRuntimeAdapter({
      tmux: mockTmux(), fsOps: fs, sleep: async () => {}, sessionStoreRoot: ROOT,
    });
    // CHILD is newer but belongs to another cwd — PARENT wins for /work.
    expect(await adapter.readSessionIdForCwd("/work")).toEqual({ ok: true, sessionId: PARENT });
    expect(await adapter.readSessionIdForCwd("/nowhere")).toEqual({ ok: false, reason: "missing_sidecar" });
    expect(await adapter.readSessionIdForCwd(null)).toEqual({ ok: false, reason: "missing_sidecar" });
  });
});

// ── checkReady ──────────────────────────────────────────────────────────────

describe("MuseRuntimeAdapter.checkReady", () => {
  const binding = { tmuxSession: SESSION, cwd: "/work" } as never;

  it("is ready while muse owns the pane", async () => {
    const adapter = adapterWith(memFs(), mockTmux());
    expect(await adapter.checkReady(binding)).toEqual({ ready: true });
  });

  it("is not ready at a shell, without a session, or on auth/error markers", async () => {
    const shell = adapterWith(memFs(), mockTmux({ getPaneCommand: async () => "bash" }));
    expect((await shell.checkReady(binding)).ready).toBe(false);

    const nosession = adapterWith(memFs(), mockTmux({ hasSession: async () => false }));
    expect((await nosession.checkReady(binding)).ready).toBe(false);

    const auth = adapterWith(memFs(), mockTmux({ capturePaneContent: async () => "Error: not authenticated — please run muse login" }));
    const authVerdict = await auth.checkReady(binding);
    expect(authVerdict).toMatchObject({ ready: false, code: "login_required" });

    // Crash text after the CLI exited (pane back at a shell) still reports the error.
    const err = adapterWith(memFs(), mockTmux({
      getPaneCommand: async () => "bash",
      capturePaneContent: async () => "[muse] ERROR: spawn failed",
    }));
    expect((await err.checkReady(binding)).code).toBe("muse_error");
  });

  it("assessMusePane ignores agent error-like output while muse owns the pane", () => {
    // A test run printing "exit code 1" + a traceback must not flip a live seat.
    expect(assessMusePane("muse-bin-1.3.0-R3401.1", "pytest failed: exit code 1\nTraceback (most recent call last): ...").ready).toBe(true);
    // Narrow auth phrases still count while the runtime owns the pane.
    expect(assessMusePane("muse", "Error: not authenticated — please run muse login").code).toBe("login_required");
  });

  it("assessMusePane never mistakes stale muse scrollback at a shell for ready", () => {
    // Pane back at a shell with old muse output in scrollback: not ready.
    expect(assessMusePane("bash", "muse output...").ready).toBe(false);
  });

  it("assessMusePane is ready when the versioned muse-bin child owns the pane", () => {
    // Live: tmux reports `muse-bin-1.3.0-R3401.1`, not `muse`.
    expect(assessMusePane("muse-bin-1.3.0-R3401.1", "Muse Code 1.3.0").ready).toBe(true);
  });
});

// ── resume adapter ──────────────────────────────────────────────────────────

describe("MuseResumeAdapter", () => {
  const resume = new MuseResumeAdapter(mockTmux(), { sleep: async () => {} });

  it("gates on muse_id + token", () => {
    expect(resume.canResume("muse_id", SESSION_ID)).toBe(true);
    expect(resume.canResume("muse_id", null)).toBe(false);
    expect(resume.canResume("codex_id", SESSION_ID)).toBe(false);
    expect(resume.canResume(null, null)).toBe(false);
  });

  it("resumes by typing the exact-id command", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText });
    const r = new MuseResumeAdapter(tmux, { sleep: async () => {} });
    const result = await r.resume(SESSION, "muse_id", SESSION_ID, "/work", null);
    expect(result.ok).toBe(true);
    const typed = sendText.mock.calls[0]![1] as string;
    expect(typed).toContain(`muse resume '${SESSION_ID}'`);
  });

  it("maps a dead id to retry_fresh and auth failure to attention_required with evidence", async () => {
    const dead = new MuseResumeAdapter(
      mockTmux({ capturePaneContent: async () => "No session found for id" }), { sleep: async () => {} },
    );
    expect(await dead.resume(SESSION, "muse_id", SESSION_ID, "/work", null))
      .toMatchObject({ ok: false, code: "retry_fresh" });

    const auth = new MuseResumeAdapter(
      mockTmux({ capturePaneContent: async () => "line1\nnot authenticated" }), { sleep: async () => {} },
    );
    const authResult = await auth.resume(SESSION, "muse_id", SESSION_ID, "/work", null);
    expect(authResult).toMatchObject({ ok: false, code: "attention_required" });
    expect((authResult as { evidence?: string }).evidence).toContain("not authenticated");
  });

  it("returns retry_fresh when the pane falls back to a shell", async () => {
    const r = new MuseResumeAdapter(
      mockTmux({ getPaneCommand: async () => "bash", capturePaneContent: async () => "" }),
      { sleep: async () => {}, maxWaitMs: 1 },
    );
    expect(await r.resume(SESSION, "muse_id", SESSION_ID, "/work", null))
      .toMatchObject({ ok: false, code: "retry_fresh" });
  });

  it("refuses a malformed token before typing anything", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({ sendText });
    const r = new MuseResumeAdapter(tmux, { sleep: async () => {} });
    const result = await r.resume(SESSION, "muse_id", "has spaces;$(evil)", "/work", null);
    expect(result).toMatchObject({ ok: false, code: "no_resume" });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("assessMuseResumeProbe is pure and local", () => {
    expect(assessMuseResumeProbe("muse", "")).toBe("resumed");
    // Live: tmux reports the versioned muse-bin child, not `muse`.
    expect(assessMuseResumeProbe("muse-bin-1.3.0-R3401.1", "")).toBe("resumed");
    expect(assessMuseResumeProbe("bash", "unknown session xyz")).toBe("no_saved_session");
    expect(assessMuseResumeProbe("muse", "login required")).toBe("attention_required");
    expect(assessMuseResumeProbe("bash", "")).toBe("inconclusive");
  });
});

// ── capture + preflight touch points ────────────────────────────────────────

describe("muse capture and preflight", () => {
  it("derives muse tokens from the session store; noop without the dep", async () => {
    const noop = await deriveResumeToken({ runtime: "muse", sessionName: SESSION }, {});
    expect(noop).toEqual({ outcome: "noop" });

    const captured = await deriveResumeToken({ runtime: "muse", sessionName: SESSION }, {
      museSessionStore: { readSessionId: async () => ({ ok: true, sessionId: SESSION_ID }) },
    });
    expect(captured).toEqual({ outcome: "captured", resumeType: "muse_id", token: SESSION_ID });

    // With a cwd, the workspace_root-filtered read wins over global-newest.
    const readSessionId = vi.fn(async () => ({ ok: true as const, sessionId: "other-seat-id" }));
    const readSessionIdForCwd = vi.fn(async () => ({ ok: true as const, sessionId: SESSION_ID }));
    const scoped = await deriveResumeToken({ runtime: "muse", sessionName: SESSION, cwd: "/work" }, {
      museSessionStore: { readSessionId, readSessionIdForCwd },
    });
    expect(scoped).toEqual({ outcome: "captured", resumeType: "muse_id", token: SESSION_ID });
    expect(readSessionId).not.toHaveBeenCalled();
    expect(readSessionIdForCwd).toHaveBeenCalledWith("/work");

    const missing = await deriveResumeToken({ runtime: "muse", sessionName: SESSION }, {
      museSessionStore: { readSessionId: async () => ({ ok: false, reason: "missing_sidecar" }) },
    });
    expect(missing).toEqual({ outcome: "skipped", reason: "missing_sidecar" });

    const invalid = await deriveResumeToken({ runtime: "muse", sessionName: SESSION }, {
      museSessionStore: { readSessionId: async () => ({ ok: true, sessionId: "bad id!!" }) },
    });
    expect(invalid).toEqual({ outcome: "skipped", reason: "invalid_token" });
  });

  it("verifyMuseRuntimeAvailable is empty without muse members and errors when the binary is missing", async () => {
    const empty = await verifyMuseRuntimeAvailable({ pods: [] } as never, async () => "");
    expect(empty).toEqual([]);
    const missing = await verifyMuseRuntimeAvailable(
      { pods: [{ members: [{ runtime: "muse" }] }] } as never,
      async () => { throw new Error("not found"); },
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("muse --version");
  });
});
