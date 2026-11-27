// #3416 (3): the opt-in status line throttle. The generated shell check runs before Node: while the collector started
// less than the interval ago (and the seat's sidecar is there), it drains the input and leaves; otherwise it stamps the
// start and execs the collector. The check never writes the sidecar, so a reading keeps its real age.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { managedClaudeNodeCommand } from "../src/domain/claude-activity-hooks.js";
import { collectorCommandScriptPath } from "../src/domain/claude-owned-settings.js";
import { contextCollectorPath } from "../src/domain/telemetry-state-paths.js";
import {
  STATUSLINE_THROTTLE_MAX_SECONDS, storedStatuslineThrottle, throttledCollectorCommand, throttledStatusLineForLaunch,
  validateSpecStatuslineThrottle, validateStatuslineThrottle,
} from "../src/domain/claude-statusline-throttle.js";
import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";
import { claudeCommandSessionToken, processArgv } from "../src/domain/native-process-lineage.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

/** A seat's state: a context-usage directory and a stand-in collector that records the input it got and writes the
 *  sidecar, as the real one does. */
function seat(sessionName = "dev-impl@team") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-throttle-")); roots.push(root);
  const contextDir = path.join(root, "home's state", "context-usage");
  fs.mkdirSync(contextDir, { recursive: true });
  const runs = path.join(root, "runs.log");
  const base = path.join(contextDir, sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_"));
  const collector = path.join(root, "collector.cjs");
  fs.writeFileSync(collector, `const fs = require("node:fs"); let input = ""; process.stdin.on("data", c => { input += c; });
process.stdin.on("end", () => { fs.appendFileSync(${JSON.stringify(runs)}, JSON.stringify(input) + "\\n");
  const id = /"session_id":"([^"]*)"/.exec(input), used = /"used_percentage":([0-9.]+)/.exec(input);
  if (!input.includes("no-write")) fs.writeFileSync(${JSON.stringify(base + ".json")},
    JSON.stringify({ context_window: { used_percentage: used ? Number(used[1]) : null }, session_id: id ? id[1] : null })); });`);
  const command = (seconds: number) => throttledCollectorCommand({
    collectorCommand: managedClaudeNodeCommand(process.execPath, collector, contextDir, path.join(root, "provider-usage")),
    contextDir, sessionName, seconds,
  });
  const payload = (sessionId: string, used: number | null, extra = "") =>
    `{"session_id":"${sessionId}","session_name":"x","context_window":{"context_window_size":200000,"used_percentage":${used}},`
    + `"rate_limits":{"five_hour":{"used_percentage":12}}${extra}}`;
  const run = (seconds: number, input = payload("conv-1", 37.4), shell: string[] = ["/bin/sh"]) => {
    const r = spawnSync(shell[0]!, [...shell.slice(1), "-c", command(seconds)], { encoding: "utf8", timeout: 10_000, input,
      env: { PATH: path.dirname(process.execPath) + ":/usr/bin:/bin" } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const inputs = () => (fs.existsSync(runs) ? fs.readFileSync(runs, "utf8").trim().split("\n").map(line => JSON.parse(line) as string) : []);
  const now = () => Math.floor(Date.now() / 1000);
  /** An earlier collection: the stamp, then the sidecar it wrote (not older than the stamp, naming its conversation as
   *  the collector's does). */
  const collectedBefore = (secondsAgo: number, sessionId = "conv-1", used = "37") => {
    fs.writeFileSync(`${base}.throttle`, `${now() - secondsAgo} s=${sessionId} u=${used}\n`);
    fs.writeFileSync(`${base}.json`, JSON.stringify({ context_window: { used_percentage: Number(used) }, session_id: sessionId }));
  };
  return { root, contextDir, base, run, inputs, now, command, payload, collectedBefore };
}

const QUIET = { status: 0, stdout: "", stderr: "" };

describe("the throttled status line check (#3416 item 3)", () => {
  it("collects on the first run, passes the input through unchanged and stamps session and whole percent", () => {
    const s = seat();
    expect(s.run(30)).toEqual(QUIET);
    expect(s.inputs()).toEqual([s.payload("conv-1", 37.4)]);
    const [time, session, used] = fs.readFileSync(`${s.base}.throttle`, "utf8").trim().split(" ");
    expect(time).toMatch(/^[1-9][0-9]{9}$/);
    expect(Math.abs(Number(time) - s.now())).toBeLessThanOrEqual(2);
    expect([session, used]).toEqual(["s=conv-1", "u=37"]);
    expect(fs.readdirSync(s.contextDir).filter(name => name.includes(".throttle."))).toEqual([]); // no temporary left
  });

  it.each([37.9, 38, 61])("skips Node within the interval in the same conversation with the context at %s%% (not lower), printing nothing", used => {
    const s = seat();
    s.collectedBefore(5);
    const sidecar = `${s.base}.json`, before = fs.statSync(sidecar).mtimeMs;
    expect(s.run(30, s.payload("conv-1", used))).toEqual(QUIET);
    expect(s.inputs()).toEqual([]);
    expect(fs.statSync(sidecar).mtimeMs).toBe(before); // the reading keeps its own time
  });

  it.each([
    ["the context dropped (a compaction)", (s: ReturnType<typeof seat>) => s.payload("conv-1", 9)],
    ["the context dropped by a single percent", (s: ReturnType<typeof seat>) => s.payload("conv-1", 36.9)],
    ["the percent is out of range", (s: ReturnType<typeof seat>) => s.payload("conv-1", 12345678901234567890)],
    ["another conversation (a fresh launch or a handover)", (s: ReturnType<typeof seat>) => s.payload("conv-2", 37)],
    ["the percent is unknown", (s: ReturnType<typeof seat>) => s.payload("conv-1", null)],
    ["the input has no session id", () => `{"context_window":{"used_percentage":37}}`],
  ])("collects at once, within the interval, when %s", (_label, input) => {
    const s = seat();
    s.collectedBefore(5);
    const payload = input(s);
    expect(s.run(30, payload)).toEqual(QUIET);
    expect(s.inputs()).toEqual([payload]);
  });

  it.each([
    ["no session id", `{"context_window":{"used_percentage":37}}`],
    ["a session id written with a space after the colon", `{"session_id": "conv-1","context_window":{"used_percentage":37}}`],
    ["an empty session id", `{"session_id":"","context_window":{"used_percentage":37}}`],
  ])("collects on two successive inputs with %s (two unreadable inputs never match each other)", (_label, input) => {
    const s = seat();
    expect(s.run(30, input)).toEqual(QUIET);
    expect(s.run(30, input)).toEqual(QUIET);
    expect(s.inputs()).toEqual([input, input]);
  });

  it.each([
    ["only outside context_window (rate_limits)",
      `{"session_id":"conv-1","context_window":{"context_window_size":200000},"rate_limits":{"five_hour":{"used_percentage":40}}}`],
    ["outside context_window, with no context_window at all", `{"session_id":"conv-1","rate_limits":{"five_hour":{"used_percentage":40}}}`],
    ["twice inside context_window", `{"session_id":"conv-1","context_window":{"used_percentage":40,"current_usage":{"used_percentage":41}}}`],
    ["in a context_window that never closes", `{"session_id":"conv-1","context_window":{"used_percentage":40`],
  ])("collects, within the interval, when used_percentage is %s", (_label, input) => {
    const s = seat();
    s.collectedBefore(5);
    expect(s.run(30, input)).toEqual(QUIET);
    expect(s.inputs()).toEqual([input]);
  });

  it("reads used_percentage from context_window around its nested current_usage, and skips", () => {
    const s = seat();
    s.collectedBefore(5);
    const input = `{"session_id":"conv-1","context_window":{"current_usage":{"input_tokens":2,"cache_read_input_tokens":9},`
      + `"used_percentage":38,"remaining_percentage":62},"rate_limits":{"five_hour":{"used_percentage":90}}}`;
    expect(s.run(30, input)).toEqual(QUIET);
    expect(s.inputs()).toEqual([]);
  });

  it("collects when the sidecar is another conversation's, however its time compares with the stamp", () => {
    // Where `-nt` compares whole seconds (BusyBox): conversation A wrote its reading, and in the same second the new
    // conversation B stamped and its collector failed. B's next update must not be skipped over A's reading.
    const s = seat();
    s.collectedBefore(5, "conv-2");
    fs.writeFileSync(`${s.base}.json`, JSON.stringify({ context_window: { used_percentage: 50 }, session_id: "conv-1" }));
    const same = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
    fs.utimesSync(`${s.base}.throttle`, same, same);
    fs.utimesSync(`${s.base}.json`, same, same);
    expect(s.run(30, s.payload("conv-2", 37))).toEqual(QUIET);
    expect(s.inputs()).toEqual([s.payload("conv-2", 37)]);
  });

  it("collects when the stamped collection never wrote and the sidecar still holds the reading before it (same second)", () => {
    // Where `-nt` compares whole seconds: a collection at 40 wrote; in the same second a compaction to 20 stamped u=20
    // and its collector was cancelled. The next update at 21 must not be skipped over the reading of 40.
    const s = seat();
    s.collectedBefore(5, "conv-1", "20");
    fs.writeFileSync(`${s.base}.json`, JSON.stringify({ context_window: { used_percentage: 40 }, session_id: "conv-1" }));
    const same = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
    fs.utimesSync(`${s.base}.throttle`, same, same);
    fs.utimesSync(`${s.base}.json`, same, same);
    expect(s.run(30, s.payload("conv-1", 21))).toEqual(QUIET);
    expect(s.inputs()).toEqual([s.payload("conv-1", 21)]);
  });

  const zsh = ["/usr/bin/zsh", "/bin/zsh"].find(candidate => fs.existsSync(candidate));
  it.skipIf(!zsh)("parses and behaves the same in native zsh: skips in the same conversation, collects on a drop", () => {
    const s = seat();
    s.collectedBefore(5);
    expect(s.run(30, s.payload("conv-1", 38), [zsh!, "-f"])).toEqual(QUIET);
    expect(s.inputs()).toEqual([]);
    expect(s.run(30, s.payload("conv-1", 9), [zsh!, "-f"])).toEqual(QUIET);
    expect(s.inputs()).toEqual([s.payload("conv-1", 9)]);
  });

  const busybox = ["/usr/bin/busybox", "/bin/busybox"].find(candidate => fs.existsSync(candidate));
  it.skipIf(!busybox)("behaves the same in BusyBox sh: skips in the same conversation, collects over another's sidecar", () => {
    const s = seat();
    s.collectedBefore(5);
    expect(s.run(30, s.payload("conv-1", 38), [busybox!, "sh"])).toEqual(QUIET);
    expect(s.inputs()).toEqual([]);
    s.collectedBefore(5, "conv-2");
    fs.writeFileSync(`${s.base}.json`, JSON.stringify({ session_id: "conv-1" }));
    expect(s.run(30, s.payload("conv-2", 38), [busybox!, "sh"])).toEqual(QUIET);
    expect(s.inputs()).toEqual([s.payload("conv-2", 38)]);
  });

  it("collects again once the interval has passed", () => {
    const s = seat();
    s.collectedBefore(31);
    expect(s.run(30, s.payload("conv-1", 37))).toEqual(QUIET);
    expect(s.inputs()).toHaveLength(1);
  });

  it("collects when the last collection started but never wrote the sidecar, then throttles once one did", () => {
    const s = seat();
    s.collectedBefore(5);
    fs.utimesSync(`${s.base}.json`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)); // older than the stamp
    expect(s.run(30, s.payload("conv-1", 37, ',"x":"no-write"'))).toEqual(QUIET);
    expect(s.inputs()).toHaveLength(1);
    expect(s.run(30, s.payload("conv-1", 37))).toEqual(QUIET); // the stamp is newer than the old sidecar: collect
    expect(s.inputs()).toHaveLength(2);
    expect(s.run(30, s.payload("conv-1", 37))).toEqual(QUIET); // that one wrote: now throttled
    expect(s.inputs()).toHaveLength(2);
  });

  it("collects when the sidecar is gone (a handover removes it), however fresh the stamp", () => {
    const s = seat();
    s.collectedBefore(1);
    fs.unlinkSync(`${s.base}.json`);
    expect(s.run(30, s.payload("conv-1", 37))).toEqual(QUIET);
    expect(s.inputs()).toHaveLength(1);
  });

  it.each([
    ["not a number", "abc"],
    ["a leading zero", "0123456789"],
    ["too many digits to compute with", "99999999999999999999999"],
    ["a time in the future (the clock went back)", "FUTURE"],
    ["empty", ""],
  ])("collects, without a shell error, when the stamp's time is %s", (_label, time) => {
    const s = seat();
    s.collectedBefore(1);
    const text = time === "FUTURE" ? String(s.now() + 3600) : time;
    fs.writeFileSync(`${s.base}.throttle`, `${text} s=conv-1 u=37\n`);
    fs.utimesSync(`${s.base}.throttle`, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    expect(s.run(30, s.payload("conv-1", 37))).toEqual(QUIET);
    expect(s.inputs()).toHaveLength(1);
  });

  it("collects on every run, writing nothing into it, when a directory stands where the stamp goes", () => {
    const s = seat();
    fs.writeFileSync(`${s.base}.json`, "{}");
    fs.mkdirSync(`${s.base}.throttle`);
    expect(s.run(30).status).toBe(0);
    expect(s.run(30).status).toBe(0);
    expect(s.inputs()).toHaveLength(2);
    expect(fs.readdirSync(`${s.base}.throttle`)).toEqual([]);
  });

  it("names the sidecar the way the collector does, for session names with other characters", () => {
    const s = seat("dev impl@team's rig");
    expect(s.base.endsWith("dev_impl@team_s_rig")).toBe(true);
    s.collectedBefore(1);
    expect(s.run(30, s.payload("conv-1", 37))).toEqual(QUIET);
    expect(s.inputs()).toEqual([]);
  });

  it("refuses an interval outside 1 to 120 whole seconds, and the spec's 0 clears", () => {
    for (const bad of [0, -1, 1.5, 121, "30", null]) expect(() => validateStatuslineThrottle(bad, "x")).toThrow(/1 to 120/);
    expect(validateStatuslineThrottle(1, "x")).toBe(1);
    expect(validateStatuslineThrottle(STATUSLINE_THROTTLE_MAX_SECONDS, "x")).toBe(120);
    expect(validateSpecStatuslineThrottle(0)).toBe(0);
    expect(() => validateSpecStatuslineThrottle(121)).toThrow(/0 \(off\)/);
    expect(() => seat().command(0)).toThrow();
    expect([storedStatuslineThrottle(30), storedStatuslineThrottle(null), storedStatuslineThrottle(500)]).toEqual([30, null, null]);
  });
});

describe("the throttled status line in a launch (#3416 item 3)", () => {
  function folder(settings?: unknown) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-launch-")); roots.push(root);
    const cwd = path.join(root, "seat"), state = path.join(root, "home");
    if (settings !== undefined) {
      fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
    }
    return throttledStatusLineForLaunch({ readFile: p => fs.readFileSync(p, "utf8"), exists: fs.existsSync, cwd, stateDir: state,
      nodeExecutable: process.execPath, sessionName: "dev-impl@team", seconds: 30 });
  }

  it("throttles OpenRig's own collector, keeping the folder's other status line fields", () => {
    const owned = managedClaudeNodeCommand(process.execPath, "/x/.openrig/context-collector.cjs", "/h/state/context-usage", "/h/state/provider-usage");
    const instanceOwned = managedClaudeNodeCommand(process.execPath, "/h/state/claude-context-collector/context-collector.cjs", "/h/state/context-usage", "/h/state/provider-usage");
    for (const settings of [undefined, {}, "", { statusLine: { type: "command", command: instanceOwned, padding: 2 } }, { statusLine: { type: "command", command: owned, padding: 2 } },
      { statusLine: { type: "command", command: owned.replace(/^exec /, ""), padding: 2 } }]) {
      const result = folder(settings);
      expect(result).toHaveProperty("statusLine");
      const statusLine = (result as { statusLine: Record<string, unknown> }).statusLine;
      expect(statusLine["type"]).toBe("command");
      expect(statusLine["command"]).toMatch(/^f=.*context-usage\/dev-impl@team'; p=\$\(cat\); /);
      expect(statusLine["command"]).toMatch(/\[ "\$a" -lt 30 \]; then exit 0; fi;; esac; fi;; esac;; esac; fi; .* \| exec '[^']+' '[^']+\/home\/state\/claude-context-collector\/context-collector\.cjs'/);
      if (typeof settings === "object" && settings && "statusLine" in settings) expect(statusLine["padding"]).toBe(2);
    }
  });

  it("leaves a status line command of the person's own in place, and says why", () => {
    expect(folder({ statusLine: { type: "command", command: "sh ~/my-status-line.sh" } }))
      .toEqual({ note: expect.stringContaining("sets its own status line command, which wins") });
    expect(folder("{ not json")).toEqual({ note: expect.stringContaining("couldn't be read as settings") });
    expect(folder("[]")).toEqual({ note: expect.stringContaining("isn't a settings object") });
  });

  it.each(["owned legacy", "user wrapper"])("repoints the owned command but leaves the legacy file for the settings poll: %s", (kind) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "statusline-migration-")); roots.push(cwd);
    const stateDir = path.join(cwd, "instance");
    const legacyDir = path.join(cwd, ".openrig");
    const legacy = path.join(legacyDir, "context-collector.cjs");
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(legacy, "// older collector\n");
    const command = kind === "owned legacy" ? managedClaudeNodeCommand("node", legacy, "/context", "/provider")
      : `sh './my-wrapper.sh' '${legacy}'`;
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(settingsPath));
    const settings = JSON.stringify({ statusLine: { type: "command", command, padding: 2 } });
    fs.writeFileSync(settingsPath, settings);

    const result = throttledStatusLineForLaunch({ readFile: p => fs.readFileSync(p, "utf8"), exists: fs.existsSync,
      cwd, stateDir, nodeExecutable: process.execPath, sessionName: "dev", seconds: 30 });

    expect(fs.readFileSync(settingsPath, "utf8")).toBe(settings); // The throttle only writes launch settings.
    if (kind === "owned legacy") {
      expect(result).toHaveProperty("statusLine.padding", 2);
      expect(collectorCommandScriptPath((result as { statusLine: { command: string } }).statusLine.command)).toBe(contextCollectorPath(stateDir));
      // The throttle only builds the launch's --settings value; the settings poll removes the legacy file once
      // it has repointed `.claude/settings.local.json`, so a failed launch never strands the settings on a missing file.
      expect(fs.readFileSync(legacy, "utf8")).toBe("// older collector\n");
      expect(fs.existsSync(legacyDir)).toBe(true);
    } else {
      expect(result).toHaveProperty("note");
      expect(fs.readFileSync(legacy, "utf8")).toBe("// older collector\n");
    }
  });

  it("puts the throttled status line into the launch's one --settings value, and leaves an unthrottled launch as it was", () => {
    const choice = { kernelAuthority: true, managedCompaction: false };
    const statusLine = (folder() as { statusLine: Record<string, unknown> }).statusLine;
    const args = operationalLaunchArgs("claude-code", { ...choice, statusLine });
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!) as Record<string, unknown>;
    expect(settings["statusLine"]).toEqual(statusLine);
    expect(settings["hooks"]).toBeDefined(); // the kernel's permission hook is kept beside it
    expect(operationalLaunchArgs("claude-code", { ...choice })).toEqual(operationalLaunchArgs("claude-code", { ...choice, statusLine: undefined }));
    expect(JSON.parse(operationalLaunchArgs("claude-code", choice)[1]!)).not.toHaveProperty("statusLine");
  });

  it("keeps the identity proof's reading of --settings from ps with the throttled command in it", () => {
    const statusLine = (folder() as { statusLine: Record<string, unknown> }).statusLine;
    const args = operationalLaunchArgs("claude-code", { kernelAuthority: true, managedCompaction: false, statusLine });
    const value = args[args.indexOf("--settings") + 1]!;
    const ps = `claude --session-id 11111111-1111-4111-8111-111111111111 --settings ${value} --name dev-impl@team`;
    expect(claudeCommandSessionToken(ps)).toBe("11111111-1111-4111-8111-111111111111");
    const argv = processArgv(ps);
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!)).toEqual(JSON.parse(value));
  });
});
