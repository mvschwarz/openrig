import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import { assertPrivateTerminalTmux, privateTerminalTmuxDeps } from "../../../test/terminal-tmux-isolation.js";

const savedTmp = process.env["TMUX_TMPDIR"];
const savedTmux = process.env["TMUX"];
afterEach(() => {
  if (savedTmp === undefined) delete process.env["TMUX_TMPDIR"]; else process.env["TMUX_TMPDIR"] = savedTmp;
  if (savedTmux === undefined) delete process.env["TMUX"]; else process.env["TMUX"] = savedTmux;
});

function deps(exec: ReturnType<typeof vi.fn>): TerminalServiceDeps {
  return { resolveProvider: () => null, viewsStore: { get: () => null, list: () => [] },
    listRigNames: () => [], listRigSeats: () => null, listPodSeats: () => null,
    resolveHost: () => null, hasSession: () => false, tmuxExec: exec };
}

// Even if the guard regresses, these cases have an inert injected executor.
// No known-negative can reach a native tmux binary or probe a socket.
it("rejects uninjected close-all selection before either executor can run", async () => {
  const exec = vi.fn(async () => "");
  const service = new TerminalService(deps(exec));
  delete process.env["TMUX_TMPDIR"];
  delete process.env["TMUX"];
  await expect(service.closeAll({})).rejects.toThrow("Unisolated terminal tmux access");
  expect(exec).not.toHaveBeenCalled();
});

it("rejects an explicit unregistered socket even when TMUX_TMPDIR is private", async () => {
  const exec = vi.fn(async () => "");
  const service = new TerminalService({ ...deps(exec), tmuxServerArgs: () => ["-S", "/unregistered/never-connect.sock"] });
  await expect(service.closeAll({ provider: "tmux" })).rejects.toThrow("Unisolated terminal tmux access");
  expect(exec).not.toHaveBeenCalled();
});

it("allows the registered private endpoint with an explicit empty inventory", async () => {
  const empty = privateTerminalTmuxDeps();
  const exec = vi.fn(empty.tmuxExec!);
  const service = new TerminalService({ ...deps(exec), ...empty, tmuxExec: exec });
  expect(await service.closeAll({})).toMatchObject({ ok: true, viewers: [] });
  expect(exec).toHaveBeenCalledExactlyOnceWith(["list-sessions", "-F", "#{session_id}|#{session_name}|#{@openrig_rig_viewer_proof}"]);
});

it("allows private named/default selection but rejects inherited foreign sockets and path escapes", () => {
  const root = process.env["TMUX_TMPDIR"]!;
  expect(() => assertPrivateTerminalTmux(["-L", "owned"], { TMUX_TMPDIR: root })).not.toThrow();
  expect(() => assertPrivateTerminalTmux([], { TMUX_TMPDIR: root })).not.toThrow();
  expect(() => assertPrivateTerminalTmux(["-S", path.join(root, "owned.sock")], {})).not.toThrow();
  expect(() => assertPrivateTerminalTmux([], { TMUX_TMPDIR: root, TMUX: "/unregistered/never-connect.sock,1,0" })).toThrow("Unisolated");
  expect(() => assertPrivateTerminalTmux(["-S", path.join(root, "..", "never-connect.sock")], {})).toThrow("Unisolated");
});
