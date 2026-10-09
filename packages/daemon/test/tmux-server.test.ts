// A daemon started from inside tmux on a non-default socket creates its sessions on that server,
// and a person's new terminal reaches the default one. Every printed attach command must name the
// daemon's server then, and keep today's form on the default server.
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("names no server outside tmux, or on the default server", () => {
    expect(tmuxServerArgs({}, 501)).toEqual([]);
    expect(tmuxServerArgs({ TMUX: "" }, 501)).toEqual([]);
    expect(tmuxServerArgs({ TMUX: `${base}/tmux-501/default,123,0`, TMUX_TMPDIR: base }, 501)).toEqual([]);
  });

  it("names a socket in tmux's own directory with -L", () => {
    expect(tmuxServerArgs({ TMUX: `${base}/tmux-501/person,123,0`, TMUX_TMPDIR: base }, 501)).toEqual(["-L", "person"]);
  });

  it("names a socket anywhere else, or another user's, with -S", () => {
    expect(tmuxServerArgs({ TMUX: "/srv/sockets/team,9,1", TMUX_TMPDIR: base }, 501)).toEqual(["-S", "/srv/sockets/team"]);
    expect(tmuxServerArgs({ TMUX: `${base}/tmux-501/person,123,0`, TMUX_TMPDIR: base }, 502)).toEqual(["-S", `${base}/tmux-501/person`]);
  });

  it("finds tmux's directory under /tmp when TMUX_TMPDIR is unset", () => {
    const dir = join(realpathSync("/tmp"), "tmux-501");
    expect(tmuxServerArgs({ TMUX: `${dir}/person,123,0` }, 501)).toEqual(["-L", "person"]);
    expect(tmuxServerArgs({ TMUX: `${dir}/default,123,0` }, 501)).toEqual([]);
  });

  it("keeps the attach command unchanged on the default server, and adds the server otherwise", () => {
    expect(tmuxAttachCommand("dev-build@starter")).toBe("tmux attach -t dev-build@starter");
    setDaemonTmuxServer(["-L", "person"]);
    expect(tmuxAttachCommand("dev-build@starter")).toBe("tmux -L person attach -t dev-build@starter");
    setDaemonTmuxServer(["-S", "/tmp/my sockets/team"]);
    expect(tmuxAttachCommand("dev-build@starter")).toBe("tmux -S '/tmp/my sockets/team' attach -t dev-build@starter");
  });

  it("puts the server into local panes, never into an ssh pane", () => {
    const local: ViewMemberInput = { seat: "dev-review@starter", label: "reviewer", tmuxSession: "dev-review@starter", host: null, readOnly: false, alive: true };
    const remote: ViewMemberInput = { seat: "dev-build@starter", label: "builder", tmuxSession: "dev-build@starter", host: "box", readOnly: false, alive: true };
    const resolveHost = () => ({ id: "box", transport: "ssh" as const, target: "box.example" });
    const plain = composeView("v", [local, remote], { resolveHost });
    expect(plain.opened.map((p) => p.paneCommand)).toEqual([
      "tmux attach -t 'dev-review@starter'",
      "ssh 'box.example' 'tmux attach -t '\"'\"'dev-build@starter'\"'\"''",
    ]);
    const onServer = composeView("v", [local, remote], { resolveHost, localTmux: "/usr/bin/tmux", localTmuxServer: ["-L", "person"] });
    expect(onServer.opened.map((p) => p.paneCommand)).toEqual([
      "'/usr/bin/tmux' -L 'person' attach -t 'dev-review@starter'",
      plain.opened[1]!.paneCommand,
    ]);
  });
});
