import { beforeEach, afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import * as isolation from "../../../test/terminal-tmux-isolation.js";
import { TerminalService, type TerminalServiceDeps } from "../src/domain/terminal/terminal-service.js";
import { assertPrivateTerminalTmux, privateTerminalTmuxDeps } from "../../../test/terminal-tmux-isolation.js";

const savedTmp = process.env["TMUX_TMPDIR"];
const savedTmux = process.env["TMUX"];
const savedPane = process.env["TMUX_PANE"];
const fixturePaths: string[] = [];
const scopes: string[] = [];
function beginOwned(base: string): string {
  const root = isolation.beginPrivateTerminalTmux(base); scopes.push(root); return root;
}
beforeEach(() => { beginOwned(os.tmpdir()); });
afterEach(() => {
  for (const root of scopes.splice(0).reverse()) isolation.endPrivateTerminalTmux(root);
  for (const value of fixturePaths.splice(0)) fs.rmSync(value, { recursive: true, force: true });
  if (savedTmp === undefined) delete process.env["TMUX_TMPDIR"]; else process.env["TMUX_TMPDIR"] = savedTmp;
  if (savedTmux === undefined) delete process.env["TMUX"]; else process.env["TMUX"] = savedTmux;
  if (savedPane === undefined) delete process.env["TMUX_PANE"]; else process.env["TMUX_PANE"] = savedPane;
});

it.each([
  ["duplicate named", ["-L", "one", "-L", "two"]],
  ["mixed path then name", ["-S", "/unregistered/never-connect.sock", "-L", "owned"]],
  ["mixed name then path", ["-L", "owned", "-S", "/unregistered/never-connect.sock"]],
  ["missing selector value", ["-S"]],
  ["unknown argument", ["-Q", "owned"]],
  ["control in name", ["-L", "bad\nname"]],
  ["parent name", ["-L", ".."]],
  ["missing config", ["-f"]],
  ["unexpected config", ["-f", "/unregistered/config"]],
])("rejects %s before an inert executor can run", async (_label, args) => {
  const exec = vi.fn(async () => "");
  const service = new TerminalService({ ...deps(exec), tmuxServerArgs: () => args as string[] });
  await expect(service.closeAll({ provider: "tmux" })).rejects.toThrow("Unisolated");
  expect(exec).not.toHaveBeenCalled();
});

it.each(["/unregistered/socket,extra,1,0", "/unregistered/socket,1", "/unregistered/socket", "/unregistered/socket,1,x"])(
  "rejects unsupported TMUX form %s without native execution", value => {
    const root = process.env["TMUX_TMPDIR"]!;
    // Keep the entire malformed value lexically under the root for the old parser.
    expect(() => assertPrivateTerminalTmux([], { TMUX_TMPDIR: root, TMUX: root + value })).toThrow("Unisolated");
  });

it("rejects a symlink followed by a raw parent component", () => {
  const root = process.env["TMUX_TMPDIR"]!;
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "guard-outside-")); fixturePaths.push(other);
  fs.mkdirSync(path.join(other, "sub"));
  fs.symlinkSync(path.join(other, "sub"), path.join(root, "link"));
  expect(() => assertPrivateTerminalTmux(["-S", root + "/link/../never-connect.sock"], {})).toThrow("Unisolated");
});

it.each(["named", "default"])("rejects a %s socket directory alias", form => {
  const root = process.env["TMUX_TMPDIR"]!;
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "guard-outside-")); fixturePaths.push(other);
  fs.symlinkSync(other, path.join(root, `tmux-${process.getuid!()}`));
  expect(() => assertPrivateTerminalTmux(form === "named" ? ["-L", "owned"] : [], { TMUX_TMPDIR: root })).toThrow("Unisolated");
});

it.each([false, true])("rejects replacement of a nested registered root and leaves it untouched, symlink=%s", symlink => {
  const parent = fs.mkdtempSync(path.join(process.env["TMUX_TMPDIR"]!, "guard-replace-")); fixturePaths.push(parent);
  const root = beginOwned(parent);
  fs.renameSync(root, root + "-original");
  if (symlink) {
    fs.mkdirSync(root + "-replacement"); fs.symlinkSync(root + "-replacement", root);
  } else fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "sentinel"), "keep");
  expect(() => assertPrivateTerminalTmux(["-S", path.join(root, "never-connect.sock")], {})).toThrow("Unisolated");
  // Retirement must not remove a directory that no longer has the registered identity.
  isolation.endPrivateTerminalTmux(root);
  expect(fs.readFileSync(path.join(root, "sentinel"), "utf8")).toBe("keep");
});

it("retires owned roots with a retained temp directory and leaves its parent and reused home intact", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "guard-retained-")); fixturePaths.push(parent);
  fs.mkdirSync(path.join(parent, "reused-home")); fs.writeFileSync(path.join(parent, "sentinel"), "keep");
  const root = beginOwned(parent);
  expect(() => assertPrivateTerminalTmux(["-S", path.join(root, "absent.sock")], {})).not.toThrow();
  isolation.endPrivateTerminalTmux(root);
  expect(fs.existsSync(root)).toBe(false);
  expect(fs.readFileSync(path.join(parent, "sentinel"), "utf8")).toBe("keep");
  expect(fs.statSync(path.join(parent, "reused-home")).isDirectory()).toBe(true);
  expect(() => assertPrivateTerminalTmux(["-S", path.join(root, "absent.sock")], {})).toThrow("Unisolated");
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
  expect(() => assertPrivateTerminalTmux(["-L", "owned", "-f", "/dev/null"], { TMUX_TMPDIR: root })).not.toThrow();
  expect(() => assertPrivateTerminalTmux([], { TMUX_TMPDIR: root, TMUX: `${root}/owned.sock,1,0` })).not.toThrow();
  expect(() => assertPrivateTerminalTmux(["-S", root + "/owned.sock\n"], {})).toThrow("Unisolated");
  expect(() => assertPrivateTerminalTmux(["-S", root + "/./owned.sock"], {})).toThrow("Unisolated");
  expect(() => assertPrivateTerminalTmux([], { TMUX_TMPDIR: root, TMUX: "/unregistered/never-connect.sock,1,0" })).toThrow("Unisolated");
  expect(() => assertPrivateTerminalTmux(["-S", path.join(root, "..", "never-connect.sock")], {})).toThrow("Unisolated");
});
