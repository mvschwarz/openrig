import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "../src/client.js";
import { openAllTerminalWindows, openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
import { composeView } from "../../daemon/src/domain/terminal/view-composer.js";

// Real isolated tmux servers; the desktop launcher alone is inert.
const sockets: string[] = [];
const dirs: string[] = [];
const env = { ...process.env }; delete env["TMUX"];
function tmux(socket: string, args: string[]): string {
  return execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", env, timeout: 5000 });
}
afterEach(() => {
  for (const socket of sockets.splice(0)) {
    try { tmux(socket, ["kill-server"]); } catch { /* Already exited after a failing setup. */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([
  ["shared", "80x24"], ["shared", "120x40"], ["separate", "120x40"],
])("opens nineteen composed seats on %s servers at configured size %s", async (placement, size) => {
  const id = randomUUID().slice(0, 12);
  const source = `ws-${id}`;
  const viewer = placement === "shared" ? source : `wv-${id}`;
  sockets.push(...new Set([source, viewer]));
  const dir = mkdtempSync(path.join(tmpdir(), "window-test-"));
  dirs.push(dir);
  const wrapper = path.join(dir, "tmux");
  writeFileSync(wrapper, `#!/bin/sh\nexec tmux -L ${source} -f /dev/null "$@"\n`, { mode: 0o755 });
  const names = Array.from({ length: 19 }, (_, index) => `source${index}`);
  for (const name of names) tmux(source, ["new-session", "-d", "-s", name, "sleep 120"]);
  if (viewer !== source) tmux(viewer, ["new-session", "-d", "-s", "viewer-fixture", "sleep 120"]);
  tmux(viewer, ["set-option", "-g", "default-size", size]);
  tmux(viewer, ["set-option", "-gw", "window-size", "latest"]);
  const snapshot = () => names.map(name => tmux(source, ["list-panes", "-t", `=${name}`, "-F", "#{pane_id}|#{pane_pid}"]));
  const original = snapshot();
  const composed = composeView("saved:fixture", names.map(seat => ({
    seat, label: seat, tmuxSession: seat, host: null, readOnly: true, alive: true,
  })), { resolveHost: () => null, panesPerPage: 16, localTmux: wrapper });
  expect(composed.pages.map(page => page.length)).toEqual([16, 3]);
  const client = { baseUrl: "http://localhost:7433", isLocalInstance: vi.fn(async () => true), get: async () => ({ status: 200, data: { planId: "fixture", status: {}, composed } }) } as unknown as DaemonClient;
  const desktop = vi.fn(async () => "window");
  const beforeSplits: string[] = [];
  const deps: WindowDeps = {
    herdrConfig: () => { throw new Error("tmux must not prepare Herdr config"); },
    platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HOME: dir }, exists: () => false,
    exec: async (file, args) => {
      if (file === "/bin/sh") return "tmux";
      if (file === "/usr/bin/osascript") return desktop();
      if (file === "tmux") {
        if (args[0] === "split-window") {
          beforeSplits.push(tmux(viewer, ["display-message", "-p", "-t", args[args.indexOf("-t") + 1]!, "#{window_width}x#{window_height}"]).trim());
        }
        return tmux(viewer, args);
      }
      throw new Error(`unexpected executable ${file}`);
    },
    launch: vi.fn(async () => {}), sleep: async () => {}, id: () => id,
  };
  const result = await openTerminalWindow(client, "saved:fixture", "tmux", deps);
  expect(snapshot()).toEqual(original);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, opened: names, pages: 2 });
  expect(desktop).toHaveBeenCalledTimes(1);
  expect(beforeSplits).toEqual(Array(17).fill(size));
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(tmux(viewer, ["list-panes", "-s", "-t", `=openrig-view-${id}`, "-F", "#{pane_dead}"]).trim().split("\n")).toEqual(Array(19).fill("0"));
  for (const page of [1, 2]) {
    expect(tmux(viewer, ["show-options", "-Awv", "-t", `openrig-view-${id}:view-${page}`, "window-size"]).trim()).toBe("latest");
    expect(tmux(viewer, ["show-options", "-wv", "-t", `openrig-view-${id}:view-${page}`, "window-size"]).trim()).toBe("");
  }
}, 40_000);

it.each([false, true])("opens real viewer panes and preserves source processes (one role per window=%s)", async paged => {
  // Short names also fit macOS Unix sockets under CI's existing TMPDIR.
  const source = `ws-${randomUUID().slice(0, 12)}`;
  const viewer = `wv-${randomUUID().slice(0, 12)}`;
  sockets.push(source, viewer);
  const names = paged ? ["operator", "tui", "advisor"] : ["tui", "advisor", "operator"];
  for (const name of names) tmux(source, ["new-session", "-d", "-s", name, "sleep 60"]);
  const original = tmux(source, ["list-panes", "-a", "-F", "#{session_name} #{pane_id} #{pane_pid}"]);
  const panes = names.map(seat => ({ seat, label: seat, paneCommand: `tmux -L ${source} attach-session -t '=${seat}'` }));
  const client = { baseUrl: "http://localhost:7433", isLocalInstance: vi.fn(async () => true), get: async () => ({ status: 200, data: { planId: "fixture", status: {}, composed: { opened: panes, pages: paged ? panes.map(pane => [pane]) : [panes], columns: paged ? 1 : 3, absent: [], degraded: [] } } }) } as unknown as DaemonClient;
  const desktop = vi.fn(async () => "window");
  const deps: WindowDeps = {
    herdrConfig: () => { throw new Error("tmux must not prepare Herdr config"); },
    platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" }, exists: () => false,
    exec: async (file, args) => {
      if (file === "/bin/sh") return "tmux";
      if (file === "/usr/bin/osascript") return desktop();
      if (file === "tmux") return tmux(viewer, args);
      throw new Error(`unexpected executable ${file}`);
    },
    launch: vi.fn(async () => {}), sleep: async () => {}, id: () => "owned-view",
  };
  const result = await openTerminalWindow(client, "saved:kernel", "tmux", deps);
  expect(result).toMatchObject({ ok: true, opened: names, pages: paged ? 3 : 1 });
  expect(desktop).toHaveBeenCalledTimes(1);
  expect(tmux(viewer, ["list-windows", "-t", "=openrig-view-owned-view", "-F", "#{window_name}|#{window_active}"]).trim().split("\n"))
    .toEqual(paged ? ["view-1|1", "view-2|0", "view-3|0"] : ["view-1|1"]);
  for (const [index, expected] of (paged ? names.map(name => [name]) : [names]).entries()) {
    const actual = tmux(viewer, ["list-panes", "-t", `openrig-view-owned-view:view-${index + 1}`, "-F", "#{pane_title}|#{pane_top}|#{pane_left}|#{pane_dead}"]).trim().split("\n").map(line => line.split("|"));
    expect(actual.map(row => row[0])).toEqual(expected);
    expect(actual.map(row => row[1])).toEqual(expected.map(() => "0"));
    expect(actual.map(row => Number(row[2]))).toEqual([...actual.map(row => Number(row[2]))].sort((a, b) => a - b));
    expect(actual.every(row => row[3] === "0")).toBe(true);
  }
  expect(tmux(source, ["list-panes", "-a", "-F", "#{session_name} #{pane_id} #{pane_pid}"])).toBe(original);
});


it.each([80, 119, 120, 174])("opens the measured %i-column welcome in an owned viewer without replacing source panes", async columns => {
  const id = randomUUID().slice(0, 12);
  const source = `ws-${id}`, viewer = `wv-${id}`;
  sockets.push(source, viewer);
  const names = ["operator", "dashboard", "advisor"];
  for (const name of names) tmux(source, ["new-session", "-d", "-s", name, "sleep 60"]);
  const snapshot = () => tmux(source, ["list-panes", "-a", "-F", "#{session_name}|#{pane_id}|#{pane_pid}"]);
  const original = snapshot();
  const panes = names.map(seat => ({ seat, label: seat, paneCommand: `tmux -L ${source} attach-session -t '=${seat}'` }));
  const get = vi.fn(async (url: string) => {
    const width = Number(new URL(url, "http://fixture").searchParams.get("viewportColumns"));
    const pages = width >= 120 ? [[panes[1]!, panes[0]!], [panes[2]!]] : panes.map(pane => [pane]);
    return { status: 200, data: { planId: "fixture", status: {}, composed: { id: "kernel", kernelLayout: "dual-runtime", opened: pages.flat(), pages, columns: width >= 120 ? 2 : 1, absent: [], degraded: [] } } };
  });
  const client = { baseUrl: "http://localhost:7433", isLocalInstance: vi.fn(async () => true), get } as unknown as DaemonClient;
  const desktop = vi.fn(async () => `window:${columns}`);
  const deps: WindowDeps = {
    herdrConfig: () => { throw new Error("tmux must not prepare Herdr config"); },
    platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" }, exists: () => false,
    exec: async (file, args) => {
      if (file === "/bin/sh") return "tmux";
      if (file === "/usr/bin/osascript") return desktop();
      if (file === "tmux") return tmux(viewer, args);
      throw new Error(`unexpected executable ${file}`);
    },
    launch: vi.fn(async () => {}), sleep: async () => {}, id: () => id,
  };
  const result = await openTerminalWindow(client, "saved:kernel", "tmux", deps);
  const expected = columns >= 120 ? [["dashboard", "operator"], ["advisor"]] : names.map(name => [name]);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, opened: expected.flat(), pages: expected.length });
  expect(desktop).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith(`/api/terminal/preview?view=saved%3Akernel&provider=herdr&viewportColumns=${columns}`);
  const session = `openrig-view-${id}`;
  expect(tmux(viewer, ["list-windows", "-t", `=${session}`, "-F", "#{window_name}|#{window_active}"]).trim().split("\n"))
    .toEqual(expected.map((_page, i) => `view-${i + 1}|${i === 0 ? 1 : 0}`));
  for (const [index, page] of expected.entries()) {
    const actual = tmux(viewer, ["list-panes", "-t", `${session}:view-${index + 1}`, "-F", "#{pane_title}|#{pane_top}|#{pane_width}"]).trim().split("\n").map(line => line.split("|"));
    expect(actual.map(row => row[0])).toEqual(page);
    expect(actual.map(row => row[1])).toEqual(page.map(() => "0"));
    if (page.length === 2) expect(Math.abs(Number(actual[0]![2]) - Number(actual[1]![2]))).toBeLessThanOrEqual(1);
  }
  expect(snapshot()).toBe(original);
});

