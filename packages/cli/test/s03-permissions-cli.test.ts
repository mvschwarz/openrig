import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyCommand } from "../src/commands/policy.js";
import { seatCommand } from "../src/commands/seat.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

afterEach(() => vi.restoreAllMocks());
async function capture(command: Command, args: string[]) {
  const logs: string[] = []; const errors: string[] = []; const saved = process.exitCode;
  const log = vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  const error = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
  process.exitCode = undefined;
  try { await new Command().addCommand(command).parseAsync(["node", "rig", ...args]); return { logs, errors, exit: process.exitCode }; }
  finally { log.mockRestore(); error.mockRestore(); process.exitCode = saved; }
}
describe("S03 policy permissions compatibility", () => {
  it.each(["list", "show", "current", "apply"])("%s alias retains exact JSON, exit and file effect", async verb => {
    const root = mkdtempSync(join(tmpdir(), "s03-policy-")); const file = join(root, "rig.yaml");
    const preimage = "# retained comment\nname: inert\npods: []\n";
    const args = [verb, ...(["show", "apply"].includes(verb) ? ["standard"] : []), "--spec", file, "--json"];
    writeFileSync(file, preimage); const old = await capture(policyCommand(), ["policy", ...args]); const oldBytes = readFileSync(file, "utf8");
    writeFileSync(file, preimage); const nested = await capture(policyCommand(), ["policy", "permissions", ...args]);
    expect(nested).toEqual(old); expect(readFileSync(file, "utf8")).toBe(oldBytes); expect(nested.exit).toBeUndefined();
    expect(nested.logs).toHaveLength(1); expect(() => JSON.parse(nested.logs[0]!)).not.toThrow();
  });
  it("preserves refusal exit/output for unsupported policy refs", async () => {
    const args = ["show", "builtin:missing", "--json"];
    const old = await capture(policyCommand(), ["policy", ...args]);
    expect(await capture(policyCommand(), ["policy", "permissions", ...args])).toEqual(old);
    expect(old.exit).toBe(1);
  });
  it("discovers future-launch semantics without borrowing the held work namespace", () => {
    const policy = policyCommand(); const permissions = policy.commands.find(c => c.name() === "permissions")!;
    expect(permissions.commands.map(c => c.name())).toEqual(["list", "show", "current", "apply"]);
    expect(policy.commands.some(c => c.name() === "work")).toBe(false);
    const select = seatCommand().commands.find(c => c.name() === "set-permissions")!;
    expect(select.description()).toContain("future managed launches");
    expect(select.options.map(o => o.long)).toEqual(["--mode", "--rules", "--auto-mode", "--clear-auto-mode", "--codex-permissions", "--codex-profile", "--reason", "--operator", "--json"]);
  });
  it("posts a Codex envelope from its JSON file, or a profile with time for its native check, one choice at a time", async () => {
    const posts: unknown[][] = [];
    const deps = { lifecycleDeps: {
      readFile: (p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "inert.sqlite", startedAt: "2026-09-27T00:00:00Z" }) : null,
      exists: (p: string) => p === STATE_FILE, isProcessAlive: () => true, fetch: async () => ({ ok: true }),
    }, clientFactory: () => ({ post: async (...a: unknown[]) => { posts.push(a); return { status: 200, data: { ok: true, changed: true, to: null, effect: "Future launches." } }; } }) };
    const file = join(mkdtempSync(join(tmpdir(), "codex-envelope-")), "envelope.json");
    const envelope = { sandbox: "read-only", approval: "on-request" };
    writeFileSync(file, JSON.stringify(envelope));
    await capture(seatCommand(deps as never), ["seat", "set-permissions", "impl@inert", "--codex-permissions", file, "--reason", "narrow"]);
    await capture(seatCommand(deps as never), ["seat", "set-permissions", "impl@inert", "--codex-profile", "lease", "--reason", "profile"]);
    expect(posts[0]).toEqual(["/api/seat/set-permissions/impl%40inert", { codexPermissions: envelope, reason: "narrow" }, { timeoutMs: 10_000 }]);
    expect(posts[1]).toEqual(["/api/seat/set-permissions/impl%40inert", { codexProfile: "lease", reason: "profile" }, { timeoutMs: 30_000 }]);
    const both = await capture(seatCommand(deps as never), ["seat", "set-permissions", "impl@inert", "--codex-profile", "lease", "--mode", "floor", "--reason", "x"]);
    expect(both.exit).toBe(1); expect(both.errors.join(" ")).toContain("Choose exactly one of");
    expect(posts).toHaveLength(2);
  });
  it("posts an auto mode block from its JSON file, null to clear it, and prints the daemon's warnings", async () => {
    const posts: unknown[][] = [];
    const advisories = ['claude_auto_mode.soft_deny: without "$defaults", this list replaces Claude\'s built-in soft_deny entries'];
    const deps = { lifecycleDeps: {
      readFile: (p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "inert.sqlite", startedAt: "2026-09-27T00:00:00Z" }) : null,
      exists: (p: string) => p === STATE_FILE, isProcessAlive: () => true, fetch: async () => ({ ok: true }),
    }, clientFactory: () => ({ post: async (...a: unknown[]) => { posts.push(a); return { status: 200, data: { ok: true, changed: true, advisories, effect: "Next launch." } }; } }) };
    const file = join(mkdtempSync(join(tmpdir(), "auto-mode-")), "auto-mode.json");
    const block = { soft_deny: ["Only this"] };
    writeFileSync(file, JSON.stringify(block));
    const set = await capture(seatCommand(deps as never), ["seat", "set-permissions", "impl@inert", "--auto-mode", file, "--reason", "team"]);
    expect(set.logs).toEqual(["Claude auto mode block recorded and audited.", `Warning: ${advisories[0]}`, "Next launch."]);
    const cleared = await capture(seatCommand(deps as never), ["seat", "set-permissions", "impl@inert", "--clear-auto-mode", "--reason", "back"]);
    expect(cleared.logs[0]).toBe("Claude auto mode block cleared and audited.");
    const nullFile = join(mkdtempSync(join(tmpdir(), "auto-mode-")), "null.json");
    writeFileSync(nullFile, "null");
    const clearedByFile = await capture(seatCommand(deps as never), ["seat", "set-permissions", "impl@inert", "--auto-mode", nullFile, "--reason", "file"]);
    expect(clearedByFile.logs[0]).toBe("Claude auto mode block cleared and audited.");
    expect(posts.map(p => p[1])).toEqual([{ autoMode: block, reason: "team" }, { autoMode: null, reason: "back" }, { autoMode: null, reason: "file" }]);
    const both = await capture(seatCommand(deps as never), ["seat", "set-permissions", "impl@inert", "--clear-auto-mode", "--auto-mode", file, "--reason", "x"]);
    expect(both.exit).toBe(1); expect(both.errors.join(" ")).toContain("Choose exactly one of");
    const unreadable = await capture(seatCommand(deps as never), ["seat", "set-permissions", "impl@inert", "--auto-mode", join(tmpdir(), "missing-auto-mode.json"), "--reason", "x"]);
    expect(unreadable.exit).toBe(1); expect(unreadable.errors.join(" ")).toContain("autoMode mapping");
    expect(posts).toHaveLength(3);
  });
  it("seat command posts one explicit selection and preserves refusal JSON/exit", async () => {
    const posts: unknown[] = []; const response = { ok: false, code: "permission_selection_refused", message: "native options unavailable" };
    const deps = { lifecycleDeps: {
      readFile: (p: string) => p === STATE_FILE ? JSON.stringify({ pid: 123, port: 7433, db: "inert.sqlite", startedAt: "2026-09-27T00:00:00Z" }) : null,
      exists: (p: string) => p === STATE_FILE, isProcessAlive: () => true, fetch: async () => ({ ok: true }),
    }, clientFactory: () => ({ post: async (...a: unknown[]) => { posts.push(a); return { status: 409, data: response }; } }) };
    const result = await capture(seatCommand(deps as never), ["seat", "set-permissions", "owner@inert", "--mode", "auto", "--reason", "user chose", "--json"]);
    expect(posts).toEqual([["/api/seat/set-permissions/owner%40inert", { mode: "auto", reason: "user chose" }, { timeoutMs: 10_000 }]]);
    expect(result.exit).toBe(1); expect(JSON.parse(result.logs.join(""))).toEqual(response); expect(result.errors).toEqual([]);
  });
});
