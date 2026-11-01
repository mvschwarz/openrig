import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadCommunityHarnessPreset } from "../src/domain/community-harness-presets.js";

// The documented interactive-Pi example, run against a stand-in `pi` that records how it was started (no Pi, no model).
const EXAMPLE = resolve(__dirname, "../../../docs/reference/community-harness-examples/pi-tui");
const NAME = "openrig-team-worker-0123abcd";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function seatFolders(dir: string) {
  const home = join(dir, "home");
  const state = join(home, "state", "pi-tui", "node-1");
  return { home, state, sessions: join(state, "sessions") };
}

// A session file as Pi 1.4.0 writes one: <time>_<id>.jsonl, whose first line is the session header.
function addSession(sessions: string, id: string, fileId = id, stamp = "2026-10-27T14-13-00-123Z") {
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, `${stamp}_${fileId}.jsonl`);
  writeFileSync(file, `{"type":"session","version":3,"id":"${id}","timestamp":"2026-10-27T14:13:00.123Z","cwd":"/work"}\n`);
  return file;
}

// Another conversation's header that carries the requested id only nested inside it: Pi would open that other conversation.
function addNestedIdSession(sessions: string, id: string) {
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, `2026-10-27T14-13-00-123Z_${id}.jsonl`),
    `{"type":"session","version":3,"id":"openrig-other-0000ffff","meta":{"type":"session","id":"${id}"},"cwd":"/work"}\n`);
}

// `setup` prepares the seat's folders and returns the launch's variables.
function run(setup: (dir: string) => Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "pi-tui-example-")); dirs.push(dir);
  const { home, state, sessions } = seatFolders(dir);
  // The installed openrig-core plugin's queue-handoff skill, with an executable helper.
  const skill = join(home, "plugins", "openrig-core", "skills", "queue-handoff");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: queue-handoff\n---\n");
  writeFileSync(join(skill, "helper.sh"), "#!/bin/sh\n", { mode: 0o755 });
  const fake = join(dir, "pi");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\0' "$@" > "${dir}/args"\nprintf '%s' "$PI_CODING_AGENT_DIR" > "${dir}/agent-dir"\n`);
  chmodSync(fake, 0o755);
  const env = setup(dir);
  const result = spawnSync(join(EXAMPLE, "openrig-pi-tui-launch"), [], { cwd: dir, encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env["PATH"]!, OPENRIG_PI: fake, OPENRIG_HOME: home, OPENRIG_NODE_ID: "node-1", ...env } });
  const read = (name: string) => existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : null;
  return { args: read("args")?.split("\0").slice(0, -1) ?? null, agentDir: read("agent-dir"), exit: result.status, stderr: result.stderr,
    dir, state, sessions };
}

describe("the documented interactive-Pi launcher and preset", () => {
  it("starts Pi on the name OpenRig gave, in the seat's own folders, with the first input as one exact prompt", () => {
    const text = "identity\n'quoted' $literal -x\n";
    const { args, agentDir, state, sessions } = run(dir => {
      const file = join(dir, "first.txt"); writeFileSync(file, text, { mode: 0o600 });
      return { OPENRIG_CONVERSATION: NAME, OPENRIG_FIRST_INPUT: file };
    });
    expect(args).toEqual(["--session-dir", sessions, "--session-id", NAME, "--", text]);
    expect(agentDir).toBe(join(state, "agent"));
    // The released skill is copied whole, its helper still executable.
    expect(readFileSync(join(state, "agent", "skills", "queue-handoff", "SKILL.md"), "utf8")).toContain("name: queue-handoff");
    expect(statSync(join(state, "agent", "skills", "queue-handoff", "helper.sh")).mode & 0o111).not.toBe(0);
  });

  it("passes no prompt when there's no first input", () => {
    const { args, sessions } = run(() => ({ OPENRIG_CONVERSATION: NAME }));
    expect(args).toEqual(["--session-dir", sessions, "--session-id", NAME]);
  });

  it("reopens the one session file whose header has that id, not one whose file name only ends with it", () => {
    let file = "";
    const { args, sessions } = run(dir => {
      const { sessions } = seatFolders(dir);
      file = addSession(sessions, NAME);
      addSession(sessions, `x_${NAME}`);
      return { OPENRIG_RESUME_REF: NAME };
    });
    expect(args).toEqual(["--session-dir", sessions, "--session", file]);
  });

  it.each([
    ["missing", (_: string) => {}],
    ["never written to (empty)", (sessions: string) => { mkdirSync(sessions, { recursive: true }); writeFileSync(join(sessions, `2026-10-27T14-13-00-123Z_${NAME}.jsonl`), ""); }],
    ["held by another id's header", (sessions: string) => { addSession(sessions, "openrig-other-0000ffff", NAME); }],
    ["held by another id's header that nests this id", (sessions: string) => { addNestedIdSession(sessions, NAME); }],
    ["ambiguous (two files)", (sessions: string) => { addSession(sessions, NAME); addSession(sessions, NAME, NAME, "2026-10-27T15-00-00-000Z"); }],
  ])("starts nothing when the session is %s", (_label, prepare) => {
    const { args, exit, stderr } = run(dir => { prepare(seatFolders(dir).sessions); return { OPENRIG_RESUME_REF: NAME }; });
    expect(args).toBeNull();
    expect(exit).toBe(1);
    expect(stderr).toContain("starting nothing");
  });

  it.each(["-dash-first", "has space", "ends-with-dash-", ""])("refuses a name Pi can't take as a session id (%j)", (name) => {
    const { args, exit } = run(() => ({ OPENRIG_CONVERSATION: name }));
    expect(args).toBeNull();
    expect(exit).toBe(2);
  });

  it("uses an agent folder the seat already set, and copies the skills there", () => {
    let own = "";
    const { agentDir } = run(dir => { own = join(dir, "own-agent"); return { OPENRIG_CONVERSATION: NAME, PI_CODING_AGENT_DIR: own }; });
    expect(agentDir).toBe(own);
    expect(existsSync(join(own, "skills", "queue-handoff", "SKILL.md"))).toBe(true);
  });

  it("expands a leading ~ in that folder as Pi does, so the skills land where Pi looks", () => {
    let dirOf = "";
    const { agentDir } = run(dir => { dirOf = dir; return { OPENRIG_CONVERSATION: NAME, HOME: dir, PI_CODING_AGENT_DIR: "~/own-agent" }; });
    expect(agentDir).toBe(join(dirOf, "own-agent"));
    expect(existsSync(join(dirOf, "own-agent", "skills", "queue-handoff", "SKILL.md"))).toBe(true);
  });

  it("declares a named conversation and first input, and no resume until a real Pi has checked it", () => {
    expect(loadCommunityHarnessPreset("pi-tui", EXAMPLE)).toMatchObject({ ok: true,
      preset: { command: "openrig-pi-tui-launch", namesConversation: true, launchResult: false, firstInput: true, resume: false, startupAssisted: false } });
  });
});
