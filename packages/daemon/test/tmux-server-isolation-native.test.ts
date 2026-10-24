import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { execArgvCommand, execCommand } from "../src/adapters/tmux-exec.js";
import { selectTmuxServer } from "../src/domain/tmux-server-selection.js";

const nativeAvailable = process.platform !== "win32" && (() => {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

describe.skipIf(!nativeAvailable)("an explicit tmux server survives an inherited personal server", { timeout: 30_000 }, () => {
  let root: string;
  let personal: string;
  let isolated: string;
  let selectedSockets: string[];
  const native = (socket: string, args: string[]) =>
    execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  beforeEach(() => {
    // A short prefix leaves room for macOS's canonical /private path.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "t"));
    selectedSockets = [];
    personal = path.join(root, "personal.sock");
    isolated = path.join(root, "isolated.sock");
    vi.stubEnv("HOME", root);
    vi.stubEnv("SHELL", "/bin/sh");
    native(personal, ["-f", "/dev/null", "new-session", "-d", "-s", "personal", "sleep 120"]);
    vi.stubEnv("TMUX", `${personal},0,0`);
    vi.stubEnv("TMUX_PANE", "%0");
  });

  afterEach(() => {
    for (const socket of new Set([personal, isolated, ...selectedSockets])) {
      try { native(socket, ["kill-server"]); } catch { /* The fixture may not have started this server. */ }
    }
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps identically named seats in two homes on different servers", async () => {
    for (const tag of ["a", "b"]) {
      const home = path.join(root, tag);
      const selected = await selectTmuxServer({ home, mode: "isolated", registeredSessions: [],
        env: { TMUX: `${personal},1,0`, TMUX_TMPDIR: root } });
      selectedSockets.push(selected.socketPath!);
      const adapter = new TmuxAdapter(execCommand, undefined, execArgvCommand, selected.executionArgs);
      expect(await adapter.createSession("operator@kernel", root, { OPENRIG_HOME: home, OPENRIG_TEST_MARKER: tag }))
        .toMatchObject({ ok: true });
      expect(native(selected.socketPath!, ["show-environment", "-t", "=operator@kernel", "OPENRIG_TEST_MARKER"]))
        .toBe(`OPENRIG_TEST_MARKER=${tag}`);
    }
    expect(new Set(selectedSockets).size).toBe(2);
    for (const socket of selectedSockets) {
      expect(native(socket, ["list-sessions", "-F", "#{session_name}"])).toBe("operator@kernel");
    }
    expect(native(personal, ["list-sessions", "-F", "#{session_name}"])).toBe("personal");
  });

  it("migrates past foreign namesakes but retains its own legacy seat until it stops", async () => {
    // Outside tmux, a non-UTF-8 locale sanitizes the tab separator. An inherited
    // TMUX marker implicitly enables UTF-8 and would hide this regression.
    vi.stubEnv("LC_ALL", "C");
    vi.stubEnv("LC_CTYPE", "C");
    vi.stubEnv("LANG", "C");
    vi.stubEnv("TMUX", undefined);
    const homeA = path.join(root, "a");
    const homeB = path.join(root, "b-ö");
    native(personal, ["new-session", "-d", "-s", "operator@kernel", "-e", `OPENRIG_HOME=${homeB}`, "sleep 120"]);
    const request = { mode: "isolated" as const, registeredSessions: ["operator@kernel"],
      env: { TMUX: `${personal},1,0`, TMUX_TMPDIR: root } };
    const a = await selectTmuxServer({ ...request, home: homeA });
    selectedSockets.push(a.socketPath!);
    expect(a).toMatchObject({ mode: "isolated", migrationPending: false });
    const b = await selectTmuxServer({ ...request, home: homeB });
    expect(b).toMatchObject({ mode: "inherit", socketPath: personal, migrationPending: true,
      blockingSessions: ["operator@kernel"] });
    expect(native(personal, ["has-session", "-t", "=operator@kernel"])).toBe("");
    native(personal, ["kill-session", "-t", "=operator@kernel"]);
    const moved = await selectTmuxServer({ ...request, home: homeB });
    selectedSockets.push(moved.socketPath!);
    expect(moved).toMatchObject({ mode: "isolated", migrationPending: false });
    expect(moved.socketPath).not.toBe(a.socketPath);
    expect(native(personal, ["list-sessions", "-F", "#{session_name}"])).toBe("personal");
  });

  it("can leave an empty persistent server after its last registered seat stops", async () => {
    const home = path.join(root, "persistent");
    const options = { home, registeredSessions: ["owned"], env: { TMUX: `${personal},1,0`, TMUX_TMPDIR: root } };
    const first = await selectTmuxServer({ ...options, mode: "isolated", registeredSessions: [] });
    selectedSockets.push(first.socketPath!);
    native(first.socketPath!, ["-f", "/dev/null", "new-session", "-d", "-s", "owned", "sleep 120"]);
    native(first.socketPath!, ["set-option", "-g", "exit-empty", "off"]);
    native(first.socketPath!, ["kill-session", "-t", "=owned"]);
    expect(await selectTmuxServer({ ...options, mode: "inherit" })).toMatchObject({
      mode: "inherit", socketPath: personal, migrationPending: false,
    });
  });

  for (const transport of ["shell", "argv"] as const) {
    it(`${transport}: launch, discovery, environment and cleanup stay on the selected server`, async () => {
      const adapter = new TmuxAdapter(execCommand, undefined, transport === "argv" ? execArgvCommand : undefined, ["-S", isolated]);
      expect(await adapter.createSession("managed@fixture", root, { OPENRIG_TEST_MARKER: "isolated-seat" })).toMatchObject({ ok: true });
      expect((await adapter.listSessions()).map(session => session.name)).toEqual(["managed@fixture"]);
      expect(native(personal, ["list-sessions", "-F", "#{session_name}"])).toBe("personal");
      expect(native(isolated, ["show-environment", "-t", "=managed@fixture", "OPENRIG_TEST_MARKER"])).toBe("OPENRIG_TEST_MARKER=isolated-seat");
      expect(await adapter.createProbeSession("metadata-probe", root)).toMatchObject({ ok: true });
      expect(native(personal, ["list-sessions", "-F", "#{session_name}"])).toBe("personal");
      expect(await adapter.killSession("metadata-probe")).toMatchObject({ ok: true });
      expect(await adapter.killSession("managed@fixture")).toMatchObject({ ok: true });
      expect(native(personal, ["list-sessions", "-F", "#{session_name}"])).toBe("personal");
    });
  }
});
