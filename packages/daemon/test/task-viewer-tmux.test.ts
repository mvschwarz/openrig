// Real private tmux stand-ins and simulated provider placement. No Herdr app,
// agent binary, owner daemon or model: this checks attachment mechanics only.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { HerdrViewer } from "../src/domain/terminal/herdr-viewer.js";
import { composeView } from "../src/domain/terminal/view-composer.js";
import { resolveOnPath } from "../src/adapters/tmux-exec.js";
const exec = promisify(execFile);
it.skipIf(process.platform !== "linux")("preserves four seat identities and focused typed input through three-four-three viewer membership", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "task-viewer-"));
  const seatSocket = path.join(root, "seats"), tileSocket = path.join(root, "tiles");
  const tmux = resolveOnPath("tmux", process.env.PATH)!; expect(tmux).toBeTruthy();
  const env = { ...process.env, TERM: "xterm-256color" }; delete env.TMUX; delete env.TMUX_TMPDIR;
  const call = async (socket: string, args: string[]) => (await exec(tmux, ["-S", socket, ...args], { env })).stdout.trim();
  const wait = async (check: () => Promise<boolean>) => { for (let n = 0; n < 80; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error("private viewer did not reach expected state"); };
  const panes = new Map<string, { pane_id: string; workspace_id: string; terminal_id: string; cwd: string; source: string }>();
  let serial = 0;
  try {
    await call(seatSocket, ["-f", "/dev/null", "new-session", "-d", "-s", "anchor", "sleep 120"]);
    await call(tileSocket, ["-f", "/dev/null", "new-session", "-d", "-s", "anchor", "sleep 120"]);
    for (let i = 0; i < 4; i++) await call(seatSocket, ["new-session", "-d", "-s", `seat${i}`, "-e", `OPENRIG_NODE_ID=node${i}`, "cat"]);
    const identity = async () => call(seatSocket, ["list-panes", "-a", "-F", "#{pid}:#{session_id}:#{pane_id}:#{pane_pid}:#{session_created}"]);
    const before = await identity();
    const run = async (args: string[]) => {
      const command = args.slice(0, 2).join(" ");
      if (command === "status server") return JSON.stringify({ running: true, version: "0.9.5", protocol: 22, socket: "/fixture-herdr" });
      if (command === "workspace create") {
        const source = `tile${++serial}`;
        const pane_id = await call(tileSocket, ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", source, "sleep 120"]);
        const p = { pane_id, workspace_id: source, terminal_id: `term_${serial}`, cwd: args[args.indexOf("--cwd") + 1]!, source };
        panes.set(pane_id, p); return JSON.stringify({ root_pane: p });
      }
      const p = panes.get(args[2] === "--pane" ? args[3]! : args[2]!); if (!p) throw new Error("unknown simulated viewer pane");
      if (command === "pane get") return JSON.stringify({ pane: p });
      if (command === "pane run") {
        await call(tileSocket, ["respawn-pane", "-k", "-t", p.pane_id, `env -u TMUX ${args[3]}`]);
        await wait(async () => (await call(seatSocket, ["list-clients", "-F", "#{session_name}"])).includes(`seat${serial - 1}`));
        return "";
      }
      if (command === "pane process-info") {
        const clients = (await call(seatSocket, ["list-clients", "-F", "#{session_name} #{client_pid}"])).split("\n");
        const name = `seat${Number(p.terminal_id.slice(5)) - 1}`;
        const pid = clients.find(line => line.startsWith(name + " "))?.split(" ")[1];
        const argv = pid ? readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean) : [];
        return JSON.stringify({ process_info: { foreground_processes: [{ argv }] } });
      }
      throw new Error(`unselected provider operation ${command}`);
    };
    const manager = new HerdrViewer("/fixture-herdr", run, "linux", path.join(root, "journal"));
    const ensure = async (i: number) => {
      const member = { seat: `seat${i}`, label: `seat${i}`, tmuxSession: `seat${i}`, host: null, readOnly: false, alive: true };
      const target = composeView("qitem:fixture", [member], { resolveHost: () => null, localTmux: tmux, localTmuxServer: ["-S", seatSocket] }).opened[0]!;
      const r = await manager.ensure({ hostId: "box", nodeId: `node${i}` }, target); expect(r.ok).toBe(true); return r;
    };
    const initial = []; for (let i = 0; i < 3; i++) initial.push(await ensure(i));
    const focused = [...panes.values()][0]!;
    const type = async (text: string) => { await call(tileSocket, ["send-keys", "-t", focused.pane_id, "-l", text]); };
    await type("one-"); const fourth = await ensure(3); await type("two-");
    // Departure is browser membership only: no close, focus or seat effect.
    const participating = new Set([0, 2, 3]); expect(participating.size).toBe(3);
    const pinnedLeaver = { viewer: initial[1], participating: false }; expect(pinnedLeaver.participating).toBe(false);
    await type("three"); await call(tileSocket, ["send-keys", "-t", focused.pane_id, "Enter"]);
    await wait(async () => (await call(seatSocket, ["capture-pane", "-p", "-t", "=seat0:"])).includes("one-two-three"));
    expect(await identity()).toBe(before);
    expect(await ensure(0)).toMatchObject({ created: false, viewer: initial[0]!.ok ? initial[0]!.viewer : null });
    expect(serial).toBe(4); expect(fourth.ok).toBe(true);
    expect((await call(tileSocket, ["list-sessions", "-F", "#{session_name}"])).split("\n").sort()).toEqual(["anchor", "tile1", "tile2", "tile3", "tile4"]);
  } finally {
    await call(tileSocket, ["kill-server"]).catch(() => {}); await call(seatSocket, ["kill-server"]).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
