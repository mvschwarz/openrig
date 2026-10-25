// Real private tmux servers and terminal seats; no provider apps or model calls.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { composeView } from "../src/domain/terminal/view-composer.js";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
const exec = promisify(execFile);
const until = async (predicate: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 40));
  }
  throw new Error("Timed out waiting for the tile's observed state");
};
async function fixture(run: (f: {
  socket: string; seats: (args: string[]) => Promise<string>;
  viewer: (args: string[]) => Promise<string>; adapter: TmuxAdapter;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "tile-follow-")), socket = join(root, "seats");
  const env = { ...process.env, TERM: "xterm-256color" };
  delete env.TMUX; delete env.TMUX_TMPDIR;
  const tmux = async (sock: string, args: string[]) => (await exec("tmux", ["-S", sock, ...args], { env })).stdout.trim();
  const seats = (args: string[]) => tmux(socket, args), viewer = (args: string[]) => tmux(join(root, "viewer"), args);
  const adapter = new TmuxAdapter(async () => { throw new Error("argv only"); }, undefined, args => seats(args.slice(1)));
  try {
    await seats(["-f", "/dev/null", "new-session", "-d", "-s", "anchor", "sleep 60"]);
    // Even a user's permissive global option must not switch a tile to another seat (#187).
    await seats(["set-option", "-g", "detach-on-destroy", "off"]);
    await viewer(["-f", "/dev/null", "new-session", "-d", "-s", "anchor", "sleep 60"]);
    await viewer(["set-option", "-g", "-w", "remain-on-exit", "on"]);
    try { await run({ socket, seats, viewer, adapter }); }
    catch (error) {
      console.log("TILE_DIAG", await seats(["list-sessions", "-F", "#{pid} #{session_id} #{session_name} #{session_attached}"]));
      for (const pane of (await viewer(["list-panes", "-t", "=view:", "-F", "#{pane_id}"])).split("\n")) console.log(pane, await viewer(["capture-pane", "-p", "-S", "-100", "-t", pane]));
      throw error;
    }
  } finally {
    await viewer(["kill-server"]).catch(() => {});
    await seats(["kill-server"]).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}
const terminal = (command: string) => `env -u TMUX sh -c ${shellQuote(command)}`;
it.skipIf(process.platform === "win32")("keeps all four terminal tiles on their seats after a fresh session replaces one", async () => {
  await fixture(async ({ socket, seats, viewer, adapter }) => {
    const names = Array.from({ length: 4 }, (_, i) => `dev${i}@demo`);
    const create = (i: number, text = `SEAT${i}`) => seats(["new-session", "-d", "-s", names[i]!, "-e", `OPENRIG_NODE_ID=node${i}`, `printf '%s\\n' ${text}; sleep 60`]);
    for (let i = 0; i < 4; i++) await create(i);
    const view = composeView("demo", names.map((seat, i) => ({ seat, label: seat, tmuxSession: seat, host: null, readOnly: i === 3, alive: true })), {
      resolveHost: () => null, localTmuxServer: ["-S", socket],
    });
    const panes: string[] = [];
    for (const [i, tile] of view.opened.entries()) {
      panes.push(await viewer(i === 0 ? ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "view", terminal(tile.paneCommand)] : ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=view:", terminal(tile.paneCommand)]));
      await viewer(["select-layout", "-t", "=view:", "tiled"]);
    }
    const attached = () => seats(["list-sessions", "-F", "#{session_name}:#{session_attached}"]);
    const expected = ["anchor:0", ...names.map(name => `${name}:1`)].sort();
    await until(async () => JSON.stringify((await attached()).split("\n").sort()) === JSON.stringify(expected));
    expect(await seats(["list-clients", "-t", `=${names[3]}`, "-F", "#{client_readonly}"])).toBe("1");
    expect((await adapter.killSession(names[1]!)).ok).toBe(true);
    await create(1, "REPLACED_SEAT1");
    await until(async () => JSON.stringify((await attached()).split("\n").sort()) === JSON.stringify(expected));
    expect((await viewer(["list-panes", "-t", "=view:", "-F", "#{pane_dead}"])).split("\n")).toEqual(["0", "0", "0", "0"]);
    await until(async () => (await viewer(["capture-pane", "-p", "-t", panes[1]!])).includes("REPLACED_SEAT1"));
    // Current handover/restart respawn in place; the same tile stays attached.
    await seats(["respawn-pane", "-k", "-t", `=${names[0]}:`, "printf 'RESPAWNED_SEAT0\\n'; sleep 60"]);
    await until(async () => (await viewer(["capture-pane", "-p", "-t", panes[0]!])).includes("RESPAWNED_SEAT0"));
    expect((await attached()).split("\n").sort()).toEqual(expected);
    // A fresh launch of the last session restarts the server and can reuse $0.
    for (const i of [0, 2, 3]) expect((await adapter.killSession(names[i]!)).ok).toBe(true);
    await seats(["kill-session", "-t", "=anchor"]);
    expect((await adapter.killSession(names[1]!)).ok).toBe(true);
    await create(1, "NEW_SERVER_SEAT1");
    await until(async () => (await viewer(["capture-pane", "-p", "-t", panes[1]!])).includes("NEW_SERVER_SEAT1"));
    expect(await seats(["list-clients", "-F", "#{session_name}"])).toBe(names[1]);
  });
});

it.skipIf(process.platform === "win32").each(["detach", "identity", "removed", "unmanaged", "removed-marker"])("ends the tile on %s without attaching a sibling", async mode => {
  await fixture(async ({ socket, seats, viewer, adapter }) => {
    await seats(["new-session", "-d", "-s", "seat", ...(mode === "unmanaged" ? [] : ["-e", "OPENRIG_NODE_ID=original"]), "sleep 60"]);
    if (mode === "removed-marker") await seats(["set-environment", "-r", "-t", "=seat", "OPENRIG_NODE_ID"]);
    const command = tileAttachArgv("tmux", ["-S", socket], "seat", false, mode === "detach" ? 4 : 2).map(shellQuote).join(" ");
    await viewer(["new-session", "-d", "-s", "view", terminal(command)]);
    await until(async () => (await seats(["list-clients", "-t", "=seat", "-F", "#{session_name}"])) === "seat");
    if (mode === "detach") await seats(["detach-client", "-s", "=seat"]);
    else {
      expect((await adapter.killSession("seat")).ok).toBe(true);
      const name = mode === "removed" ? "seat-prefix" : "seat";
      await seats(["new-session", "-d", "-s", name, "-e", "OPENRIG_NODE_ID=other-seat", "sleep 60",
        ...(mode === "removed-marker" ? [";", "set-environment", "-r", "-t", "=seat", "OPENRIG_NODE_ID"] : [])]);
    }
    await until(async () => (await viewer(["display-message", "-p", "-t", "=view:", "#{pane_dead}"])) === "1");
    expect(await seats(["list-clients", "-F", "#{session_name}"])).toBe("");
    if (mode === "detach") expect(await viewer(["capture-pane", "-p", "-t", "=view:"])).not.toContain("No replacement");
  });
});

it.skipIf(process.platform === "win32")("waits through missing-target observations without reading a sibling's identity", async () => {
  await fixture(async ({ socket, seats, viewer, adapter }) => {
    await seats(["set-environment", "-t", "=anchor", "OPENRIG_NODE_ID", "sibling"]);
    const create = () => seats(["new-session", "-d", "-s", "seat", "-e", "OPENRIG_NODE_ID=original", "printf 'REPLACEMENT\\n'; sleep 60"]);
    await create();
    const wrapper = `${socket}-probe`, missing = `${socket}-missing`;
    // Observe actual tmux absence; don't create the replacement until two retry probes saw it.
    writeFileSync(wrapper, `#!/bin/sh
if [ "$3" = display-message ] && ! tmux -S ${shellQuote(socket)} has-session -t =seat 2>/dev/null; then
  printf '%s\\n' missing >> ${shellQuote(missing)}
fi
exec tmux "$@"
`, { mode: 0o700 });
    const command = tileAttachArgv(wrapper, ["-S", socket], "seat", false).map(shellQuote).join(" ");
    await viewer(["new-session", "-d", "-s", "view", terminal(command)]);
    await until(async () => (await seats(["list-clients", "-t", "=seat", "-F", "#{session_name}"])) === "seat");
    expect((await adapter.killSession("seat")).ok).toBe(true);
    await until(async () => existsSync(missing) && readFileSync(missing, "utf8").trim().split("\n").length >= 2);
    await create();
    await until(async () => (await seats(["list-clients", "-F", "#{session_name}"])) === "seat");
    expect(await viewer(["display-message", "-p", "-t", "=view:", "#{pane_dead}"])).toBe("0");
  });
});
it.skipIf(process.platform === "win32")("does not attach a sibling when the requested session disappeared before opening", async () => {
  await fixture(async ({ socket, seats, viewer }) => {
    await seats(["set-environment", "-t", "=anchor", "OPENRIG_NODE_ID", "sibling"]);
    const command = tileAttachArgv("tmux", ["-S", socket], "missing", false).map(shellQuote).join(" ");
    await viewer(["new-session", "-d", "-s", "view", terminal(command)]);
    await until(async () => (await viewer(["display-message", "-p", "-t", "=view:", "#{pane_dead}"])) === "1");
    expect(await seats(["list-clients", "-F", "#{session_name}"])).toBe("");
  });
});
