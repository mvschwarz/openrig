// A daemon started from inside tmux on a non-default socket creates its sessions on that server,
// and a person's new terminal reaches the default one. Every printed attach command must name the
// daemon's server then, and keep today's form on the default server.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDaemonTmuxServer, tmuxAttachCommand, tmuxServerArgs } from "../src/adapters/tmux-server.js";
import { composeView, type ViewMemberInput } from "../src/domain/terminal/view-composer.js";

describe("the daemon's tmux server", () => {
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "openrig-tmux-server-")));
    mkdirSync(join(base, "tmux-501"));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    setDaemonTmuxServer([]);
  });

  it("names no server outside tmux, or on tmux's standard default socket", () => {
    const standard = join(realpathSync("/tmp"), "tmux-501");
    expect(tmuxServerArgs({}, 501)).toEqual([]);
    expect(tmuxServerArgs({ TMUX: "" }, 501)).toEqual([]);
    expect(tmuxServerArgs({ TMUX: " ,1,0" }, 501)).toEqual([]);
    // Outside tmux the daemon shares the TMUX_TMPDIR of the shell that started it: today's form.
    expect(tmuxServerArgs({ TMUX_TMPDIR: base }, 501)).toEqual([]);
    expect(tmuxServerArgs({ TMUX: `${standard}/default,123,0` }, 501)).toEqual([]);
    expect(tmuxServerArgs({ TMUX: `${standard}/default,123,0`, TMUX_TMPDIR: "/tmp" }, 501)).toEqual([]);
  });

  it("names another socket in tmux's standard directory with -L, finding /tmp's real path", () => {
    expect(tmuxServerArgs({ TMUX: `${join(realpathSync("/tmp"), "tmux-501")}/person,123,0` }, 501)).toEqual(["-L", "person"]);
    expect(tmuxServerArgs({ TMUX: "/tmp/tmux-501/person,123,0" }, 501)).toEqual(["-L", "person"]);
  });

  it("names a socket by its path when TMUX_TMPDIR moved it, because -L resolves in the attaching terminal", () => {
    expect(tmuxServerArgs({ TMUX: `${base}/tmux-501/person,123,0`, TMUX_TMPDIR: base }, 501)).toEqual(["-S", `${base}/tmux-501/person`]);
    expect(tmuxServerArgs({ TMUX: `${base}/tmux-501/default,123,0`, TMUX_TMPDIR: base }, 501)).toEqual(["-S", `${base}/tmux-501/default`]);
  });

  it("names a socket anywhere else, or another user's, with -S", () => {
    expect(tmuxServerArgs({ TMUX: "/srv/sockets/team,9,1" }, 501)).toEqual(["-S", "/srv/sockets/team"]);
    expect(tmuxServerArgs({ TMUX: "/srv/sockets/team ,9,1" }, 501)).toEqual(["-S", "/srv/sockets/team "]);
    expect(tmuxServerArgs({ TMUX: "/srv/sockets/team,shared,9,1" }, 501)).toEqual(["-S", "/srv/sockets/team,shared"]);
    expect(tmuxServerArgs({ TMUX: "/tmp/tmux-501/person,123,0" }, 502)).toEqual(["-S", "/tmp/tmux-501/person"]);
  });

  it("keeps the attach command unchanged on the default server, and adds the server otherwise", () => {
    expect(tmuxAttachCommand("dev-build@starter")).toBe("tmux attach -t dev-build@starter");
    setDaemonTmuxServer(["-L", "person"]);
    expect(tmuxAttachCommand("dev-build@starter")).toBe("tmux -L person attach -t dev-build@starter");
    setDaemonTmuxServer(["-S", "/tmp/my sockets/team"]);
    expect(tmuxAttachCommand("dev-build@starter")).toBe("tmux -S '/tmp/my sockets/team' attach -t dev-build@starter");
  });

  it("quotes a session name that would otherwise reach the shell as code", () => {
    // An ordinary seat name keeps its exact form: shellWord only quotes what needs it.
    expect(tmuxAttachCommand("dev-build@starter")).toBe("tmux attach -t dev-build@starter");
    // Everything else reaches a shell as one word. The CMUX helper types this line into a
    // fresh terminal, and an adopted session's name comes from outside OpenRig.
    expect(tmuxAttachCommand("a;rm -rf /")).toBe("tmux attach -t 'a;rm -rf /'");
    expect(tmuxAttachCommand("$(id)")).toBe("tmux attach -t '$(id)'");
    expect(tmuxAttachCommand("it's")).toBe("tmux attach -t 'it'\"'\"'s'");
    // The server flags and the session are quoted independently: neither can borrow the
    // other's quoting.
    setDaemonTmuxServer(["-L", "person"]);
    expect(tmuxAttachCommand("a;b")).toBe("tmux -L person attach -t 'a;b'");
  });

  it("escapes a trailing semicolon for tmux's own parser, before the shell sees the word", () => {
    const bs = "\\"; // one backslash
    // One backslash is added in front of a final separator, once, for the raw name as written.
    expect(tmuxAttachCommand("report;")).toBe(`tmux attach -t 'report${bs};'`);
    expect(tmuxAttachCommand(`report${bs};`)).toBe(`tmux attach -t 'report${bs}${bs};'`);
    expect(tmuxAttachCommand(`report${bs}${bs};`)).toBe(`tmux attach -t 'report${bs}${bs}${bs};'`);
    // The three names stay different all the way to tmux, which is the property that matters.
    expect(new Set([
      tmuxAttachCommand("report;"),
      tmuxAttachCommand(`report${bs};`),
      tmuxAttachCommand(`report${bs}${bs};`),
    ]).size).toBe(3);
    // A separator that is not final is not touched, and ordinary names keep their bytes.
    expect(tmuxAttachCommand("a;b")).toBe("tmux attach -t 'a;b'");
    expect(tmuxAttachCommand("dev-build@starter")).toBe("tmux attach -t dev-build@starter");
  });

  it("encodes tmux's target markers so the session name survives, and quotes any = for the shell", () => {
    // `=` is tmux's exact-match marker and the rest of the word is the name it looks up, so a
    // session named `=ls` needs `==ls`: sent as `=ls`, tmux looks for `ls`.
    expect(tmuxAttachCommand("=ls")).toBe("tmux attach -t '==ls'");
    expect(tmuxAttachCommand("ls")).toBe("tmux attach -t ls");
    expect(tmuxAttachCommand("==ls")).toBe("tmux attach -t '===ls'");
    // `@` and `%` open a window or pane target, which a session target cannot resolve.
    expect(tmuxAttachCommand("@work")).toBe("tmux attach -t '=@work'");
    expect(tmuxAttachCommand("%work")).toBe("tmux attach -t '=%work'");
    // `~` and `{marked}` are tmux's marked-target words.
    expect(tmuxAttachCommand("~")).toBe("tmux attach -t '=~'");
    expect(tmuxAttachCommand("{marked}")).toBe("tmux attach -t '={marked}'");
    // zsh expands `=name` to a command path, and with MAGIC_EQUAL_SUBST it can expand one inside a
    // `name=value` word, so a `=` anywhere in a session word is quoted. A shell passes it through.
    expect(tmuxAttachCommand("a=b@rig")).toBe("tmux attach -t 'a=b@rig'");
    expect(tmuxAttachCommand("work==ls")).toBe("tmux attach -t 'work==ls'");
    // Known limit, pinned so it cannot drift into looking fixed: tmux reads a leading `$` as a
    // session id before the exact-match flag, so this name is not addressable through `-t` at all.
    expect(tmuxAttachCommand("$1")).toBe("tmux attach -t '$1'");
  });

  it("puts the server into local panes, never into an ssh pane", () => {
    const local: ViewMemberInput = { seat: "dev-review@starter", label: "reviewer", tmuxSession: "dev-review@starter", host: null, readOnly: false, alive: true };
    const remote: ViewMemberInput = { seat: "dev-build@starter", label: "builder", tmuxSession: "dev-build@starter", host: "box", readOnly: false, alive: true };
    const resolveHost = () => ({ id: "box", transport: "ssh" as const, target: "box.example" });
    const plain = composeView("v", [local, remote], { resolveHost });
    expect(plain.opened.map((p) => p.recoveryCommand)).toEqual([
      "tmux attach -t 'dev-review@starter'",
      "ssh -t 'box.example' 'tmux attach -t '\"'\"'dev-build@starter'\"'\"''",
    ]);
    const onServer = composeView("v", [local, remote], { resolveHost, localTmux: "/usr/bin/tmux", localTmuxServer: ["-L", "person"] });
    expect(onServer.opened.map((p) => p.recoveryCommand)).toEqual([
      "'/usr/bin/tmux' -L 'person' attach -t 'dev-review@starter'",
      plain.opened[1]!.recoveryCommand,
    ]);
  });
});
// tmux's own parser decides which session `attach -t` reaches, so the encodings above get one
// native check wherever tmux is installed. The suite runs on a private server (`-L`), so it never
// touches the operator's sessions, and it skips on a machine without tmux.
const nativeTmux = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!nativeTmux)("tmux's own target parsing (native)", () => {
  const socket = `openrig-target-${process.pid}`;
  const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
  const names = () =>
    tmux("list-sessions", "-F", "#{session_name}")
      .split("\n")
      .filter(Boolean)
      .sort();

  afterAll(() => {
    try {
      tmux("kill-server");
    } catch {
      // the private server was already gone
    }
  });

  it("==ls reaches the session named =ls while =ls reaches the session named ls", () => {
    tmux("new-session", "-d", "-s", "ls");
    tmux("new-session", "-d", "-s", "=ls");
    expect(names()).toEqual(["=ls", "ls"]);
    // `rename-session -t` takes a session target, so the name that changes says which session was
    // found. `=ls` is the exact-match marker plus `ls`; `==ls` is the marker plus `=ls`.
    tmux("rename-session", "-t", "=ls", "renamed-a");
    expect(names()).toEqual(["=ls", "renamed-a"]);
    tmux("rename-session", "-t", "==ls", "renamed-b");
    expect(names()).toEqual(["renamed-a", "renamed-b"]);
  });

  it("=@work reaches the session named @work, where @work alone is a window target", () => {
    tmux("new-session", "-d", "-s", "@work");
    expect(names()).toContain("@work");
    tmux("rename-session", "-t", "=@work", "renamed-at");
    expect(names()).toContain("renamed-at");
    expect(names()).not.toContain("@work");
  });
});