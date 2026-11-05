import { describe, expect, it } from "vitest";
import { userInfo } from "node:os";
import { blankShellArgv, resolveLoginShell } from "../src/domain/terminal/login-shell.js";

const all = () => true;

describe("filler panes run the account's login shell", () => {
  it("prefers the account's configured shell over an inherited $SHELL", () => {
    expect(resolveLoginShell(() => "/opt/homebrew/bin/fish", { SHELL: "/bin/zsh" }, all)).toBe("/opt/homebrew/bin/fish");
  });

  it("falls back to $SHELL when the account lookup throws, is empty, relative or not executable", () => {
    for (const account of [() => { throw new Error("no passwd entry"); }, () => "", () => null, () => "fish", () => "/missing/fish"]) {
      expect(resolveLoginShell(account, { SHELL: "/bin/zsh" }, (file) => file === "/bin/zsh")).toBe("/bin/zsh");
    }
  });

  it("ends at /bin/sh when neither source is usable", () => {
    expect(resolveLoginShell(() => undefined, {}, all)).toBe("/bin/sh");
    expect(resolveLoginShell(() => "/missing/fish", { SHELL: "zsh" }, () => false)).toBe("/bin/sh");
  });

  it("launches the shell this host's account record names, as a login shell", () => {
    const argv = blankShellArgv();
    expect(argv[1]).toBe("-l");
    const account = userInfo().shell;
    if (account) expect(argv[0]).toBe(account);
  });
});
