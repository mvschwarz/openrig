import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";

// The managed Claude launch runs `env -i`, which drops everything the pane shell has. These run the
// command it builds in a real shell and read back what the (fake) claude process was left with.
const exec = promisify(execFile);
const cleanup: Array<() => void> = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

function fixture(opts: { rigEnv?: object; memberEnv?: object; sessionMarker?: string; sessionReadFails?: boolean }) {
  const root = mkdtempSync(path.join(tmpdir(), "seat-env-claude-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"); const home = path.join(root, "home"); const cwd = path.join(root, "work");
  for (const dir of [bin, home, cwd]) mkdirSync(dir);
  const claude = path.join(bin, "claude");
  writeFileSync(claude, `#!/bin/sh
if [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; exit 0; fi
printf '{"FOO":"%s","DECLARED_UNSET":"%s","LEAKED":"%s","HOME":"%s"}' "\${FOO-absent}" "\${DECLARED_UNSET-absent}" "\${LEAKED-absent}" "$HOME"
`);
  chmodSync(claude, 0o700);
  const db = new Database(":memory:"); cleanup.push(() => { db.close(); });
  db.exec(`CREATE TABLE rigs(id TEXT, env_json TEXT);
    CREATE TABLE nodes(id TEXT, rig_id TEXT, runtime TEXT, cwd TEXT, env_json TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
  db.prepare("INSERT INTO rigs VALUES ('rig', ?)").run(opts.rigEnv ? JSON.stringify(opts.rigEnv) : null);
  db.prepare("INSERT INTO nodes VALUES ('node', 'rig', 'claude-code', ?, ?)").run(cwd, opts.memberEnv ? JSON.stringify(opts.memberEnv) : null);
  db.exec("INSERT INTO bindings VALUES ('b', 'node', 'seat@rig', '%1'); INSERT INTO occupant_tenures VALUES ('node', 'gen', 1)");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home };
  const reads: Array<[string, string]> = [];
  const managed = new ClaudeManagedLaunch(db, env, {}, async (session, key) => {
    reads.push([session, key]);
    if (opts.sessionReadFails) throw new Error("Cannot read the session's launch environment.");
    return opts.sessionMarker;
  });
  const run = async (command: string, paneEnv: Record<string, string>) => {
    const { stdout } = await exec("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin", ...paneEnv }, timeout: 5000 });
    return JSON.parse(stdout) as Record<string, string>;
  };
  return { managed, run, reads, home };
}

const target = { nodeId: "node", session: "seat@rig", pane: "%1" };

describe.skipIf(process.platform === "win32")("managed Claude launch and a seat's declared env", () => {
  it("passes the declared variables through env -i, and only those", async () => {
    const f = fixture({ rigEnv: { FOO: "from-rig" }, memberEnv: { FOO: "from-member" } });
    const command = (await f.managed.prepare(target, "auto")).command(["--permission-mode", "auto"]);
    const seen = await f.run(command, { FOO: "from-member", LEAKED: "should-not-pass" });
    expect(seen).toMatchObject({ FOO: "from-member", LEAKED: "absent" });
    expect(command).not.toContain("from-member"); // the value is read from the pane, not written into the command text
  });

  it("forwards a one-off name recorded on the session, and leaves unset declared names unset", async () => {
    const f = fixture({ rigEnv: { DECLARED_UNSET: "x" }, sessionMarker: "FOO" });
    const command = (await f.managed.prepare(target, "auto")).command(["--permission-mode", "auto"]);
    const seen = await f.run(command, { FOO: "one-off" });
    expect(seen).toMatchObject({ FOO: "one-off", DECLARED_UNSET: "absent" });
    expect(f.reads).toEqual([["seat@rig", "OPENRIG_SEAT_ENV_KEYS"]]);
  });

  it("treats an unreadable session as having no one-off names, and still forwards the declared ones", async () => {
    const f = fixture({ rigEnv: { FOO: "declared" }, sessionReadFails: true });
    const command = (await f.managed.prepare(target, "auto")).command(["--permission-mode", "auto"]);
    expect(f.reads).toEqual([["seat@rig", "OPENRIG_SEAT_ENV_KEYS"]]);
    expect(await f.run(command, { FOO: "declared", LEAKED: "no" })).toMatchObject({ FOO: "declared", LEAKED: "absent" });
  });

  it("launches a seat with no env exactly as before when the session can't be read", async () => {
    const f = fixture({ sessionReadFails: true });
    const command = (await f.managed.prepare(target, "auto")).command(["--permission-mode", "auto"]);
    expect(command).not.toMatch(/\$\{[A-Z_]+\+/);
  });

  it("never lets a declared name replace the launch's own HOME", async () => {
    const f = fixture({ rigEnv: { HOME: "/elsewhere", FOO: "1" } });
    const command = (await f.managed.prepare(target, "auto")).command(["--permission-mode", "auto"]);
    const seen = await f.run(command, { HOME: "/elsewhere", FOO: "1" });
    expect(seen.HOME).toBe(f.home);
    expect(seen.FOO).toBe("1");
  });

  it("builds the same command as before when nothing is declared", async () => {
    const f = fixture({});
    const command = (await f.managed.prepare(target, "auto")).command(["--permission-mode", "auto"]);
    expect(command).not.toMatch(/\$\{[A-Z_]+\+/);
    expect((await f.run(command, { FOO: "pane-only" })).FOO).toBe("absent");
  });
});
