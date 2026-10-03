// Captures, the session-environment read, pipe-pane, the pane command and pid reads, the window option and
// resize, and the unguarded kill address the exact session. tmux resolves a bare `-t name` by prefix when no session
// has that exact name (checked against tmux 3.6a: with only `dev-impl@my-rig2` alive, `capture-pane -t
// dev-impl@my-rig` printed its screen, `show-environment` read its environment, `pipe-pane` attached to it,
// `display-message` reported its command and pid, `set-option -w` and `resize-window` changed its window, and
// `kill-session` killed it). So a seat whose session just ended must read as missing and must not act on its prefix
// sibling. The fake tmux below resolves targets the same way, in both exec modes.
import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

interface Session {
  screen: string; env: Record<string, string>; pipedTo?: string;
  command?: string; pid?: number; options?: Record<string, string>; size?: string;
  dead?: boolean; cursor?: string; activity?: number; respawned?: boolean; viewed?: boolean;
}
type Sessions = Record<string, Session>;

/** tmux's session resolution: `=name` is exact; a bare name is exact first, then a unique prefix. `%N` is a pane id. */
function resolve(target: string, sessions: Sessions): string | null {
  const names = Object.keys(sessions);
  if (/^[%@$]\d+$/.test(target)) return names[Number(target.slice(1))] ?? null;
  if (target.startsWith("=")) {
    const name = target.slice(1).replace(/:.*$/, "");
    return name in sessions ? name : null;
  }
  const name = target.replace(/:.*$/, "");
  if (name in sessions) return name;
  const matches = names.filter((n) => n.startsWith(name));
  return matches.length === 1 ? matches[0]! : null;
}

