import { afterEach, describe, expect, it, vi } from "vitest";
import { userInfo } from "node:os";
import path from "node:path";
import { resolveCodexHome } from "../src/lib/codex-auth.js";

// The mocked OS-account branch tests live beside the canonical daemon source.
// This boundary checks the CLI's real re-export without reading any auth file.
afterEach(() => vi.unstubAllEnvs());
describe("resolveCodexHome — falsy HOME falls back to the account home (userInfo), never the cwd", () => {
  it("HOME unset in the process environment resolves under the account home", () => {
    vi.stubEnv("HOME", undefined);
    vi.stubEnv("CODEX_HOME", undefined);
    expect(resolveCodexHome().codexHome).toBe(path.join(userInfo().homedir, ".codex"));
    expect(path.isAbsolute(resolveCodexHome().codexHome)).toBe(true);
  });
  it("HOME empty in the process environment resolves under the account home, not the cwd", () => {
    vi.stubEnv("HOME", "");
    vi.stubEnv("CODEX_HOME", undefined);
    expect(resolveCodexHome().codexHome).toBe(path.join(userInfo().homedir, ".codex"));
    expect(resolveCodexHome().codexHome).not.toBe(path.join(process.cwd(), ".codex"));
  });
  it("HOME empty passed as the env map takes the same account-home path", () => {
    const expected = path.join(userInfo().homedir, ".codex");
    expect(resolveCodexHome({ HOME: "" }).codexHome).toBe(expected);
    expect(resolveCodexHome({}).codexHome).toBe(expected);
  });
});
it("the CLI auth export retains explicit home selection", () => {
  expect(resolveCodexHome({ HOME: "synthetic-relative-home" }).codexHome).toBe(path.join("synthetic-relative-home", ".codex"));
  expect(resolveCodexHome({ HOME: "", CODEX_HOME: "synthetic-explicit-codex" }).codexHome).toBe("synthetic-explicit-codex");
});