describe("#3081 openAllTerminalWindows plain-tmux fallback and launch-failure cleanup", () => {
  function setupBulkTmux(rigs: Array<{ rig: string; seats: string[] }>) {
    const id = randomUUID().slice(0, 10);
    const server = `bulk-${id}`;
    sockets.push(server);
    for (const r of rigs) {
      for (const s of r.seats) tmux(server, ["new-session", "-d", "-s", `${s}@${r.rig}`, "sleep 60"]);
    }
    const events: string[] = [];
    const registered: unknown[] = [];
    const retired: unknown[] = [];
    const makeComposed = (rig: string, seats: string[]) => ({
      id: `rig:${rig}`,
      localTmuxServer: ["-L", server],
      opened: seats.map(s => ({ seat: `${s}@${rig}`, label: s, paneCommand: `tmux -L ${server} -f /dev/null attach-session -t '=${s}@${rig}'` })),
      pages: seats.length ? [seats.map(s => ({ seat: `${s}@${rig}`, label: s, paneCommand: `tmux -L ${server} -f /dev/null attach-session -t '=${s}@${rig}'` }))] : [],
      columns: Math.max(1, seats.length),
      absent: seats.length === 0 ? [{ seat: `dead@${rig}`, host: null, reason: "no active tmux binding: stopped or unbound" }] : [],
      degraded: [],
      skipped: [],
    });
    const client = {
      baseUrl: "http://localhost:7433",
      isLocalInstance: vi.fn(async () => true),
      get: vi.fn(async (url: string) => {
        if (url === "/api/terminal/status") return { status: 200, data: { tmux: { mode: "isolated", serverArgs: ["-L", server] }, providers: [] } };
        if (url === "/api/terminal/views") return { status: 200, data: { rigs: rigs.map(r => r.rig) } };
        if (url.startsWith("/api/terminal/preview?")) {
          const view = new URL(url, "http://localhost").searchParams.get("view") ?? "";
          const rigName = view.replace(/^rig:/, "");
          const spec = rigs.find(r => r.rig === rigName)!;
          return { status: 200, data: { planId: `plan-${rigName}`, tmux: { mode: "isolated" }, status: {}, composed: makeComposed(rigName, spec.seats) } };
        }
        return { status: 404, data: {} };
      }),
      post: vi.fn(async (url: string, body: unknown) => {
        if (url === "/api/terminal/rig-viewers") {
          events.push(`register:${(body as { view: string }).view}`);
          registered.push(body);
        }
        return { status: 200, data: { ok: true } };
      }),
      delete: vi.fn(async (url: string) => {
        if (url.startsWith("/api/terminal/rig-viewers")) {
          events.push("retire");
          retired.push(url);
        }
        return { status: 200, data: { ok: true } };
      }),
    } as unknown as DaemonClient;
    return { server, client, events, registered, retired };
  }

  it("opens one tagged session per non-empty rig, posts daemon record before launchWindow, and skips empty rigs", async () => {
    const { server, client, events, registered } = setupBulkTmux([
      { rig: "empty", seats: [] },
      { rig: "beta", seats: ["op"] },
      { rig: "alpha", seats: ["op"] },
    ]);
    let seq = 0;
    const deps: WindowDeps = {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "/usr/bin/osascript") {
          events.push("launch");
          return "window";
        }
        if (file === "tmux") return tmux(server, args);
        throw new Error(`unexpected ${file}`);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => `b${++seq}`,
    };

    const result = await openAllTerminalWindows(client, undefined, deps);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.provider).toBe("tmux");
    expect(result.rigs.map(r => r.rig)).toEqual(["alpha", "beta", "empty"]);
    expect(result.rigs.find(r => r.rig === "empty")?.outcome).toBe("absent");
    expect(events).toEqual(["register:rig:alpha", "launch", "register:rig:beta", "launch"]);
    expect(registered).toHaveLength(2);
    const sessTags = new Map(
      tmux(server, ["list-sessions", "-F", "#{session_name}|#{@openrig_rig_viewer}"]).trim().split("\n").map(line => {
        const sep = line.indexOf("|");
        return [line.slice(0, sep), line.slice(sep + 1)] as [string, string];
      }),
    );
    for (const s of ["openrig-view-b1", "openrig-view-b2"]) {
      expect(sessTags.get(s)).toMatch(/^[0-9a-f-]{8,}$/);
    }
  });

  it("fails cleanly before creating any session when desktop launcher preflight returns a string", async () => {
    const { server, client, registered } = setupBulkTmux([{ rig: "alpha", seats: ["op"] }]);
    const deps: WindowDeps = {
      herdrConfig: () => "",
      platform: "linux",
      env: { HOME: "/fixture" }, // no DISPLAY / unknown host terminal
      exists: () => false,
      exec: async (file) => file === "/bin/sh" ? "" : "",
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => "never",
    };
    const res = await openAllTerminalWindows(client, "tmux", deps);
    expect(res.ok).toBe(false);
    expect(registered).toEqual([]);
    expect(tmux(server, ["list-sessions", "-F", "#{session_name}"]).trim().split("\n")).toEqual(["op@alpha"]);
  });

  it("cleans up an unattached intact viewer on launch failure, retains when dirty/attached or kill unverified, and halts remaining sessions on -1743", async () => {
    // 1. Clean intact session is killed and read back absent:
    const c1 = setupBulkTmux([{ rig: "alpha", seats: ["op"] }]);
    const res1 = await openAllTerminalWindows(c1.client, "tmux", {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "/usr/bin/osascript") throw new Error("boom");
        if (file === "tmux") return tmux(c1.server, args);
        throw new Error(file);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => "cleanfail",
    });
    expect(res1.ok).toBe(false);
    expect(res1.rigs[0]).toMatchObject({ rig: "alpha", outcome: "failed" });
    expect(res1.rigs[0]?.cleanup).toBe("closed");
    expect(tmux(c1.server, ["list-sessions", "-F", "#{session_name}"]).trim().split("\n")).toEqual(["op@alpha"]);
    expect(c1.retired).toHaveLength(1);

    // 2. Extra window created before launch throws -> retains session + cleanup: "unknown" + keeps record:
    const c2 = setupBulkTmux([{ rig: "alpha", seats: ["op"] }]);
    const res2 = await openAllTerminalWindows(c2.client, "tmux", {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "/usr/bin/osascript") {
          tmux(c2.server, ["new-window", "-d", "-t", "openrig-view-dirtyfail:", "-n", "extra", "sleep 60"]);
          throw new Error("boom");
        }
        if (file === "tmux") return tmux(c2.server, args);
        throw new Error(file);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => "dirtyfail",
    });
    expect(res2.rigs[0]).toMatchObject({ rig: "alpha", outcome: "failed", cleanup: "unknown" });
    expect(tmux(c2.server, ["list-sessions", "-F", "#{session_name}"]).trim().split("\n")).toContain("openrig-view-dirtyfail");
    expect(c2.retired).toHaveLength(0);

    // 3. -1743 on rig 2 keeps rig 1 open and skips creating rig 3 session with code automation_denied:
    const c3 = setupBulkTmux([
      { rig: "alpha", seats: ["op"] },
      { rig: "beta", seats: ["op"] },
      { rig: "gamma", seats: ["op"] },
    ]);
    let launchNum = 0;
    const res3 = await openAllTerminalWindows(c3.client, "tmux", {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "/usr/bin/osascript") {
          launchNum++;
          if (launchNum === 2) throw new Error("Not authorized to send Apple events (-1743)");
          return "window";
        }
        if (file === "tmux") return tmux(c3.server, args);
        throw new Error(file);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => `seq-${launchNum + 1}`,
    });
    expect(res3.ok).toBe(true);
    expect(res3.rigs.find(r => r.rig === "alpha")?.outcome).toBe("opened");
    expect(res3.rigs.find(r => r.rig === "beta")?.outcome).toBe("failed");
    expect(res3.rigs.find(r => r.rig === "gamma")).toMatchObject({ outcome: "failed", code: "automation_denied" });
    expect(c3.registered).toHaveLength(2);
    expect(tmux(c3.server, ["list-sessions", "-F", "#{session_name}"]).trim().split("\n")).toContain("openrig-view-seq-1");
  });

  it("reports cleanup: unknown with an inspection note when createTmuxViewerLayout fails after new-session", async () => {
    const { server, client, registered, retired } = setupBulkTmux([{ rig: "alpha", seats: ["op"] }]);
    let launchCalls = 0;
    const res = await openAllTerminalWindows(client, "tmux", {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "/usr/bin/osascript") {
          launchCalls++;
          return "window";
        }
        if (file === "tmux") {
          if (args.includes("set-option")) throw new Error("injected set-option failure");
          return tmux(server, args);
        }
        throw new Error(file);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => "partialfail",
    });

    expect(res.ok).toBe(false);
    expect(res.rigs[0]).toMatchObject({ rig: "alpha", outcome: "failed", cleanup: "unknown" });
    const noteText = (res.rigs[0]?.notes ?? []).join(" ");
    expect(noteText).toContain("openrig-view-partialfail");
    expect(noteText).not.toContain("close --all");
    const sessions = tmux(server, ["list-sessions", "-F", "#{session_name}"]).trim().split("\n");
    expect(sessions).toContain("openrig-view-partialfail");
    expect(sessions).toContain("op@alpha");
    expect(registered).toHaveLength(0);
    expect(retired).toHaveLength(0);
    expect(launchCalls).toBe(0);
  });

  it("J04/T2/J15: preserves viewer record on Permission denied or attached client or post-kill still-listed, and distinguishes already_gone", async () => {
    // 1. Permission denied on pre/post cleanup check MUST return cleanup: "unknown" and NOT retire record:
    const perm = setupBulkTmux([{ rig: "alpha", seats: ["op"] }]);
    const permRes = await openAllTerminalWindows(perm.client, "tmux", {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "/usr/bin/osascript") throw new Error("Not authorized to send Apple events (-1743)");
        if (file === "tmux") {
          if (args.includes("list-sessions") && perm.registered.length > 0) {
            throw new Error("error connecting to /tmp/tmux-1000/default (Permission denied)");
          }
          return tmux(perm.server, args);
        }
        throw new Error(file);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => "perm",
    });
    expect(permRes.rigs[0]).toMatchObject({ rig: "alpha", outcome: "failed", cleanup: "unknown" });
    expect(perm.retired).toHaveLength(0);

    // 2. Attached client on failing viewer MUST check list-clients, NOT kill-session, and MUST return cleanup: "unknown":
    const attached = setupBulkTmux([{ rig: "alpha", seats: ["op"] }]);
    let attachedClientChecks = 0;
    const attachedKillCalls: string[][] = [];
    const attRes = await openAllTerminalWindows(attached.client, "tmux", {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "/usr/bin/osascript") throw new Error("window failed");
        if (file === "tmux") {
          if (args.includes("list-clients") && args.includes("#{client_name}")) {
            attachedClientChecks++;
            return "client-1\n";
          }
          if (args.includes("kill-session")) {
            attachedKillCalls.push(args);
            return "";
          }
          return tmux(attached.server, args);
        }
        throw new Error(file);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => "att",
    });
    expect(attachedClientChecks).toBe(1);
    expect(attachedKillCalls).toEqual([]);
    expect(attRes.rigs[0]).toMatchObject({ rig: "alpha", outcome: "failed", cleanup: "unknown" });
    expect(tmux(attached.server, ["list-sessions", "-F", "#{session_name}"]).trim().split("\n")).toContain("openrig-view-att");
    expect(attached.retired).toHaveLength(0);

    // 3. Already-gone viewer BEFORE cleanup returns cleanup: "already_gone" and retires record:
    const gone = setupBulkTmux([{ rig: "alpha", seats: ["op"] }]);
    const goneRes = await openAllTerminalWindows(gone.client, "tmux", {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "/usr/bin/osascript") {
          tmux(gone.server, ["kill-session", "-t", "openrig-view-gone"]);
          throw new Error("window failed");
        }
        if (file === "tmux") return tmux(gone.server, args);
        throw new Error(file);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => "gone",
    });
    expect(goneRes.rigs[0]).toMatchObject({ rig: "alpha", outcome: "failed", cleanup: "already_gone" });
    expect(gone.retired).toHaveLength(1);

    // 4. Permission denied on post-kill readback MUST return cleanup: "unknown" and retain record:
    const postPerm = setupBulkTmux([{ rig: "alpha", seats: ["op"] }]);
    const postPermKillCalls: string[][] = [];
    let postPermPostListCalls = 0;
    const postPermRes = await openAllTerminalWindows(postPerm.client, "tmux", {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "/usr/bin/osascript") throw new Error("window failed");
        if (file === "tmux") {
          if (args.includes("kill-session")) {
            postPermKillCalls.push(args);
            return tmux(postPerm.server, args);
          }
          if (args.includes("list-sessions") && postPermKillCalls.length > 0) {
            postPermPostListCalls++;
            throw new Error("error connecting to /tmp/tmux-1000/default (Permission denied)");
          }
          return tmux(postPerm.server, args);
        }
        throw new Error(file);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => "postperm",
    });
    expect(postPermKillCalls).toHaveLength(1);
    expect(postPermPostListCalls).toBe(1);
    expect(postPermRes.rigs[0]).toMatchObject({ rig: "alpha", outcome: "failed", cleanup: "unknown" });
    expect(postPerm.retired).toHaveLength(0);

    // 5. Post-kill still-listed viewer MUST return cleanup: "unknown" and retain record:
    const stillListed = setupBulkTmux([{ rig: "alpha", seats: ["op"] }]);
    const stillKillCalls: string[][] = [];
    let stillPostListCalls = 0;
    const stillRes = await openAllTerminalWindows(stillListed.client, "tmux", {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "/usr/bin/osascript") throw new Error("window failed");
        if (file === "tmux") {
          if (args.includes("kill-session")) {
            stillKillCalls.push(args);
            return "";
          }
          if (args.includes("list-sessions") && stillKillCalls.length > 0) {
            stillPostListCalls++;
            return tmux(stillListed.server, args);
          }
          return tmux(stillListed.server, args);
        }
        throw new Error(file);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => "still",
    });
    expect(stillKillCalls).toHaveLength(1);
    expect(stillPostListCalls).toBe(1);
    expect(stillRes.rigs[0]).toMatchObject({ rig: "alpha", outcome: "failed", cleanup: "unknown" });
    expect(tmux(stillListed.server, ["list-sessions", "-F", "#{session_name}"]).trim().split("\n")).toContain("openrig-view-still");
    expect(stillListed.retired).toHaveLength(0);
  });

  it("J05: reads top-level rigViewer and skips @openrig_rig_viewer/registration for saved:rig:example and rigViewer:false spoofed rig:* payloads, while rig:alpha registers", async () => {
    const id = randomUUID().slice(0, 10);
    const server = `j05-${id}`;
    sockets.push(server);
    tmux(server, ["new-session", "-d", "-s", "op@alpha", "sleep 60"]);
    const posts: unknown[] = [];
    const previewClient = (rigViewer: boolean, composedId = "rig:alpha") => ({
      baseUrl: "http://localhost:7433",
      isLocalInstance: vi.fn(async () => true),
      get: vi.fn(async () => ({
        status: 200,
        data: {
          planId: "p1",
          rigViewer,
          status: {},
          composed: {
            id: composedId,
            localTmuxServer: ["-L", server],
            opened: [{ seat: "op@alpha", label: "op", paneCommand: `tmux -L ${server} -f /dev/null attach-session -t '=op@alpha'` }],
            pages: [[{ seat: "op@alpha", label: "op", paneCommand: `tmux -L ${server} -f /dev/null attach-session -t '=op@alpha'` }]],
            columns: 1,
            absent: [],
            degraded: [],
          },
        },
      })),
      post: vi.fn(async (_url: string, body: unknown) => {
        posts.push(body);
        return { status: 200, data: { ok: true } };
      }),
    }) as unknown as DaemonClient;

    const depsFor = (viewerId: string): WindowDeps => ({
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "/usr/bin/osascript") return "window";
        if (file === "tmux") return tmux(server, args);
        throw new Error(file);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => viewerId,
    });

    await openTerminalWindow(previewClient(false), "saved:rig:alpha", "tmux", depsFor("saved1"));
    const savedRows = tmux(server, ["list-sessions", "-F", "#{session_name}|#{@openrig_rig_viewer}"])
      .trim()
      .split("\n")
      .map(line => line.split("|"));
    expect(savedRows.find(row => row[0] === "openrig-view-saved1")?.[1]).toBe("");
    expect(posts).toHaveLength(0);

    await openTerminalWindow(previewClient(false, "rig:spoofed"), "rig:spoofed", "tmux", depsFor("spoof1"));
    const spoofRows = tmux(server, ["list-sessions", "-F", "#{session_name}|#{@openrig_rig_viewer}"])
      .trim()
      .split("\n")
      .map(line => line.split("|"));
    expect(spoofRows.find(row => row[0] === "openrig-view-spoof1")?.[1]).toBe("");
    expect(posts).toHaveLength(0);

    await openTerminalWindow(previewClient(true), "rig:alpha", "tmux", depsFor("rig1"));
    const rigRows = tmux(server, ["list-sessions", "-F", "#{session_name}|#{@openrig_rig_viewer}"])
      .trim()
      .split("\n")
      .map(line => line.split("|"));
    expect(rigRows.find(row => row[0] === "openrig-view-rig1")?.[1]).toMatch(/^[0-9a-f-]{8,}$/);
    expect(posts).toHaveLength(1);
  });

  it("J14: fails openAllTerminalWindows when /api/terminal/views fails and omits close --all advice when unregistered", async () => {
    const server = `j14-${randomUUID().slice(0, 10)}`;
    sockets.push(server);
    tmux(server, ["new-session", "-d", "-s", "op@alpha", "sleep 60"]);
    const badViewsClient = {
      baseUrl: "http://localhost:7433",
      isLocalInstance: vi.fn(async () => true),
      get: vi.fn(async (url: string) => {
        if (url === "/api/terminal/status") return { status: 200, data: { tmux: { mode: "isolated", serverArgs: ["-L", server] }, providers: [] } };
        if (url === "/api/terminal/views") return { status: 500, data: { error: "views down" } };
        return { status: 404, data: {} };
      }),
    } as unknown as DaemonClient;
    const viewsRes = await openAllTerminalWindows(badViewsClient, "tmux", {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async file => (file === "/bin/sh" ? "tmux" : ""),
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => "j14a",
    });
    expect(viewsRes.ok).toBe(false);

    // Registration fails BEFORE launch -> cleanup: unknown, and notes must NOT tell user close --all works!
    const base = setupBulkTmux([{ rig: "alpha", seats: ["op"] }]);
    const regFailClient = {
      ...base.client,
      post: vi.fn(async () => ({ status: 500, data: { error: "journal full" } })),
    } as unknown as DaemonClient;
    const regRes = await openAllTerminalWindows(regFailClient, "tmux", {
      herdrConfig: () => "",
      platform: "darwin",
      env: { TERM_PROGRAM: "Apple_Terminal", HOME: "/fixture" },
      exists: () => false,
      exec: async (file, args) => {
        if (file === "/bin/sh") return "tmux";
        if (file === "tmux") {
          if (args.includes("kill-session")) throw new Error("kill denied");
          return tmux(base.server, args);
        }
        throw new Error(file);
      },
      launch: vi.fn(async () => {}),
      sleep: async () => {},
      id: () => "regfail",
    });
    expect(regRes.rigs[0]?.outcome).toBe("failed");
    expect((regRes.rigs[0]?.notes ?? []).join(" ")).not.toContain("rig terminal close --all");
  });
});
