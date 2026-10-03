// Captures, the session-environment read and pipe-pane address the exact session. tmux resolves a bare
// `-t name` by prefix when no session has that exact name (checked against tmux 3.6a: with only
// `dev-impl@my-rig2` alive, `capture-pane -t dev-impl@my-rig` printed its screen, `show-environment` read its
// environment, and `pipe-pane` attached to it). So a seat whose session just ended must read as missing, never as
// its prefix sibling. The fake tmux below resolves targets the same way, in both exec modes.
import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

interface Session { screen: string; env: Record<string, string>; pipedTo?: string }
type Sessions = Record<string, Session>;

/** tmux's session resolution: `=name` is exact; a bare name is exact first, then a unique prefix. `%N` is a pane id. */
function resolve(target: string, sessions: Sessions): string | null {
  const names = Object.keys(sessions);
  if (/^%\d+$/.test(target)) return names[Number(target.slice(1))] ?? null;
  if (target.startsWith("=")) {
    const name = target.slice(1).replace(/:$/, "");
    return name in sessions ? name : null;
  }
  const name = target.replace(/:.*$/, "");
  if (name in sessions) return name;
  const matches = names.filter((n) => n.startsWith(name));
  return matches.length === 1 ? matches[0]! : null;
}

function runTmux(argv: string[], sessions: Sessions): string {
  const target = argv[argv.indexOf("-t") + 1]!;
  const name = resolve(target, sessions);
  if (name === null) throw new Error(`can't find session: ${target.replace(/^=/, "").replace(/:$/, "")}`);
  const session = sessions[name]!;
  switch (argv[1]) {
    case "capture-pane": return session.screen;
    case "show-environment": return Object.entries(session.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    case "pipe-pane": { session.pipedTo = argv[argv.indexOf("-t") + 2]; return ""; }
    default: throw new Error(`unexpected tmux command ${argv[1]}`);
  }
}

/** The shell-string mode: split the legacy command back into argv (single quotes). */
function shellToArgv(cmd: string): string[] {
  const argv: string[] = [];
  for (const m of cmd.matchAll(/'((?:[^']|'"'"')*)'|(\S+)/g)) argv.push(m[1] !== undefined ? m[1].replace(/'"'"'/g, "'") : m[2]!);
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
    const onlySibling = (): Sessions => ({ [SIBLING]: { screen: "SIBLING-SCREEN\n", env: { OPENRIG_PROBE: "yes" } } });

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
