import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { accountRefProblem, ProviderAccountRefsRepository, readAccountRefInput } from "../src/domain/provider/provider-account-refs.js";

// #3625 slice 1: the daemon's accounts by label, each a reference local to this host. Adding checks the reference by
// looking at the file or the saved login's name; a refusal stores nothing, and no file's contents reach any answer.

// Synthetic file contents, not a credential. Every answer is checked for it.
const CONTENT = "synthetic-content-never-echoed";

let dir: string;
let db: Database.Database;
let repo: ProviderAccountRefsRepository;

function file(name: string, mode: number, content = CONTENT): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, { mode });
  fs.chmodSync(p, mode);
  return p;
}

function codexHome(logins: string[]): string {
  const home = path.join(dir, "codex-home");
  fs.mkdirSync(path.join(home, "auth-profiles"), { recursive: true, mode: 0o700 });
  for (const login of logins) fs.writeFileSync(path.join(home, "auth-profiles", `${login}.json`), CONTENT, { mode: 0o600 });
  return home;
}

const rows = () => db.prepare("SELECT COUNT(*) AS n FROM provider_account_refs").get() as { n: number };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-refs-"));
  db = createFullTestDb();
  repo = new ProviderAccountRefsRepository(db, { now: () => "2026-11-20T21:00:00.000Z" });
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("provider account references", () => {
  it("adds, lists by provider and label, and removes each kind, keeping only the reference", () => {
    const token = file("token", 0o600);
    const key = file("key", 0o400);
    const home = codexHome(["work"]);
    expect(repo.add({ provider: "claude", label: "max-1", tokenFile: token })).toEqual({ ok: true, account: {
      provider: "claude", label: "max-1", kind: "claude_token_file", file: token, codexHome: null, login: null, createdAt: "2026-11-20T21:00:00.000Z" } });
    expect(repo.add({ provider: "claude", label: "api", apiKeyFile: key }).ok).toBe(true);
    expect(repo.add({ provider: "codex", label: "max-1", codexHome: home, login: "work" })).toMatchObject({ ok: true, account: {
      provider: "codex", label: "max-1", kind: "codex_saved_login", file: null, codexHome: home, login: "work" } });

    expect(repo.list().map((a) => `${a.provider}/${a.label}/${a.kind}`)).toEqual([
      "claude/api/claude_api_key_file", "claude/max-1/claude_token_file", "codex/max-1/codex_saved_login"]);
    expect(repo.list("codex").map((a) => a.label)).toEqual(["max-1"]);

    expect(repo.remove("claude", "max-1")).toMatchObject({ ok: true, account: { label: "max-1", provider: "claude" } });
    expect(repo.list().map((a) => `${a.provider}/${a.label}`)).toEqual(["claude/api", "codex/max-1"]);
    // The file is untouched: removing a label never deletes or changes what it pointed at.
    expect(fs.readFileSync(token, "utf8")).toBe(CONTENT);
    expect(JSON.stringify(db.prepare("SELECT * FROM provider_account_refs").all())).not.toContain(CONTENT);
  });

  it("refuses an unusable reference with the reason and stores nothing", () => {
    const home = codexHome(["work", "open"]);
    fs.chmodSync(path.join(home, "auth-profiles", "open.json"), 0o644);
    const refusals = [
      repo.add({ provider: "claude", label: "open", tokenFile: file("open", 0o644) }),
      repo.add({ provider: "claude", label: "open-key", apiKeyFile: file("open-key", 0o644) }),
      repo.add({ provider: "claude", label: "missing", tokenFile: path.join(dir, "missing") }),
      repo.add({ provider: "claude", label: "empty", tokenFile: file("empty", 0o600, "") }),
      repo.add({ provider: "claude", label: "dir", tokenFile: dir }),
      repo.add({ provider: "codex", label: "gone", codexHome: home, login: "personal" }),
      repo.add({ provider: "codex", label: "nohome", codexHome: path.join(dir, "nohome"), login: "work" }),
      repo.add({ provider: "codex", label: "open-login", codexHome: home, login: "open" }),
    ];
    expect(refusals.map((r) => r.ok ? "ok" : r.code)).toEqual(Array(8).fill("reference_unusable"));
    const messages = refusals.map((r) => r.ok ? "" : r.message);
    expect(messages[0]).toMatch(/must be private \(0600 or 0400\), and it is 0644\. Nothing was stored\.$/);
    expect(messages[1]).toContain("the API-key file must be private (0600 or 0400)");
    expect(messages[2]).toContain("doesn't exist");
    expect(messages[3]).toContain("is empty");
    expect(messages[4]).toContain("isn't a regular file");
    expect(messages[5]).toContain(`no login named personal is saved in ${home} (rig auth list --codex-home ${home} lists them)`);
    expect(messages[6]).toContain("doesn't exist");
    // The switch only copies a 0600 saved login (rig auth switch), so a looser one is refused here too.
    expect(messages[7]).toContain(`the saved login ${path.join(home, "auth-profiles", "open.json")} must be private (0600), and it is 0644`);
    expect(rows().n).toBe(0);
    expect(JSON.stringify(refusals)).not.toContain(CONTENT);
  });

  it("follows a symlinked Claude file to a private regular file, as the launch does; a symlinked Codex login isn't one", () => {
    const target = file("real-token", 0o600);
    const link = path.join(dir, "token-link");
    fs.symlinkSync(target, link);
    expect(repo.add({ provider: "claude", label: "linked", tokenFile: link })).toMatchObject({ ok: true, account: { file: link } });
    const keyLink = path.join(dir, "key-link");
    fs.symlinkSync(file("real-key", 0o400), keyLink);
    expect(repo.add({ provider: "claude", label: "linked-key", apiKeyFile: keyLink }).ok).toBe(true);

    // rig auth list and rig auth switch never follow a symlinked saved login, so it isn't one here either.
    const home = codexHome([]);
    fs.symlinkSync(file("elsewhere.json", 0o600), path.join(home, "auth-profiles", "linked.json"));
    expect(repo.add({ provider: "codex", label: "linked", codexHome: home, login: "linked" })).toMatchObject({
      ok: false, code: "reference_unusable", message: expect.stringContaining("no login named linked is saved in") });
  });

  it("refuses a malformed label, path or login name before looking at the filesystem", () => {
    const token = file("token", 0o600);
    const results = [
      repo.add({ provider: "claude", label: "-dash", tokenFile: token }),
      repo.add({ provider: "claude", label: "rel", tokenFile: "relative/token" }),
      repo.add({ provider: "codex", label: "rel", codexHome: "relative", login: "work" }),
      repo.add({ provider: "codex", label: "bad", codexHome: dir, login: "../escape" }),
    ];
    expect(results.map((r) => r.ok ? "ok" : r.code)).toEqual(Array(4).fill("invalid_reference"));
    expect(rows().n).toBe(0);
  });

  it("refuses a duplicate label for the same provider, and keeps the first", () => {
    const first = file("first", 0o600);
    expect(repo.add({ provider: "claude", label: "max-1", tokenFile: first }).ok).toBe(true);
    const again = repo.add({ provider: "claude", label: "max-1", tokenFile: file("second", 0o600) });
    expect(again).toMatchObject({ ok: false, code: "duplicate_label" });
    expect(repo.list()).toHaveLength(1);
    expect(repo.get("claude", "max-1")?.file).toBe(first);
  });

  it("won't remove a label something uses, and says what; an unknown label is not found", () => {
    const used = new ProviderAccountRefsRepository(db, { uses: (p, l) => (p === "claude" && l === "max-1" ? ["rig fleet (claude)"] : []) });
    expect(used.add({ provider: "claude", label: "max-1", tokenFile: file("token", 0o600) }).ok).toBe(true);
    expect(used.remove("claude", "max-1")).toEqual({ ok: false, code: "in_use", usedBy: ["rig fleet (claude)"],
      message: "max-1 is assigned to rig fleet (claude); change those assignments first. Nothing changed." });
    expect(used.list()).toHaveLength(1);
    expect(used.remove("codex", "max-1")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("the table holds one kind per provider, with only that kind's reference", () => {
    const insert = db.prepare("INSERT INTO provider_account_refs (provider, label, kind, file_path, codex_home, login_name, created_at) VALUES (?, ?, ?, ?, ?, ?, 'now')");
    expect(() => insert.run("codex", "x", "claude_token_file", "/f", null, null)).toThrow(/CHECK/);
    expect(() => insert.run("claude", "x", "claude_token_file", null, "/h", "work")).toThrow(/CHECK/);
    expect(() => insert.run("codex", "x", "codex_saved_login", "/f", "/h", "work")).toThrow(/CHECK/);
  });
});

describe("reading an add request", () => {
  it("takes one Claude file, or a Codex home and login, and says what's wrong otherwise", () => {
    expect(readAccountRefInput({ provider: "claude", label: "a", tokenFile: "/t" })).toEqual({ provider: "claude", label: "a", tokenFile: "/t" });
    expect(readAccountRefInput({ provider: "claude", label: "a", apiKeyFile: "/k" })).toEqual({ provider: "claude", label: "a", apiKeyFile: "/k" });
    expect(readAccountRefInput({ provider: "codex", label: "a", codexHome: "/h", login: "w" })).toEqual({ provider: "codex", label: "a", codexHome: "/h", login: "w" });
    for (const body of [
      { provider: "pi", label: "a", tokenFile: "/t" },
      { provider: "claude", tokenFile: "/t" },
      { provider: "claude", label: "a" },
      { provider: "claude", label: "a", tokenFile: "/t", apiKeyFile: "/k" },
      { provider: "claude", label: "a", tokenFile: "/t", login: "w" },
      { provider: "codex", label: "a", codexHome: "/h" },
      { provider: "codex", label: "a", codexHome: "/h", login: "w", tokenFile: "/t" },
      { provider: "claude", label: "a", tokenFile: 7 },
    ]) expect(readAccountRefInput(body)).toHaveProperty("problem");
  });

  it("a usable reference has no problem", () => {
    expect(accountRefProblem({ provider: "claude", label: "a", tokenFile: file("t", 0o400) })).toBeNull();
    expect(accountRefProblem({ provider: "codex", label: "a", codexHome: codexHome(["w"]), login: "w" })).toBeNull();
  });
});
