// The daemon reader must land on the same folder the CLI resolves: the account
// home from os.userInfo(), not process.env.HOME. os.homedir() is mocked to a
// different sentinel so the reader can only pass by sourcing userInfo(); the
// fixture is a real controlled account home with a profile the reader discovers.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ctl = vi.hoisted(() => ({ account: "", homedirSentinel: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const userInfo = () => ({ ...actual.userInfo(), homedir: ctl.account });
  const homedir = () => ctl.homedirSentinel;
  return { ...actual, userInfo, homedir, default: { ...actual, userInfo, homedir } };
});

const { readCodexAuthMetadata } = await import("../src/domain/provider/codex-auth-reader.js");

describe("readCodexAuthMetadata — falsy HOME resolves under the account home (parity with the CLI)", () => {
  let savedHome: string | undefined;
  let savedCodexHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedCodexHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    ctl.account = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-acct-home-"));
    ctl.homedirSentinel = fs.mkdtempSync(path.join(os.tmpdir(), "homedir-sentinel-"));
    // A profile only the account-home .codex can see: a fallback that lands in the
    // cwd (empty HOME) or under the homedir() sentinel finds nothing.
    const profilesDir = path.join(ctl.account, ".codex", "auth-profiles");
    fs.mkdirSync(profilesDir, { recursive: true });
    fs.writeFileSync(path.join(profilesDir, "alpha.json"), "{}");
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedCodexHome;
    fs.rmSync(ctl.account, { recursive: true, force: true });
    fs.rmSync(ctl.homedirSentinel, { recursive: true, force: true });
  });

  it("HOME unset in the process environment reads the account home's .codex", () => {
    delete process.env.HOME;
    const meta = readCodexAuthMetadata(process.env);
    expect(meta.profiles).toEqual(["alpha"]);
    expect(meta.profilesRead.status).toBe("read");
  });

  it("HOME empty in the process environment still reads the account home's .codex", () => {
    process.env.HOME = "";
    const meta = readCodexAuthMetadata({ HOME: "" } as NodeJS.ProcessEnv);
    expect(meta.profiles).toEqual(["alpha"]);
    expect(meta.profilesRead.status).toBe("read");
  });

  it("an explicit CODEX_HOME keeps pointing at its own folder with HOME empty", () => {
    process.env.HOME = "";
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    fs.mkdirSync(path.join(other, "auth-profiles"), { recursive: true });
    fs.writeFileSync(path.join(other, "auth-profiles", "explicit.json"), "{}");
    try {
      const meta = readCodexAuthMetadata({ HOME: "", CODEX_HOME: other } as NodeJS.ProcessEnv);
      expect(meta.profiles).toEqual(["explicit"]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