function runTmux(argv: string[], sessions: Sessions): string {
  const flag = argv[1] === "detach-client" ? "-s" : "-t";
  const target = argv[argv.indexOf(flag) + 1]!;
  // Even session-scoped options use a target-pane. An unqualified =name is not a session target here.
  if (["set-option", "show-option"].includes(argv[1]!) && target.startsWith("=") && !target.includes(":")) {
    throw new Error(`no such session: ${target}`);
  }
  const name = resolve(target, sessions);
  if (name === null) {
    if (argv[1] === "display-message") return "\n"; // tmux 3.6a: an unresolved target prints empty fields, exit 0
    if (argv[1] === "detach-client") throw new Error("no current client");
    throw new Error(`can't find session: ${target.replace(/^=/, "").replace(/:$/, "")}`);
  }
  const session = sessions[name]!;
  switch (argv[1]) {
    case "display-message": {
      const format = argv[argv.length - 1]!;
      const value = format === "#{pane_pid}" ? session.pid
        : format === "#{pane_dead}" ? Number(session.dead ?? false)
        : format === "#{window_activity}" ? session.activity
        : format.includes("#{cursor_x}") ? session.cursor : session.command;
      return `${value}\n`;
    }
    case "set-option": { session.options = { ...session.options, [argv[argv.length - 2]!]: argv[argv.length - 1]! }; return ""; }
    case "show-option": return `${session.options?.[argv[argv.length - 1]!] ?? ""}\n`;
    case "respawn-pane": session.respawned = true; return "";
    case "switch-client": session.viewed = true; return "";
    case "resize-window": { session.size = `${argv[argv.indexOf("-x") + 1]}x${argv[argv.indexOf("-y") + 1]}`; return ""; }
    case "detach-client": throw new Error("no current client");
    case "kill-session": { delete sessions[name]; return ""; }
    case "capture-pane": return session.screen;
    case "show-environment": return Object.entries(session.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    case "pipe-pane": { session.pipedTo = argv[argv.indexOf("-t") + 2]; return ""; }
    default: throw new Error(`unexpected tmux command ${argv[1]}`);
  }
}

/** The shell-string mode: split the legacy command back into argv (single quotes, plain double quotes). */
function shellToArgv(cmd: string): string[] {
  const argv: string[] = [];
  for (const m of cmd.matchAll(/'((?:[^']|'"'"')*)'|"([^"]*)"|(\S+)/g)) {
    argv.push(m[1] !== undefined ? m[1].replace(/'"'"'/g, "'") : m[2] !== undefined ? m[2] : m[3]!);
  }
  return argv;
}

const SIBLING = "dev-impl@my-rig2";
const GONE = "dev-impl@my-rig";

describe("exact session targets for capture, session environment and pipe-pane", () => {
  for (const mode of ["shell", "argv"] as const) {
    function adapter(sessions: Sessions) {
      const calls: string[][] = [];
      const run = (argv: string[]) => { calls.push(argv); return runTmux(argv, sessions); };
      const a = mode === "argv"
        ? new TmuxAdapter(async () => { throw new Error("shell path unused"); }, undefined, async (argv: string[]) => run(argv))
        : new TmuxAdapter(async (cmd: string) => run(shellToArgv(cmd)));
      return { a, calls };
    }
    const onlySibling = (): Sessions => ({
      [SIBLING]: { screen: "SIBLING-SCREEN\n", env: { OPENRIG_PROBE: "yes" }, command: "cat", pid: 4242, size: "120x40" },
    });

    it(`${mode}: remaining: respawning an ended session does not respawn its sibling`, async () => {
      const sessions = onlySibling();
      const { a } = adapter(sessions);
      expect(await a.respawnPane(GONE, "cat")).toMatchObject({ ok: false });
      expect(sessions[SIBLING]!.respawned).toBeUndefined();
    });

    it(`${mode}: remaining: switching to an ended session leaves the client alone`, async () => {
      const sessions = onlySibling();
      const { a } = adapter(sessions);
      expect(await a.switchClient("client", GONE)).toMatchObject({ ok: false });
      expect(sessions[SIBLING]!.viewed).toBeUndefined();
    });

    it(`${mode}: remaining: remain-on-exit does not change a sibling pane`, async () => {
      const sessions = onlySibling();
      const { a } = adapter(sessions);
      expect(await a.setRemainOnExit(GONE, true)).toMatchObject({ ok: false });
      expect(sessions[SIBLING]!.options).toBeUndefined();
    });

    it(`${mode}: remaining: a dead sibling is not evidence the addressed pane is dead`, async () => {
      const sessions = onlySibling(); sessions[SIBLING]!.dead = true;
      const { a } = adapter(sessions);
      // display-message returns an empty field for a missing name (exit 0), not pane_dead=1.
      expect(await a.isPaneDead(GONE)).toBe(false);
    });

    it(`${mode}: remaining: cursor coordinates do not come from the sibling`, async () => {
      const sessions = onlySibling(); sessions[SIBLING]!.cursor = "2|3|80|24";
      const { a } = adapter(sessions);
      expect(await a.getPaneCursorPosition(GONE)).toBeNull();
    });

    it(`${mode}: remaining: activity does not come from the sibling`, async () => {
      const sessions = onlySibling(); sessions[SIBLING]!.activity = 1790000100;
      const { a } = adapter(sessions);
      expect(await a.readPaneLastActivity(GONE)).toBeNull();
    });

    it(`${mode}: remaining: session option writes leave the sibling alone`, async () => {
      const sessions = onlySibling();
      const { a } = adapter(sessions);
      expect(await a.setSessionOption(GONE, "@probe", "new")).toMatchObject({ ok: false });
      expect(sessions[SIBLING]!.options).toBeUndefined();
    });

    it(`${mode}: remaining: session option reads do not come from the sibling`, async () => {
      const sessions = onlySibling(); sessions[SIBLING]!.options = { "@probe": "sibling" };
      const { a } = adapter(sessions);
      expect(await a.getSessionOption(GONE, "@probe")).toBeNull();
    });

    for (const target of [GONE, "%1", "@1", "$1", `=${GONE}:0.0`]) {
      it(`${mode}: remaining: live name/id/qualified target ${target} still addresses itself`, async () => {
        const sessions: Sessions = { ...onlySibling(), [GONE]: {
          screen: "OWN", env: {}, cursor: "2|3|80|24", activity: 1790000100, dead: true,
        } };
        const { a, calls } = adapter(sessions);
        expect(await a.isPaneDead(target)).toBe(true);
        expect(await a.getPaneCursorPosition(target)).toEqual({ x: 2, y: 3, width: 80, height: 24 });
        expect(await a.readPaneLastActivity(target)).toBe(1790000100);
        expect(await a.setSessionOption(target, "@probe", "own")).toEqual({ ok: true });
        expect(await a.getSessionOption(target, "@probe")).toBe("own");
        expect(await a.setRemainOnExit(target, true)).toEqual({ ok: true });
        expect(await a.respawnPane(target, "cat")).toEqual({ ok: true });
        expect(await a.switchClient("client", target)).toEqual({ ok: true });
        expect(sessions[GONE]).toMatchObject({ respawned: true, viewed: true, options: { "@probe": "own", "remain-on-exit": "on" } });
        expect(sessions[SIBLING]!.options).toBeUndefined();
        if (target !== GONE) expect(calls.every((c) => c[c.indexOf("-t") + 1] === target)).toBe(true);
      });
    }

    it(`${mode}: the pane command and pid of an ended session are null, not the sibling's`, async () => {
      const { a, calls } = adapter(onlySibling());
      expect(await a.getPaneCommand(GONE)).toBeNull();
      expect(await a.getPanePid(GONE)).toBeNull();
      expect(calls.map((c) => c[c.indexOf("-t") + 1])).toEqual([`=${GONE}:`, `=${GONE}:`]);
    });

    it(`${mode}: a window option or resize on an ended session fails and leaves the sibling's window alone`, async () => {
      const sessions = onlySibling();
      const { a } = adapter(sessions);
      expect(await a.setWindowOption(GONE, "automatic-rename", "off")).toMatchObject({ ok: false });
      expect(await a.resizeWindow(GONE, 50, 20)).toMatchObject({ ok: false });
      expect(sessions[SIBLING]).toMatchObject({ size: "120x40" });
      expect(sessions[SIBLING]!.options).toBeUndefined();
    });

    it(`${mode}: killing an ended session by name kills nothing; the sibling survives`, async () => {
      const sessions = onlySibling();
      const { a, calls } = adapter(sessions);
      expect(await a.killSession(GONE)).toMatchObject({ ok: false, code: "session_not_found" });
      expect(Object.keys(sessions)).toEqual([SIBLING]);
      expect(calls.map((c) => c[c.indexOf(c[1] === "detach-client" ? "-s" : "-t") + 1])).toEqual([`=${GONE}`, `=${GONE}`]);
    });

    it(`${mode}: the guarded kill's immutable $N id passes through and kills exactly that session`, async () => {
      const sessions: Sessions = { ...onlySibling(), [GONE]: { screen: "OWN-SCREEN\n", env: {} } };
      const { a, calls } = adapter(sessions);
      const unchecked = (a as unknown as { killSessionUnchecked(name: string): Promise<{ ok: boolean }> }).killSessionUnchecked;
      expect(await unchecked.call(a, "$1")).toEqual({ ok: true });
      expect(Object.keys(sessions)).toEqual([SIBLING]);
      expect(calls.map((c) => c[c.indexOf(c[1] === "detach-client" ? "-s" : "-t") + 1])).toEqual(["$1", "$1"]);
    });

    it(`${mode}: a live session's command, pid, window and kill act on itself only`, async () => {
      const sessions: Sessions = { ...onlySibling(), [GONE]: { screen: "OWN-SCREEN\n", env: {}, command: "codex", pid: 7, size: "80x24" } };
      const { a } = adapter(sessions);
      expect(await a.getPaneCommand(GONE)).toBe("codex");
      expect(await a.getPanePid(GONE)).toBe(7);
      expect(await a.setWindowOption(GONE, "automatic-rename", "off")).toEqual({ ok: true });
      expect(await a.resizeWindow(GONE, 100, 30)).toEqual({ ok: true });
      expect(sessions[GONE]).toMatchObject({ size: "100x30", options: { "automatic-rename": "off" } });
      expect(sessions[SIBLING]).toMatchObject({ size: "120x40" });
      expect(await a.killSession(GONE)).toEqual({ ok: true });
      expect(Object.keys(sessions)).toEqual([SIBLING]);
    });

    it(`${mode}: a capture of a session that has ended is missing, not its prefix sibling's screen`, async () => {
      const { a, calls } = adapter(onlySibling());
      expect(await a.capturePaneContent(GONE, 30)).toBeNull();
      expect(await a.capturePaneScreen(GONE)).toBeNull();
      expect(calls.map((c) => c[c.indexOf("-t") + 1])).toEqual([`=${GONE}:`, `=${GONE}:`]);
    });

    it(`${mode}: the session-environment read of an ended session is unknown, not its sibling's`, async () => {
      const { a } = adapter(onlySibling());
      expect(await a.hasSessionEnv(GONE, "OPENRIG_PROBE")).toBeNull();
    });

    it(`${mode}: pipe-pane on an ended session fails and leaves the sibling unpiped; stop does not touch the sibling`, async () => {
      const sessions = onlySibling();
      const { a } = adapter(sessions);
      expect(await a.startPipePane(GONE, "/tmp/transcript.log")).toMatchObject({ ok: false, code: "session_not_found" });
      sessions[SIBLING]!.pipedTo = "cat >> '/tmp/sibling.log'";
      expect(await a.stopPipePane(GONE)).toMatchObject({ ok: false });
      expect(sessions[SIBLING]!.pipedTo).toBe("cat >> '/tmp/sibling.log'");
    });

    it(`${mode}: a live session still reads and pipes itself; pane ids and explicit targets pass through`, async () => {
      const sessions: Sessions = { ...onlySibling(), [GONE]: { screen: "OWN-SCREEN\n", env: {} } };
      const { a, calls } = adapter(sessions);
      expect(await a.capturePaneContent(GONE)).toBe("OWN-SCREEN\n");
      expect(await a.capturePaneScreen(GONE)).toBe("OWN-SCREEN\n");
      expect(await a.hasSessionEnv(GONE, "OPENRIG_PROBE")).toBe(false);
      expect(await a.startPipePane(GONE, "/tmp/own.log")).toEqual({ ok: true });
      expect(sessions[GONE]!.pipedTo).toBe("cat >> '/tmp/own.log'");
      expect(sessions[SIBLING]!.pipedTo).toBeUndefined();
      expect(await a.capturePaneContent("%0")).toBe("SIBLING-SCREEN\n");
      expect(await a.capturePaneContent(`${GONE}:0.0`)).toBe("OWN-SCREEN\n");
      expect(await a.capturePaneContent("%dev")).toBeNull(); // a name that only starts like an id is still exact
      const targets = calls.map((c) => c[c.indexOf("-t") + 1]);
      expect(targets).toEqual([`=${GONE}:`, `=${GONE}:`, `=${GONE}`, `=${GONE}:`, "%0", `${GONE}:0.0`, "=%dev:"]);
    });
  }
});
