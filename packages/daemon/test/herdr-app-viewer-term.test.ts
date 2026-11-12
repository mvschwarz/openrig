import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewerArgv } from "../src/domain/terminal/herdr-app-provider.js";

// The viewer wrapper runs under sh in a herdr-core pane, whose TERM may be `dumb` (no `clear`, so tmux refuses to
// attach). Run the real wrapper with a probe in place of the attach, and check the TERM the attach gets.
describe("herdr-app viewer: the attach gets a TERM that can clear the screen", () => {
  let stubs: string;
  beforeAll(() => {
    // The wrapper ends with `exec tail -f /dev/null` (a cell never ends on its own); this `tail` returns at once.
    stubs = mkdtempSync(join(tmpdir(), "viewer-term-"));
    writeFileSync(join(stubs, "tail"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(stubs, "tail"), 0o755);
  });
  afterAll(() => rmSync(stubs, { recursive: true, force: true }));

  const attachTerm = (env: Record<string, string>): string | undefined => {
    const argv = viewerArgv({ paneCommand: 'printf "attach-term=[%s]\\n" "$TERM"' }, "n1");
    const run = spawnSync(argv[0]!, argv.slice(1), { env, encoding: "utf8", timeout: 10_000 });
    return /attach-term=\[(.*)\]/.exec(run.stdout)?.[1];
  };
  const withInfocmp = () => `${stubs}:/usr/bin:/bin`;
  const canClear = (term: string) => (spawnSync("infocmp", [term], { encoding: "utf8" }).stdout ?? "").includes("clear=");

  it("replaces TERM=dumb (a terminfo without clear)", () => {
    expect(attachTerm({ PATH: withInfocmp(), TERM: "dumb" })).toBe("xterm-256color");
  });

  it("sets one when TERM is unset or empty", () => {
    expect(attachTerm({ PATH: withInfocmp() })).toBe("xterm-256color");
    expect(attachTerm({ PATH: withInfocmp(), TERM: "" })).toBe("xterm-256color");
  });

  // Skipped where this host has no terminfo for it (macOS's ncurses has no tmux-256color): the guard is right to replace it there.
  for (const term of ["xterm-256color", "screen-256color", "tmux-256color"]) {
    it.skipIf(!canClear(term))(`keeps a TERM that can clear: ${term}`, () => {
      expect(attachTerm({ PATH: withInfocmp(), TERM: term })).toBe(term);
    });
  }

  it("replaces a TERM with no terminfo on this host", () => {
    expect(attachTerm({ PATH: withInfocmp(), TERM: "nonexistent-term-xyz" })).toBe("xterm-256color");
  });

  it("without infocmp, can't check, so uses xterm-256color", () => {
    expect(attachTerm({ PATH: stubs, TERM: "dumb" })).toBe("xterm-256color");
    expect(attachTerm({ PATH: stubs, TERM: "screen-256color" })).toBe("xterm-256color");
  });
});
