// The falsy-HOME fallback must come from the OS account database, not from the
// environment. Node's os.homedir() reads process.env.HOME on POSIX (including an
// empty string), so a test that only repeats homedir() in its expectation would
// accept a cwd-relative ".codex". Here os.userInfo() is mocked to a controlled
// account home and os.homedir() to a different sentinel value: the fallback can
// only pass if it sources userInfo(), on any platform.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

const ctl = vi.hoisted(() => ({ account: "", homedirSentinel: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const userInfo = () => ({ ...actual.userInfo(), homedir: ctl.account });
  const homedir = () => ctl.homedirSentinel;
  return { ...actual, userInfo, homedir, default: { ...actual, userInfo, homedir } };
});

const { resolveCodexHome } = await import("../src/lib/codex-auth.js");

describe("resolveCodexHome — falsy HOME falls back to the account home (userInfo), never the cwd", () => {
  let savedHome: string | undefined;
  let savedCodexHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    ctl.account = path.resolve("controlled-account-home");
    ctl.homedirSentinel = path.resolve("homedir-sentinel");
    expect(ctl.account).not.toBe(ctl.homedirSentinel);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
  });

  it("HOME unset in the process environment resolves under the account home", () => {
    delete process.env.HOME;
    const p = resolveCodexHome();
    expect(p.codexHome).toBe(path.join(ctl.account, ".codex"));
    expect(path.isAbsolute(p.codexHome)).toBe(true);
  });

  it("HOME empty in the process environment resolves under the account home, not the cwd", () => {
    process.env.HOME = "";
    const p = resolveCodexHome();
    expect(p.codexHome).toBe(path.join(ctl.account, ".codex"));
    expect(path.isAbsolute(p.codexHome)).toBe(true);
    expect(p.codexHome).not.toBe(path.join(ctl.homedirSentinel, ".codex"));
    expect(p.codexHome).not.toBe(path.join("", ".codex"));
  });

  it("HOME empty passed as the env map takes the same account-home path", () => {
    process.env.HOME = "";
    const p = resolveCodexHome({ HOME: "" });
    expect(p.codexHome).toBe(path.join(ctl.account, ".codex"));
  });

  it("an explicit HOME, relative or absolute, is used as given", () => {
    process.env.HOME = "";
    expect(resolveCodexHome({ HOME: "rel/home" }).codexHome).toBe(path.join("rel/home", ".codex"));
    expect(resolveCodexHome({ HOME: "/explicit/home" }).codexHome).toBe(path.join("/explicit/home", ".codex"));
  });

  it("an explicit CODEX_HOME wins unchanged, relative or absolute", () => {
    process.env.HOME = "";
    expect(resolveCodexHome({ CODEX_HOME: "rel/codex" }).codexHome).toBe("rel/codex");
    expect(resolveCodexHome({ CODEX_HOME: "/abs/codex" }).codexHome).toBe("/abs/codex");
    expect(resolveCodexHome({ HOME: "/explicit/home", CODEX_HOME: "" }).codexHome)
      .toBe(path.join("/explicit/home", ".codex"));
  });
});
