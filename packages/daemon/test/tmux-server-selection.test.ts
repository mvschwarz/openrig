import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectTmuxServer, selectTmuxServer } from "../src/domain/tmux-server-selection.js";
import * as execution from "../src/adapters/tmux-exec.js";

describe("durable tmux server selection", () => {
  let root: string;
  let home: string;
  let oldSocket: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "t"));
    home = path.join(root, "home");
    oldSocket = path.join(root, "personal.sock");
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

  it("keeps a recorded live server across configuration and launching-terminal changes, then migrates after it drains", async () => {
    await selectTmuxServer(options());
    const observer = vi.fn(async () => ({ state: "available" as const, sessions: [{ name: "personal" }, { name: "owned@team" }] }));
    const request = { ...options(), mode: "isolated" as const, registeredSessions: ["owned@team"], inspect: observer,
      env: { TMUX: `${path.join(root, "different.sock")},88,0`, TMUX_TMPDIR: root } };
    const deferred = await selectTmuxServer(request);
    expect(deferred).toMatchObject({ mode: "inherit", requestedMode: "isolated", socketPath: oldSocket,
      migrationPending: true, blockingSessions: ["owned@team"], serverArgs: ["-S", oldSocket] });
    expect(observer).toHaveBeenCalledWith(oldSocket);

    observer.mockResolvedValue({ state: "available", sessions: [{ name: "personal" }] });
    const moved = await selectTmuxServer(request);
    expect(moved).toMatchObject({ mode: "isolated", migrationPending: false, blockingSessions: [] });
    expect(moved.socketPath).not.toBe(oldSocket);
    expect(fs.readFileSync(path.join(home, "tmux-server.json"), "utf8")).toContain(moved.socketPath!);
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
      migrationPending: true, blockingSessions: ["owned"] });
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

  it("keeps an inherited socket path containing commas intact", async () => {
    const socket = path.join(root, "literal, socket");
    expect(await selectTmuxServer({ ...options(), env: { TMUX: `${socket},1,2` } }))
      .toMatchObject({ socketPath: socket, serverArgs: ["-S", socket] });
  });

  it("does not overwrite an invalid or foreign-home server record", async () => {
    await selectTmuxServer(options());
    const file = path.join(home, "tmux-server.json");
    const invalid = '{"version":2,"socketPath":"unknown"}';
    fs.writeFileSync(file, invalid);
    await expect(selectTmuxServer({ ...options(), mode: "isolated" })).rejects.toThrow("Invalid tmux server record");
    expect(fs.readFileSync(file, "utf8")).toBe(invalid);
  });

  it.each(["inherit", "isolated"] as const)("does not guess a new server after a %s record disappears", async mode => {
    await selectTmuxServer({ ...options(), mode });
    const file = path.join(home, "tmux-server.json");
    fs.unlinkSync(file);
    const observer = vi.fn(async () => ({ state: "absent" as const }));
    await expect(selectTmuxServer({ ...options(), mode, registeredSessions: ["owned"], inspect: observer }))
      .rejects.toThrow("Missing tmux server record");
    expect(fs.existsSync(file)).toBe(false);
    expect(observer).not.toHaveBeenCalled();
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
