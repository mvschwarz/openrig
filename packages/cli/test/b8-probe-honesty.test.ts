// B8 PROBE-HONESTY (shape 73ee4b25, floor-A ruled) — the CLI tells the truth about what
// it KNOWS vs what it INFERS. RED-first against current main.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { statusGuardMessage, daemonStatusGuard } from "../src/daemon-lifecycle.js";
import type { DaemonStatus } from "../src/daemon-lifecycle.js";

describe("B8-1b — epistemic-matched precheck language (the ONE helper)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, "error").mockImplementation(() => {}); process.exitCode = undefined; });
  afterEach(() => { errSpy.mockRestore(); process.exitCode = undefined; });

  it("UNVERIFIED renders may-be-busy-or-stopped — NEVER 'not running' (down ≠ busy)", () => {
    const ok = daemonStatusGuard({ state: "unverified" } as DaemonStatus);
    expect(ok).toBe(false);
    const out = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/did not respond|may be busy or stopped/i);
    expect(out).not.toMatch(/not running/i);
    expect(process.exitCode).toBe(1);
  });

  it("STOPPED renders the not-running 3-part (positive evidence keeps the plain truth)", () => {
    const ok = daemonStatusGuard({ state: "stopped" } as DaemonStatus);
    expect(ok).toBe(false);
    const out = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/not running/i);
  });

  it("RUNNING+healthy passes silently; RUNNING+unhealthy renders unhealthy — not 'not running'", () => {
    expect(daemonStatusGuard({ state: "running", healthy: true } as DaemonStatus)).toBe(true);
    expect(errSpy.mock.calls.length).toBe(0);
    expect(daemonStatusGuard({ state: "running", healthy: false } as DaemonStatus)).toBe(false);
    const out = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toMatch(/unhealthy|did not respond/i);
    expect(out).not.toMatch(/not running/i);
  });

  it("sibling hint renders when present (the wrong-home teaching line rides the guard)", () => {
    daemonStatusGuard({ state: "unverified", siblingHint: { resolvedHome: "/a/.openrig", siblingHome: "/a/.openrig-vm" } } as DaemonStatus);
    const out = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(out).toContain("/a/.openrig-vm");
  });

  it("statusGuardMessage is pure (language derives from the epistemic state)", () => {
    expect(statusGuardMessage({ state: "unverified" } as DaemonStatus).fact).toMatch(/did not respond/i);
    expect(statusGuardMessage({ state: "stopped" } as DaemonStatus).fact).toMatch(/not running/i);
  });
});

describe("B8-1b — chokepoint adoption census (the grep-guard pin)", () => {
  it("ZERO literal 'Daemon not running' renders outside daemon-lifecycle.ts (55-site class killed)", async () => {
    const { execFileSync } = await import("node:child_process");
    const path = await import("node:path");
    const root = path.resolve(import.meta.dirname, "../src");
    let out = "";
    try {
      // RENDER forms only: console prints, thrown Errors, and structured facts. The
      // detection regex (cross-host-executor), help-text exit-code docs, and comments
      // legitimately carry the phrase and are NOT render sites.
      out = execFileSync("grep", ["-rnE", "(console\\.(error|log)\\(|new Error\\(|fact:)[^\\n]*\"Daemon not running", root, "--include=*.ts"], { encoding: "utf-8" });
    } catch { out = ""; } // grep exit 1 = no matches
    const offenders = out.split("\n").filter((l) => l && !l.includes("daemon-lifecycle.ts"));
    expect(offenders).toEqual([]); // every precheck RENDER routes through the ONE helper
  });
});
