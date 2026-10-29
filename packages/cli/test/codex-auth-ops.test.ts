// OPR.0.4.1.29 — rig auth secret ops (status / validate), fixture CODEX_HOME, secret-safe results.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveCodexHome, authStatus, authValidate } from "../src/lib/codex-auth.js";
import { createPrivateTextFile } from "../../../daemon/src/domain/private-text-file.js";
import { expectPrivateFile } from "./helpers/private-file.js";

const SENTINEL = "SENTINEL_TOKEN_MUST_NEVER_APPEAR_sk-abc123";
let home: string;
let paths: ReturnType<typeof resolveCodexHome>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-"));
  paths = resolveCodexHome({ CODEX_HOME: home });
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function writeAuth(content: string, mode = 0o600) {
  writeFixture(paths.activeAuth, content, mode);
}

function writeFixture(file: string, content: string, mode = 0o600) {
  if (process.platform !== "win32") {
    fs.writeFileSync(file, content, { mode });
    fs.chmodSync(file, mode);
    return;
  }
  createPrivateTextFile(file, content);
  expectPrivateFile(file);
  if (mode === 0o600) return;
  // Deliberately unsafe synthetic file: test a real extra read grant, not chmod bits.
  const script = `$ErrorActionPreference='Stop'
$p='${file.replace(/'/g, "''")}'
$acl=Get-Acl -LiteralPath $p
$everyone=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone,'Read','Allow'))
Set-Acl -LiteralPath $p -AclObject $acl`;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: "pipe" });
}

describe("authStatus (OPR.0.4.1.29 — presence/mode/login-state, NEVER secrets)", () => {
  it("reports presence + mode + safe + login-state (exit-code-only) and leaks no token", () => {
    writeAuth(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: SENTINEL, tokens: { access: SENTINEL } }));
    const r = authStatus(paths, { loginStatus: () => "logged_in" });
    expect(r.activeAuthPresent).toBe(true);
    expect(r.activeAuthMode).toBe("600");
    expect(r.activeAuthModeSafe).toBe(true);
    expect(r.loginStatus).toBe("logged_in");
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it("flags an unsafe (world-readable) active-auth mode without reading contents", () => {
    writeAuth(JSON.stringify({ OPENAI_API_KEY: SENTINEL }), 0o644);
    const r = authStatus(paths, { loginStatus: () => "unavailable" });
    expect(r.activeAuthMode).toBe(process.platform === "win32" ? "unsafe" : "644");
    expect(r.activeAuthModeSafe).toBe(false);
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });
});

describe("authValidate (OPR.0.4.1.29 — mode + parseability, never echo contents)", () => {
  function writeProfile(name: string, content: string, mode = 0o600) {
    fs.mkdirSync(paths.profileDir, { recursive: true });
    fs.chmodSync(paths.profileDir, 0o700);
    const p = path.join(paths.profileDir, `${name}.json`);
    writeFixture(p, content, mode);
    return p;
  }

  it("passes a 0600 parseable profile and reports only name/path/mode", () => {
    writeProfile("work", JSON.stringify({ OPENAI_API_KEY: SENTINEL }));
    const r = authValidate(paths, "work");
    expect(r).toMatchObject({ ok: true, name: "work", mode: "600" });
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it("rejects an invalid profile name fail-closed", () => {
    expect(authValidate(paths, "../etc")).toEqual({ ok: false, reason: "invalid_profile" });
  });

  it("reports missing_profile when absent", () => {
    expect(authValidate(paths, "nope")).toEqual({ ok: false, reason: "missing_profile" });
  });

  it("reports malformed_json WITHOUT echoing the file content in the result or any error", () => {
    // Malformed JSON whose bytes include the sentinel — a JSON.parse error message could echo it.
    writeProfile("bad", `{ bad json ${SENTINEL}`);
    const r = authValidate(paths, "bad");
    expect(r).toEqual({ ok: false, reason: "malformed_json" });
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });
});
