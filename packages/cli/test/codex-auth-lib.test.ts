// OPR.0.4.1.29 — rig auth secret-safe core (CLI-local, daemon-free). Foundational primitives:
// fail-closed profile-name whitelist + CODEX_HOME path resolution (default $HOME/.codex, overridable).
import { describe, it, expect } from "vitest";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { validateProfileName, resolveCodexHome } from "../src/lib/codex-auth.js";

describe("validateProfileName (OPR.0.4.1.29 — fail-closed whitelist)", () => {
  it("accepts alnum-led names with . _ - (<=64 chars)", () => {
    for (const ok of ["work", "team-a", "acct.1", "A_b-2", "x", "a".repeat(64)]) {
      expect(validateProfileName(ok)).toBe(true);
    }
  });

  it("rejects traversal, separators, dotfiles, tilde, whitespace, control, shell-meta, empty, >64", () => {
    for (const bad of [
      "", ".", "..", "../x", "a/b", "a\\b", "~x", ".hidden", "-lead", "a b", "a\tb", "a\nb",
      "a;b", "a$b", "a`b", "a|b", "a\0b", "a".repeat(65),
    ]) {
      expect(validateProfileName(bad)).toBe(false);
    }
  });
});

describe("resolveCodexHome (OPR.0.4.1.29 — default $HOME/.codex, env-overridable)", () => {
  it("uses CODEX_HOME when set, deriving the secret-adjacent paths under it", () => {
    const p = resolveCodexHome({ CODEX_HOME: "/fix/codex" });
    expect(p.codexHome).toBe("/fix/codex");
    expect(p.profileDir).toBe("/fix/codex/auth-profiles");
    expect(p.activeAuth).toBe("/fix/codex/auth.json");
    expect(p.registryPath).toBe("/fix/codex/auth-seat-registry.tsv");
  });

  it("defaults to $HOME/.codex when CODEX_HOME is unset/empty (no personal path baked in)", () => {
    expect(resolveCodexHome({ HOME: "/home/u" }).codexHome).toBe("/home/u/.codex");
    expect(resolveCodexHome({ HOME: "/home/u", CODEX_HOME: "" }).codexHome).toBe("/home/u/.codex");
  });

  it("falls back to the user's home when HOME is unset or empty (never a cwd-relative .codex)", () => {
    expect(resolveCodexHome({}).codexHome).toBe(join(userInfo().homedir, ".codex"));
    expect(resolveCodexHome({ HOME: "" }).codexHome).toBe(join(userInfo().homedir, ".codex"));
    expect(resolveCodexHome({ HOME: "", CODEX_HOME: "" }).codexHome).toBe(join(userInfo().homedir, ".codex"));
    expect(isAbsolute(resolveCodexHome({ HOME: "" }).codexHome)).toBe(true);
  });
});
