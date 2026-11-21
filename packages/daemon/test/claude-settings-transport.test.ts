import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transportClaudeSettings, ownClaudeSettings } from "../src/adapters/claude-settings-transport.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { resumedClaudeArguments, sentClaudeAutoMode } from "../src/domain/claude-continuation-launch.js";

const roots: string[] = [];
const seat = () => {
  const openrigHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-"));
  roots.push(openrigHome);
  return { openrigHome, session: "builder@fixture" };
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("Claude settings file transport", () => {
  it("keeps the exact 64 KiB margin inline and stages the next byte", () => {
    const context = seat(), value = JSON.stringify({ x: "x".repeat(65528) });
    expect(Buffer.byteLength(value)).toBe(65536);
    expect(transportClaudeSettings(["--settings", value], context, [])).toEqual(["--settings", value]);
    const larger = JSON.stringify({ x: "x".repeat(65529) });
    expect(fs.readFileSync(transportClaudeSettings(["--settings", larger], context, [])[1]!, "utf8")).toBe(larger);
  });

  it("keeps small composed permissions, hooks, status line and auto mode byte-identical", () => {
    const context = seat();
    const args = operationalLaunchArgs("claude-code", { teamPermissionDefault: true, managedCompaction: true,
      hookBridge: true, claudePermissions: { deny: ["Read(/example/private/**)"] },
      statusLine: { type: "command", command: "echo fixture" }, claudeAutoMode: { environment: ["$defaults", "fixture"] } });
    expect(transportClaudeSettings(args, context, [])).toEqual(args);
    expect(fs.readdirSync(context.openrigHome)).toEqual([]);
  });

  it("stages exact UTF-8 bytes above the margin in a reusable 0600 content-addressed file", () => {
    const context = seat(), warnings: string[] = [];
    const value = JSON.stringify({ text: "🙂".repeat(20000) });
    expect(value.length).toBeLessThan(65536);
    const args = ["--settings", value];
    const staged = transportClaudeSettings(args, context, warnings);
    const file = staged[1]!;
    expect(path.basename(file)).toBe(`${createHash("sha256").update(value).digest("hex")}.json`);
    expect(fs.readFileSync(file, "utf8")).toBe(value);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(transportClaudeSettings(args, context, warnings)).toEqual(staged);
    expect(warnings).toEqual([]);
    expect(ownClaudeSettings(file, { ...context, session: "someone-else@fixture" })).toBeUndefined();
  });

  it("keeps the current and captured live file, pruning only older generated files for this seat", () => {
    const context = seat();
    const args = (n: number) => ["--settings", JSON.stringify({ text: String(n).repeat(70000) })];
    const live = transportClaudeSettings(args(1), context, []);
    const edited = transportClaudeSettings(args(2), context, [], live)[1]!;
    fs.writeFileSync(edited, '{"changed":true}');
    const stale = transportClaudeSettings(args(3), context, [], live);
    const foreign = path.join(path.dirname(live[1]!), "operator.json");
    fs.writeFileSync(foreign, "untouched");
    const current = transportClaudeSettings(args(4), context, [], live);
    expect(fs.existsSync(live[1]!)).toBe(true);
    expect(fs.existsSync(current[1]!)).toBe(true);
    expect(fs.existsSync(stale[1]!)).toBe(false);
    expect(fs.readFileSync(edited, "utf8")).toBe('{"changed":true}');
    expect(fs.readFileSync(foreign, "utf8")).toBe("untouched");
  });

  it("publishes a complete file on retry after a partial write fails", () => {
    const context = seat(), warnings: string[] = [];
    const value = JSON.stringify({ text: "x".repeat(70000) });
    const args = ["--settings", value];
    const write = fs.writeFileSync;
    const failure = vi.spyOn(fs, "writeFileSync").mockImplementationOnce((file, _data, options) => {
      write(file, value.slice(0, 100), options);
      throw new Error("injected storage failure after a partial write");
    });
    try {
      expect(transportClaudeSettings(args, context, warnings)).toEqual(args);
      expect(warnings).toEqual([expect.stringContaining("injected storage failure")]);
    } finally {
      failure.mockRestore();
    }

    const retryWarnings: string[] = [];
    const [, published] = transportClaudeSettings(args, context, retryWarnings);
    expect(published).not.toBe(value);
    expect(ownClaudeSettings(published!, context)).toBe(value);
    expect(fs.readdirSync(path.dirname(published!))).toEqual([path.basename(published!)]);
    expect(retryWarnings).toEqual([]);
  });

  it("falls back inline with size and failed-write warnings, without including settings content", () => {
    const context = seat(), warnings: string[] = [];
    fs.writeFileSync(path.join(context.openrigHome, "state"), "not a directory");
    const args = ["--settings", JSON.stringify({ privateMarker: "sensitive-fixture-marker" + "x".repeat(70000) })];
    expect(transportClaudeSettings(args, context, warnings)).toEqual(args);
    expect(warnings.join(" ")).toMatch(/\d+ UTF-8 bytes.*file write failed.*inline/);
    expect(warnings.join(" ")).not.toContain("sensitive-fixture-marker");
  });

  it.each([false, true])("rewrites own captured settings for auto mode and stages the result (equals form %s)", inline => {
    const context = seat();
    const value = JSON.stringify({ custom: "x".repeat(70000), autoMode: { environment: ["old"] } });
    const live = transportClaudeSettings(inline ? [`--settings=${value}`] : ["--settings", value], context, []);
    const block = { environment: ["new"] };
    const composed = resumedClaudeArguments({ args: live, warnings: [] }, [], "same", undefined, undefined, block, context);
    const current = transportClaudeSettings(composed, context, [], live);
    expect(sentClaudeAutoMode(current, context)).toEqual(block);
    const file = inline ? current[0]!.slice(11) : current[1]!;
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ custom: "x".repeat(70000), autoMode: block });
    expect(ownClaudeSettings(inline ? live[0]!.slice(11) : live[1]!, context)).toBe(value);
  });

  it("keeps foreign and modified files opaque rather than changing their auto mode", () => {
    const context = seat();
    const foreign = path.join(context.openrigHome, "operator.json");
    fs.writeFileSync(foreign, JSON.stringify({ autoMode: { environment: ["foreign"] } }));
    const args = ["--settings", foreign];
    expect(transportClaudeSettings(args, context, [])).toEqual(args);
    expect(sentClaudeAutoMode(args, context)).toBeUndefined();
    const owned = transportClaudeSettings(["--settings", JSON.stringify({ x: "x".repeat(70000) })], context, [])[1]!;
    fs.writeFileSync(owned, "{}");
    expect(ownClaudeSettings(owned, context)).toBeUndefined();
  });
});
