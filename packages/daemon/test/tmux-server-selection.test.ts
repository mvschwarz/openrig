import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectTmuxServer, selectTmuxServer } from "../src/domain/tmux-server-selection.js";
import * as execution from "../src/adapters/tmux-exec.js";

const PINNED_MARKER = "openrig-tmux-pinned-v1\n";

describe("durable tmux server selection", () => {
  let root: string;
  let home: string;
  let oldSocket: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "t"));
    home = path.join(root, "home");
    oldSocket = path.join(root, "personal.sock");
    inspect.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const inspect = vi.fn(async () => ({ state: "absent" as const }));
  const options = () => ({
    home, mode: "inherit" as const, registeredSessions: [] as string[],
    platform: "linux" as const, uid: 1000,
    env: { TMUX: `${oldSocket},44,0`, TMUX_TMPDIR: root }, inspect,
  });

  it("leaves inherited execution unchanged while preserving attachment metadata", async () => {
    const cases = [
      { env: {}, serverArgs: [] },
      { env: { TMUX: "/tmp/tmux-1000/default,1,0" }, serverArgs: [] },
      { env: { TMUX: "/tmp/tmux-1000/personal,1,0" }, serverArgs: ["-L", "personal"] },
      { env: { TMUX: `${oldSocket},1,0`, TMUX_TMPDIR: root }, serverArgs: ["-S", oldSocket] },
    ];
    for (const { env, serverArgs } of cases) {
      expect(await selectTmuxServer({ ...options(), env })).toMatchObject({
        mode: "inherit", requestedMode: "inherit", executionArgs: [], serverArgs, migrationPending: false,
      });
    }
    expect(inspect).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, "tmux-server.initialized"))).toBe(false);
  });

  it("follows a new launching environment in inherit even when an advisory record names live sessions", async () => {
    await selectTmuxServer(options());
    const socket = path.join(root, "different.sock");
    const observer = vi.fn(async () => ({ state: "available" as const, sessions: [{ name: "owned" }] }));
    expect(await selectTmuxServer({ ...options(), registeredSessions: ["owned"], inspect: observer,
      env: { TMUX: `${socket},1,0` } })).toMatchObject({
      mode: "inherit", socketPath: socket, executionArgs: [], serverArgs: ["-S", socket], migrationPending: false,
    });
    expect(observer).not.toHaveBeenCalled();
  });

  it("keeps inherit usable when an old inherited record disappears, even with a legacy marker", async () => {
    await selectTmuxServer(options());
    const file = path.join(home, "tmux-server.json");
    fs.writeFileSync(path.join(home, "tmux-server.initialized"), "1\n");
    fs.unlinkSync(file);
    expect(await selectTmuxServer({ ...options(), registeredSessions: ["owned"] })).toMatchObject({
      mode: "inherit", socketPath: oldSocket, executionArgs: [], migrationPending: false,
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ mode: "inherit", pinned: false });
    expect(fs.existsSync(path.join(home, "tmux-server.initialized"))).toBe(false);
  });

  it.each(["not-json", "null", '{"version":2}', '{"version":1,"mode":"inherit","home":"/another/home","socketPath":"/another/server"}'])(
    "does not refuse inherit or overwrite an unusable advisory record: %s", async invalid => {
      await selectTmuxServer(options());
      const file = path.join(home, "tmux-server.json");
      fs.writeFileSync(file, invalid);
      expect(await selectTmuxServer({ ...options(), registeredSessions: ["owned"] })).toMatchObject({
        mode: "inherit", socketPath: oldSocket, executionArgs: [], migrationPending: false,
      });
      expect(inspect).not.toHaveBeenCalled();
      expect(fs.readFileSync(file, "utf8")).toBe(invalid);
    });

  it("tolerates an unreadable inherited record but still refuses it when isolation is requested", async () => {
    await selectTmuxServer(options());
    const file = path.join(home, "tmux-server.json");
    const read = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((target, ...args) => {
      if (target === file) throw Object.assign(new Error("record unavailable"), { code: "EACCES" });
      return read(target, ...args);
    });
    expect(await selectTmuxServer(options())).toMatchObject({ mode: "inherit", executionArgs: [] });
    await expect(selectTmuxServer({ ...options(), mode: "isolated" })).rejects.toThrow("Cannot read the tmux server record");
  });

  it("does not require a writable home or create a socket directory in inherit", async () => {
    const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(() => { throw Object.assign(new Error("read-only home"), { code: "EACCES" }); });
    expect(await selectTmuxServer(options())).toMatchObject({ mode: "inherit", executionArgs: [] });
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(mkdir).toHaveBeenCalledWith(home, { recursive: true });
  });

  it("treats inherited record replacement and cleanup failures as advisory", async () => {
    await selectTmuxServer(options());
    const file = path.join(home, "tmux-server.json");
    const original = fs.readFileSync(file, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("cannot replace advisory record"); });
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw new Error("cannot remove temporary file"); });
    expect(await selectTmuxServer(options())).toMatchObject({ mode: "inherit", executionArgs: [] });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("keeps a recorded live server across configuration and launching-terminal changes, then migrates after it drains", async () => {
    await selectTmuxServer(options());
    const observer = vi.fn(async () => ({ state: "available" as const, sessions: [{ name: "personal" }, { name: "owned@team" }] }));
    const request = { ...options(), mode: "isolated" as const, registeredSessions: ["owned@team"], inspect: observer,
      env: { TMUX: `${path.join(root, "different.sock")},88,0`, TMUX_TMPDIR: root } };
    const deferred = await selectTmuxServer(request);
    expect(deferred).toMatchObject({ mode: "inherit", requestedMode: "isolated", socketPath: oldSocket,
      migrationPending: true, blockingSessions: ["owned@team"], serverArgs: ["-S", oldSocket], executionArgs: ["-S", oldSocket] });
    expect(observer).toHaveBeenCalledWith(oldSocket);
    expect(JSON.parse(fs.readFileSync(path.join(home, "tmux-server.json"), "utf8")))
      .toMatchObject({ mode: "inherit", pinned: true, socketPath: oldSocket });
    expect(fs.readFileSync(path.join(home, "tmux-server.initialized"), "utf8")).toBe(PINNED_MARKER);

    observer.mockResolvedValue({ state: "available", sessions: [{ name: "personal" }] });
    const moved = await selectTmuxServer(request);
    expect(moved).toMatchObject({ mode: "isolated", migrationPending: false, blockingSessions: [] });
    expect(moved.socketPath).not.toBe(oldSocket);
    expect(moved.executionArgs).toEqual(["-S", moved.socketPath]);
    expect(fs.readFileSync(path.join(home, "tmux-server.json"), "utf8")).toContain(moved.socketPath!);
  });

  it("retains a pending pin when isolation is cancelled from a different launching server", async () => {
    await selectTmuxServer(options());
    const request = { ...options(), registeredSessions: ["owned"],
      env: { TMUX: `${path.join(root, "different.sock")},1,0`, TMUX_TMPDIR: root },
      inspect: vi.fn(async () => ({ state: "available" as const, sessions: [{ name: "owned" }] })) };
    await selectTmuxServer({ ...request, mode: "isolated" });
    expect(await selectTmuxServer(request)).toMatchObject({
      mode: "inherit", requestedMode: "inherit", socketPath: oldSocket, executionArgs: ["-S", oldSocket], migrationPending: true,
    });
    expect(JSON.parse(fs.readFileSync(path.join(home, "tmux-server.json"), "utf8"))).toMatchObject({ pinned: true });
  });

  it("does not mistake an inaccessible old server for an empty one", async () => {
    await selectTmuxServer(options());
    const result = await selectTmuxServer({ ...options(), mode: "isolated", registeredSessions: ["owned"],
      inspect: async () => ({ state: "unavailable" }) });
    expect(result).toMatchObject({ socketPath: oldSocket, mode: "inherit", migrationPending: true });
    expect(result.note).toContain("could not be inspected");
  });

  it("also preserves live isolated seats when isolation is disabled", async () => {
    const first = await selectTmuxServer({ ...options(), mode: "isolated" });
    const result = await selectTmuxServer({ ...options(), registeredSessions: ["owned"],
      inspect: async () => ({ state: "available", sessions: [{ name: "owned" }] }) });
    expect(result).toMatchObject({ requestedMode: "inherit", mode: "isolated", socketPath: first.socketPath,
      executionArgs: ["-S", first.socketPath], migrationPending: true, blockingSessions: ["owned"] });
  });

  it("keeps an uninspectable isolated server selected while disabling isolation", async () => {
    const first = await selectTmuxServer({ ...options(), mode: "isolated" });
    expect(await selectTmuxServer({ ...options(), registeredSessions: ["owned"],
      inspect: async () => ({ state: "unavailable" }) })).toMatchObject({
      requestedMode: "inherit", mode: "isolated", socketPath: first.socketPath,
      executionArgs: ["-S", first.socketPath], migrationPending: true,
    });
  });

  it("returns to ordinary inherited execution after isolated seats drain", async () => {
    const first = await selectTmuxServer({ ...options(), mode: "isolated" });
    const result = await selectTmuxServer({ ...options(), registeredSessions: ["owned"],
      inspect: async () => ({ state: "absent" }) });
    expect(result).toMatchObject({ requestedMode: "inherit", mode: "inherit", socketPath: oldSocket,
      executionArgs: [], serverArgs: ["-S", oldSocket], migrationPending: false });
    expect(JSON.parse(fs.readFileSync(path.join(home, "tmux-server.json"), "utf8")))
      .toMatchObject({ mode: "inherit", pinned: false, socketPath: oldSocket, isolatedSocketPath: first.socketPath });
    expect(fs.existsSync(path.join(home, "tmux-server.initialized"))).toBe(false);
  });

  it("does not leave a stale pinned cleanup target when committing the return to inherit fails", async () => {
    await selectTmuxServer({ ...options(), mode: "isolated" });
    const file = path.join(home, "tmux-server.json");
    const original = fs.readFileSync(file, "utf8");
    const failure = Object.assign(new Error("cannot commit pin release"), { code: "EIO" });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (target === file) throw failure;
      return rename(source, target);
    });
    await expect(selectTmuxServer(options())).rejects.toBe(failure);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.readFileSync(path.join(home, "tmux-server.initialized"), "utf8")).toBe(PINNED_MARKER);
  });

  it("retries marker cleanup after a committed pin release without resurrecting the old pin", async () => {
    await selectTmuxServer({ ...options(), mode: "isolated" });
    const marker = path.join(home, "tmux-server.initialized");
    const unlink = fs.unlinkSync;
    const failure = Object.assign(new Error("cannot remove pin marker"), { code: "EACCES" });
    const cleanup = vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (file === marker) throw failure;
      return unlink(file);
    });
    await expect(selectTmuxServer(options())).rejects.toBe(failure);
    expect(JSON.parse(fs.readFileSync(path.join(home, "tmux-server.json"), "utf8")))
      .toMatchObject({ mode: "inherit", pinned: false, socketPath: oldSocket });
    expect(fs.readFileSync(marker, "utf8")).toBe(PINNED_MARKER);
    cleanup.mockRestore();
    expect(await selectTmuxServer(options())).toMatchObject({ mode: "inherit", executionArgs: [] });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("upgrades a legacy isolated record before retaining its live socket", async () => {
    const isolated = await selectTmuxServer({ ...options(), mode: "isolated" });
    const file = path.join(home, "tmux-server.json");
    const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
    delete legacy.pinned;
    fs.writeFileSync(file, JSON.stringify(legacy));
    fs.writeFileSync(path.join(home, "tmux-server.initialized"), "1\n");
    expect(await selectTmuxServer({ ...options(), registeredSessions: ["owned"],
      inspect: async () => ({ state: "available", sessions: [{ name: "owned" }] }) })).toMatchObject({
      mode: "isolated", socketPath: isolated.socketPath, migrationPending: true,
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ pinned: true });
    expect(fs.readFileSync(path.join(home, "tmux-server.initialized"), "utf8")).toBe(PINNED_MARKER);
  });

  it("keeps the dedicated socket when a later shell changes TMUX and TMUX_TMPDIR", async () => {
    const first = await selectTmuxServer({ ...options(), mode: "isolated" });
    const second = await selectTmuxServer({ ...options(), mode: "isolated",
      env: { TMUX: `${oldSocket},999,0`, TMUX_TMPDIR: path.join(root, "other-temp") } });
    expect(second.socketPath).toBe(first.socketPath);
    expect(second.serverArgs).toEqual(first.serverArgs);
  });

  it("uses different sockets for different homes, without importing the person's server", async () => {
    const a = await selectTmuxServer({ ...options(), mode: "isolated" });
    const b = await selectTmuxServer({ ...options(), home: path.join(root, "home-b"), mode: "isolated" });
    expect(a.socketPath).not.toBe(b.socketPath);
    expect(a.socketPath).not.toBe(oldSocket);
    expect(b.socketPath).not.toBe(oldSocket);
  });

  it("ignores explicit foreign-home namesakes, while preserving owned and unmarked legacy sessions", async () => {
    const observation = { state: "available" as const, sessions: [
      { name: "foreign", home: path.join(root, "another-home") },
      { name: "owned", home },
      { name: "legacy" },
    ] };
    const selected = await selectTmuxServer({ ...options(), mode: "isolated",
      registeredSessions: ["foreign", "owned", "legacy"], inspect: async () => observation });
    expect(selected).toMatchObject({ socketPath: oldSocket, migrationPending: true, blockingSessions: ["owned", "legacy"] });
    expect(await selectTmuxServer({ ...options(), mode: "isolated", registeredSessions: ["foreign"],
      inspect: async () => observation })).toMatchObject({ mode: "isolated", migrationPending: false });
  });

  it("reads session ownership from the inspected server", async () => {
    vi.spyOn(execution, "execArgvCommand").mockResolvedValue(`owned\t${home}\nlegacy\t\n`);
    expect(await inspectTmuxServer(oldSocket)).toEqual({ state: "available", sessions: [
      { name: "owned", home }, { name: "legacy" },
    ] });
    expect(execution.execArgvCommand).toHaveBeenCalledWith([
      "tmux", "-u", "-S", oldSocket, "list-sessions", "-F", "#{session_name}\t#{OPENRIG_HOME}",
    ]);
  });

  it("does not interpret malformed successful output as an empty server", async () => {
    vi.spyOn(execution, "execArgvCommand").mockResolvedValue("owned_unparseable-home\n");
    expect(await inspectTmuxServer(oldSocket)).toEqual({ state: "unavailable" });
  });

  it.skipIf(process.platform === "win32")("canonicalizes home aliases to the same namespace", async () => {
    const first = await selectTmuxServer({ ...options(), mode: "isolated" });
    const alias = path.join(root, "alias");
    fs.symlinkSync(home, alias);
    const second = await selectTmuxServer({ ...options(), home: alias, mode: "isolated" });
    expect(second.socketPath).toBe(first.socketPath);
  });

  it.skipIf(process.platform === "win32")("canonicalizes a new home beneath a symlinked parent before recording isolation", async () => {
    const parent = path.join(root, "real-parent");
    const alias = path.join(root, "alias-parent");
    fs.mkdirSync(parent);
    fs.symlinkSync(parent, alias);
    const newHome = path.join(alias, "new-home");
    const first = await selectTmuxServer({ ...options(), home: newHome, mode: "isolated" });
    const second = await selectTmuxServer({ ...options(), home: newHome, mode: "isolated" });
    expect(second.socketPath).toBe(first.socketPath);
    expect(JSON.parse(fs.readFileSync(path.join(newHome, "tmux-server.json"), "utf8")))
      .toMatchObject({ home: fs.realpathSync(newHome), pinned: true });
  });

  it("keeps an inherited socket path containing commas intact", async () => {
    const socket = path.join(root, "literal, socket");
    expect(await selectTmuxServer({ ...options(), env: { TMUX: `${socket},1,2` } }))
      .toMatchObject({ socketPath: socket, executionArgs: [], serverArgs: ["-S", socket] });
  });

  it("does not overwrite an invalid or foreign-home server record", async () => {
    await selectTmuxServer(options());
    const file = path.join(home, "tmux-server.json");
    const invalid = '{"version":2,"socketPath":"unknown"}';
    fs.writeFileSync(file, invalid);
    await expect(selectTmuxServer({ ...options(), mode: "isolated" })).rejects.toThrow("Invalid tmux server record");
    expect(fs.readFileSync(file, "utf8")).toBe(invalid);
  });

  it("does not guess a new server after an isolated record disappears", async () => {
    await selectTmuxServer({ ...options(), mode: "isolated" });
    const file = path.join(home, "tmux-server.json");
    fs.unlinkSync(file);
    const observer = vi.fn(async () => ({ state: "absent" as const }));
    await expect(selectTmuxServer({ ...options(), mode: "isolated", registeredSessions: ["owned"], inspect: observer }))
      .rejects.toThrow("Missing tmux server record");
    expect(fs.existsSync(file)).toBe(false);
    expect(observer).not.toHaveBeenCalled();
  });

  it("keeps the legacy missing-record guard while isolation is explicitly selected", async () => {
    await selectTmuxServer({ ...options(), mode: "isolated" });
    fs.writeFileSync(path.join(home, "tmux-server.initialized"), "1\n");
    fs.unlinkSync(path.join(home, "tmux-server.json"));
    await expect(selectTmuxServer({ ...options(), mode: "isolated" })).rejects.toThrow("Missing tmux server record");
  });

  it.each(["missing", "invalid", "unreadable"])("does not abandon an active pin on an inherit request with a %s record", async problem => {
    await selectTmuxServer({ ...options(), mode: "isolated" });
    const file = path.join(home, "tmux-server.json");
    if (problem === "missing") fs.unlinkSync(file);
    else if (problem === "invalid") fs.writeFileSync(file, "not-json");
    else {
      const read = fs.readFileSync;
      vi.spyOn(fs, "readFileSync").mockImplementation((target, ...args) => {
        if (target === file) throw Object.assign(new Error("record unavailable"), { code: "EACCES" });
        return read(target, ...args);
      });
    }
    await expect(selectTmuxServer({ ...options(), registeredSessions: ["owned"] })).rejects.toThrow(/Missing tmux server record|Cannot read the tmux server record/);
    expect(inspect).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(home, "tmux-server.initialized"), "utf8")).toBe(PINNED_MARKER);
  });

  it("does not discard invalid pinned metadata just because its marker is gone", async () => {
    await selectTmuxServer({ ...options(), mode: "isolated" });
    const file = path.join(home, "tmux-server.json");
    const invalid = { ...JSON.parse(fs.readFileSync(file, "utf8")), version: 2 };
    fs.writeFileSync(file, JSON.stringify(invalid));
    fs.unlinkSync(path.join(home, "tmux-server.initialized"));
    await expect(selectTmuxServer(options())).rejects.toThrow("Invalid tmux server record");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(invalid);
  });

  it("preserves the persistence error when temporary-file cleanup also fails", async () => {
    await selectTmuxServer(options());
    const file = path.join(home, "tmux-server.json");
    const original = fs.readFileSync(file, "utf8");
    const failure = Object.assign(new Error("cannot replace server record"), { code: "EIO" });
    vi.spyOn(fs, "renameSync").mockImplementation(() => { throw failure; });
    vi.spyOn(fs, "unlinkSync").mockImplementation(() => { throw Object.assign(new Error("cannot remove temporary file"), { code: "EACCES" }); });
    await expect(selectTmuxServer({ ...options(), mode: "isolated" })).rejects.toBe(failure);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("reports the unsupported Windows selection without pretending to isolate psmux", async () => {
    expect(await selectTmuxServer({ ...options(), platform: "win32", mode: "isolated" })).toMatchObject({
      requestedMode: "isolated", mode: "inherit", serverArgs: [], migrationPending: true,
      note: expect.stringContaining("POSIX"),
    });
    expect(fs.existsSync(home)).toBe(false);
  });

  it.each([
    ["no server running on /private/socket", "absent"],
    ["error connecting to /private/socket (No such file or directory)", "absent"],
    ["error connecting to /private/socket (Connection refused)", "absent"],
    ["error connecting to /private/socket (Permission denied)", "unavailable"],
    ["permission denied: no server running", "unavailable"],
    ["tmux returned incomplete output", "unavailable"],
  ] as const)("classifies a server probe without hiding access failures: %s", async (message, state) => {
    vi.spyOn(execution, "execArgvCommand").mockRejectedValue(new Error(message));
    expect(await inspectTmuxServer(oldSocket)).toEqual({ state });
  });
});
