import { describe, expect, it, vi } from "vitest";
import { codexCommandResumeToken, explainNativeRejection, findExactNativeResumeProcess, observeClaudePaneStartedAt, observeClaudeDelivery, observeCodexForkProcess, verifyClaudePaneProcess, verifyCodexPaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

import { operationalLaunchArgs } from "../src/adapters/kernel-authority.js";

const token = "00000000-0000-7000-8000-000000000001";
const parent = "00000000-0000-7000-8000-0000000000fa";
const startedAt = "Sat Jan  1 12:00:00 2000";
function rows(): NativeProcessRow[] {
  return [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "bash", command: "/bin/sh /tmp/openrig-tmux-send.txt", startedAt },
    { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "node", command: `node /opt/bin/codex resume ${token}`, startedAt },
    { pid: 13, ppid: 12, pgid: 11, tpgid: 11, executableName: "codex", command: `/opt/native/codex -p resume resume --add-dir /tmp/state ${token}`,
      argv: ["/opt/native/codex", "-p", "resume", "resume", "--add-dir", "/tmp/state", token], startedAt },
  ];
}
function codexCommand(row: NativeProcessRow, command: string, argv = command.split(" ")): NativeProcessRow {
  return { ...row, command, argv };
}
const check = (listProcesses: () => NativeProcessRow[] | Promise<NativeProcessRow[]>, overrides = {}) => verifyCodexPaneProcess({
  target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses, expectedToken: token, requireResume: true, ...overrides,
});

describe("Codex resume options (#1400)", () => {
  const options = [
    "-m gpt-5", "--model gpt-5", "-c model_reasoning_effort=high", "--config model_reasoning_effort=high",
    "-p work", "--profile work", "-C /project", "--cd /project", "--add-dir /extra",
    "-a on-request", "--ask-for-approval on-request", "-s workspace-write", "--sandbox workspace-write",
    "--enable feature", "--disable feature", "--local-provider ollama",
    "--remote ws://localhost:9000", "--remote-auth-token-env CODEX_REMOTE_TOKEN",
  ];
  it.each(options)("skips option values on either side of resume: %s", option => {
    expect(codexCommandResumeToken(`codex ${option} resume ${token}`)).toBe(token);
    expect(codexCommandResumeToken(`codex resume ${option} ${token}`)).toBe(token);
    expect(codexCommandResumeToken(`codex ${option}`)).toBeUndefined();
    expect(codexCommandResumeToken(`codex resume ${option}`)).toBeNull();
  });
  it.each([
    `-C /project resume -m gpt-5 -c model_reasoning_effort=high ${token}`,
    `--profile=work resume --cd=/project --model=gpt-5 ${token}`,
    `-C/project resume -mgpt-5 ${token} continue`,
    `--profile resume resume --add-dir resume ${token}`,
    `--search resume --no-alt-screen ${token}`,
    `resume -- ${token}`,
  ])("proves the named conversation through both lineage paths: %s", args => {
    const command = `/opt/native/codex ${args}`;
    const process = codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, command);
    expect(codexCommandResumeToken(command)).toBe(token);
    expect(findExactNativeResumeProcess([process], 10, "codex", token)?.pid).toBe(10);
    expect(findExactNativeResumeProcess([process], 10, "codex", "gpt-5")).toBeNull();
  });
  it.each(["resume", "resume --last", "resume --all", "resume -m", "resume --cd"])("keeps unnamed resumes distinct from fresh launches: %s", args => {
    expect(codexCommandResumeToken(`codex ${args}`)).toBeNull();
  });
  it.each(["-C /project", "--cd /project", "-m resume", "--profile resume", "exec resume", "-- resume"])("does not invent a resume from an option value or prompt: %s", args => {
    expect(codexCommandResumeToken(`codex ${args}`)).toBeUndefined();
  });
  it("does not mistake an option value for the stored conversation", async () => {
    const list = () => rows().map(row => row.pid === 13
      ? codexCommand(row, `/opt/native/codex resume -m ${token} other`) : row);
    expect(await check(list)).toBeNull();
    expect(findExactNativeResumeProcess(list(), 10, "codex", token)).toBeNull();
  });
  it("accepts matching wrapper and native resumes with options on different sides", async () => {
    const list = () => rows().map(row => row.pid === 12
      ? { ...row, command: `node /opt/bin/codex --cd /project resume ${token}` }
      : row.pid === 13 ? codexCommand(row, `/opt/native/codex resume -m gpt-5 -C /project ${token}`) : row);
    expect((await check(list))?.process.pid).toBe(13);
    expect(await check(list, { expectedToken: "gpt-5" })).toBeNull();
  });
  it.each([`-C /project fork ${token}`, `fork -m gpt-5 ${token}`, `--profile work fork --cd /project ${token}`])("keeps the shared fork reader aligned: %s", async args => {
    const input = {
      target: "%1", tmux: { getPanePid: async () => 10 }, parentToken: token,
      listProcesses: () => [codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, `codex ${args}`)],
    };
    expect((await observeCodexForkProcess(input))?.process.pid).toBe(10);
    expect(await observeCodexForkProcess({ ...input, parentToken: "gpt-5" })).toBeNull();
    expect(codexCommandResumeToken(`codex ${args}`)).toBeUndefined();
  });

  // Codex rust-v0.162.1: SharedCliOptions.images has num_args = 1..;
  // finalize_{resume,fork}_interactive reinterprets --last's positional as a prompt.
  // These expectations come from that grammar, independently of our option table.
  const imageCases: [string, string | null][] = [
    [`-i a.png ${token} -- ${parent}`, parent],
    [`-i ${token} a.png -- ${token}`, token],
    [`-i a.png b.png c.png -- ${token}`, token],
    [`--image a.png ${token} b.png -- ${parent}`, parent],
    [`-i a.png -- ${token}`, token],
    [`-i image.png ${token}`, null],
    [`--image ${token} a.png`, null],
    [`-i a.png b.png -m model ${token}`, token],
    [`-i a.png -i b.png ${parent} -- ${token}`, token],
    [`${token} -i a.png b.png`, token],
    [`--image=a.png,b.png ${token}`, token],
    [`-ia.png ${token}`, token],
    [`-i=a.png ${token}`, token],
  ];
  it.each(imageCases)("keeps every image separate from the resumed conversation: %s", async (args, expected) => {
    const command = `codex resume ${args}`;
    const list = () => [codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, command)];
    expect(codexCommandResumeToken(command)).toBe(expected);
    expect(Boolean(await check(list))).toBe(expected === token);
    expect(Boolean(findExactNativeResumeProcess(list(), 10, "codex", token))).toBe(expected === token);
  });
  it.each(imageCases)("keeps every image separate from a fork's parent: %s", async (args, expected) => {
    const input = {
      target: "%1", tmux: { getPanePid: async () => 10 }, parentToken: token,
      listProcesses: () => [codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, `codex fork ${args}`)],
    };
    expect(Boolean(await observeCodexForkProcess(input))).toBe(expected === token);
  });
  it.each(["-i", "--image"])("consumes root-level image values before looking for a command: %s", option => {
    expect(codexCommandResumeToken(`codex ${option} a.png resume ${token}`)).toBeUndefined();
    expect(codexCommandResumeToken(`codex ${option} a.png b.png -m model resume ${token}`)).toBe(token);
    expect(codexCommandResumeToken(`codex ${option} ${token} b.png -- resume ${token}`)).toBeUndefined();
  });
  const lastCases = [
    `--last ${token}`, `-m model --last ${token}`, `--last -C /project ${token}`,
    `--last -- ${token}`, `${token} --last`, `${token} -m model --last`,
  ];
  it.each(lastCases)("never proves a --last prompt as a resumed conversation: %s", async args => {
    const command = `codex -p work resume ${args}`;
    const list = () => [codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, command)];
    expect(codexCommandResumeToken(command)).toBeNull();
    expect(await check(list)).toBeNull();
    expect(findExactNativeResumeProcess(list(), 10, "codex", token)).toBeNull();
  });
  it.each(lastCases)("never proves a --last prompt as a fork's parent: %s", async args => {
    expect(await observeCodexForkProcess({
      target: "%1", tmux: { getPanePid: async () => 10 }, parentToken: token,
      listProcesses: () => [codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, `codex -C /project fork ${args}`)],
    })).toBeNull();
  });
  it.each([`resume ${token}`, `resume -- ${token}`, `resume ${token} -- --last`])("still proves explicit resumes with a positional or escaped --last: %s", async args => {
    const command = `codex ${args}`;
    expect(codexCommandResumeToken(command)).toBe(token);
    expect(await check(() => [codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, command)])).not.toBeNull();
  });
  it.each([
    [`codex resume ${token}`, true],
    [`codex resume ${token} explain --last selection`, false],
    [`codex resume ${token} --last`, false],
  ] as const)("requires an exact resume even with a late --last: %s", async (command, expected) => {
    const list = () => [codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, command)];
    expect(Boolean(await check(list))).toBe(expected);
  });
  const promptCases: Array<[string, string[]]> = [
    [`${token}`, [token]],
    [`${token} explain --last selection`, [token, "explain --last selection"]],
    [`${token} explain --last`, [token, "explain --last"]],
    [`${token} -m model explain --last selection`, [token, "-m", "model", "explain --last selection"]],
    [`-m model ${token} explain --last selection`, ["-m", "model", token, "explain --last selection"]],
    [`${token} -- explain --last selection`, [token, "--", "explain", "--last", "selection"]],
  ];
  it.each(promptCases)("keeps a literal prompt argument from turning an explicit resume into --last: %s", async (args, tail) => {
    const command = `codex -C /project resume ${args}`;
    const list = () => [codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, command, ["codex", "-C", "/project", "resume", ...tail])];
    expect(codexCommandResumeToken(command)).toBe(token);
    expect((await check(list))?.process.pid).toBe(10);
    expect(findExactNativeResumeProcess(list(), 10, "codex", token)?.pid).toBe(10);
  });
  it.each(promptCases)("keeps a literal prompt argument from turning an explicit fork into --last: %s", async (args, tail) => {
    expect((await observeCodexForkProcess({
      target: "%1", tmux: { getPanePid: async () => 10 }, parentToken: token,
      listProcesses: () => [codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, `codex -C /project fork ${args}`,
        ["codex", "-C", "/project", "fork", ...tail])],
    }))?.process.pid).toBe(10);
  });
  it("refuses a real --last after a separate prompt argument", async () => {
    const argv = ["codex", "resume", token, "explain", "--last", "selection"];
    const list = () => [codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, argv.join(" "), argv)];
    expect(await check(list)).toBeNull();
    expect(findExactNativeResumeProcess(list(), 10, "codex", token)).toBeNull();
    expect(explainNativeRejection(list(), 10, "codex", token, true)).toEqual({ kind: "names_no_conversation" });
    expect(await observeCodexForkProcess({ target: "%1", tmux: { getPanePid: async () => 10 }, parentToken: token,
      listProcesses: () => [codexCommand({ ...rows()[3]!, pid: 10, ppid: 1 }, `codex fork ${token} explain --last selection`,
        ["codex", "fork", token, "explain", "--last", "selection"])] })).toBeNull();
  });
});

describe("joined native Codex identity", () => {
  it("does not turn a BOM-prefixed Linux argument into the expected UUID", async () => {
    const argv = ["/opt/native/codex", "resume", `\ufeff${token}`];
    const list = () => rows().map(r => r.pid === 13 ? { ...r, command: argv.join(" "), argv } : r);
    expect(await check(list)).toBeNull();
    expect(findExactNativeResumeProcess(list(), 10, "codex", token)).toBeNull();
  });

  it.each(["child", "sibling", "ancestor"] as const)(
    "keeps an opaque foreground Codex %s in uniqueness without proving its history", async place => {
      const base = rows();
      const opaque: NativeProcessRow = { ...base[3]!, pid: 14,
        ppid: place === "child" ? 13 : 12, argv: null, command: `codex resume ${token}` };
      const list = () => place === "ancestor"
        ? base.map(r => r.pid === 12 ? { ...r, executableName: "codex", argv: null } : r)
        : [...base, opaque];
      const delivered = await check(list, { requireResume: false });
      expect(delivered?.process.pid ?? null).toBe(place === "sibling" ? null : place === "child" ? 14 : 13);
      expect(await check(list)).toBeNull();
      expect(findExactNativeResumeProcess(list(), 10, "codex", token)).toBeNull();
      expect(explainNativeRejection(list(), 10, "codex", token, true)).toEqual({ kind: place === "sibling" ? "no_single_process" : "not_a_resume" });
      expect(explainNativeRejection(list(), 10, "codex", token, false)).toEqual({ kind: place === "sibling" ? "no_single_process" : "passes" });
      const forkRows = list().map(r => r.pid === 13 ? { ...r, argv: ["codex", "fork", parent], command: `codex fork ${parent}` } : r);
      expect(await observeCodexForkProcess({ target: "%1", tmux: { getPanePid: async () => 10 },
        parentToken: parent, listProcesses: () => forkRows })).toBeNull();
    });

  it("refuses when an opaque foreground Codex appears in only one of two samples", async () => {
    const base = rows();
    const opaque = { ...base[3]!, pid: 14, ppid: 13, argv: null };
    expect(await check(vi.fn().mockResolvedValueOnce(base).mockResolvedValueOnce([...base, opaque]))).toBeNull();
    expect(await check(vi.fn().mockResolvedValueOnce([...base, opaque]).mockResolvedValueOnce(base))).toBeNull();
  });

  it("delivers to one stable opaque Codex while denying exact proof", async () => {
    const only = { ...rows()[3]!, pid: 10, ppid: 1, argv: null };
    const list = () => [only];
    expect((await check(list, { requireResume: false }))?.process.pid).toBe(10);
    expect(await check(list, { requireResume: false, requireArgv: true })).toBeNull();
    expect(await check(list)).toBeNull();
    expect(findExactNativeResumeProcess(list(), 10, "codex", token)).toBeNull();
    expect(explainNativeRejection(list(), 10, "codex", token, false)).toEqual({ kind: "passes" });
    expect(explainNativeRejection(list(), 10, "codex", token, true)).toEqual({ kind: "not_a_resume" });
  });

  it("requires every chain link's exact argv for strict fresh-process consumers", async () => {
    const base = rows();
    const list = () => base.map(row => row.pid === 12 ? { ...row, executableName: "codex", command: "codex -m model", argv: null }
      : row.pid === 13 ? { ...row, command: "codex -m model", argv: ["codex", "-m", "model"] } : row);
    expect((await check(list, { requireResume: false, expectedToken: undefined }))?.process.pid).toBe(13);
    expect(await check(list, { requireResume: false, expectedToken: undefined, requireArgv: true })).toBeNull();
    const fresh = () => base.map(row => row.pid === 13 ? { ...row, command: "codex -m model", argv: ["codex", "-m", "model"] } : row);
    expect((await check(fresh, { requireResume: false, expectedToken: undefined, requireArgv: true }))?.process.pid).toBe(13);
  });

  it("does not deliver when a readable launcher names a conflicting conversation above an opaque child", async () => {
    const wrong = "00000000-0000-7000-8000-000000000002";
    const base = rows();
    const launcher = { ...base[3]!, argv: ["codex", "resume", wrong], command: `codex resume ${wrong}` };
    const child = { ...base[3]!, pid: 14, ppid: 13, argv: null };
    const list = () => [...base.slice(0, -1), launcher, child];
    expect(await check(list, { requireResume: false })).toBeNull();
    expect(explainNativeRejection(list(), 10, "codex", token, false)).toEqual({ kind: "other_conversation", conversation: wrong });
  });

  it("refuses delivery when argv availability changes between independent samples", async () => {
    const readable = rows();
    const opaque = readable.map(row => row.pid === 13 ? { ...row, argv: null } : row);
    expect(await check(vi.fn().mockResolvedValueOnce(readable).mockResolvedValueOnce(opaque), { requireResume: false })).toBeNull();
    expect(await check(vi.fn().mockResolvedValueOnce(opaque).mockResolvedValueOnce(readable), { requireResume: false })).toBeNull();
  });

  it("retains more than 128 opaque foreground candidates in the uniqueness check", async () => {
    const base = rows();
    const many = Array.from({ length: 129 }, (_, index): NativeProcessRow => ({ ...base[3]!, pid: 1000 + index, ppid: 12, argv: null }));
    const list = () => [...base, ...many];
    expect(await check(list, { requireResume: false })).toBeNull();
    expect(explainNativeRejection(list(), 10, "codex", token, false)).toEqual({ kind: "no_single_process" });
  });

  it.each([
    ["unreadable", null, startedAt],
    ["missing", undefined, startedAt],
    ["malformed", ["codex", "resume", token, "bad\0argument"], startedAt],
    ["wrong argv0", ["node", "resume", token], startedAt],
    ["unknown start", ["codex", "resume", token], undefined],
  ] as const)("keeps a foreground Codex child with %s evidence in uniqueness", async (_case, argv, start) => {
    const base = rows();
    const child: NativeProcessRow = { ...base[3]!, pid: 14, ppid: 13, argv: argv as string[] | null | undefined, startedAt: start };
    const list = () => [...base, child];
    expect((await check(list, { requireResume: false }))?.process.pid ?? null).toBe(start && _case !== "wrong argv0" ? 14 : null);
    expect(await check(list)).toBeNull();
    expect(explainNativeRejection(list(), 10, "codex", token, true)).toEqual({ kind: start && _case !== "wrong argv0" ? "not_a_resume" : "no_single_process" });
  });

  it("keeps readable foreground conflicts and unrelated background Codex separate", async () => {
    const base = rows();
    const sibling = { ...base[3]!, pid: 14, ppid: 12 };
    expect(await check(() => [...base, sibling])).toBeNull();
    expect(explainNativeRejection([...base, sibling], 10, "codex", token, true)).toEqual({ kind: "no_single_process" });
    const background = { ...sibling, argv: null, pgid: 14, tpgid: 11 };
    expect((await check(() => [...base, background]))?.process.pid).toBe(13);
    expect(explainNativeRejection([...base, background], 10, "codex", token, true)).toEqual({ kind: "passes" });
  });

  it.each([
    ["-C", "/Users/me/Library/Application Support/openrig/shared-docs"],
    ["--add-dir", "/tmp/Bob's \"quoted\" 例"],
    ["-p", "openrig desktop agent work"],
  ])("proves a managed resume after the exact %s argument with spaces", async (flag, value) => {
    const argv = ["/opt/native/codex", flag, value, "resume", token];
    const list = () => rows().map(r => r.pid === 13 ? { ...r, command: argv.join(" "), argv } : r);
    expect((await check(list))?.process.pid).toBe(13);
    expect(findExactNativeResumeProcess(list(), 10, "codex", token)?.pid).toBe(13);
    expect(explainNativeRejection(list(), 10, "codex", token, true)).toEqual({ kind: "passes" });
  });
  it("refuses a different valid UUID when the expected one appears only inside an option value", async () => {
    const other = "00000000-0000-7000-8000-000000000002";
    const argv = ["/opt/native/codex", "resume", "--add-dir", `/tmp/path ${token}`, other];
    const list = () => rows().map(r => r.pid === 13 ? { ...r, command: argv.join(" "), argv } : r);
    expect(await check(list)).toBeNull();
    expect(findExactNativeResumeProcess(list(), 10, "codex", token)).toBeNull();
    expect(explainNativeRejection(list(), 10, "codex", token, true)).toEqual({ kind: "other_conversation", conversation: other });
  });
  it("does not promote a prompt's expected UUID over the resumed UUID", async () => {
    const other = "00000000-0000-7000-8000-000000000002";
    const argv = ["/opt/native/codex", "resume", other, `review ${token}`];
    expect(await check(() => rows().map(r => r.pid === 13 ? { ...r, command: argv.join(" "), argv } : r))).toBeNull();
  });
  it.each([[undefined], [null], [[]], [[""]], [["codex", "resume", token, "bad\0argument"]]])("refuses missing or malformed exact argv: %j", async argv => {
    const list = () => rows().map(r => r.pid === 13 ? { ...r, argv } : r);
    expect((await check(list, { requireResume: false }))?.process.pid).toBe(13);
    expect(await check(list)).toBeNull();
    expect(findExactNativeResumeProcess(list(), 10, "codex", token)).toBeNull();
    expect(explainNativeRejection(list(), 10, "codex", token, true)).toEqual({ kind: "not_a_resume" });
  });
  it("refuses an over-budget injected argv even if its prefix names the right conversation", async () => {
    const argv = ["/opt/native/codex", "resume", token, "x".repeat(1024 * 1024)];
    expect((await check(() => rows().map(r => r.pid === 13 ? { ...r, argv } : r), { requireResume: false }))?.process.pid).toBe(13);
    expect(await check(() => rows().map(r => r.pid === 13 ? { ...r, argv } : r))).toBeNull();
  });
  it("rejects changed argv boundaries even when the flattened command is identical", async () => {
    const firstArgv = ["/opt/native/codex", "resume", token, "--add-dir", "/tmp/a b"];
    const secondArgv = ["/opt/native/codex", "resume", token, "--add-dir", "/tmp/a", "b"];
    const first = rows().map(r => r.pid === 13 ? { ...r, command: firstArgv.join(" "), argv: firstArgv } : r);
    const second = rows().map(r => r.pid === 13 ? { ...r, command: secondArgv.join(" "), argv: secondArgv } : r);
    expect(first[3]!.command).toBe(second[3]!.command);
    expect(await check(vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second))).toBeNull();
  });
  it("checks a fork's parent using exact arguments across a spaced profile", async () => {
    const argv = ["codex", "-p", "managed work", "fork", token];
    const input = { target: "%1", tmux: { getPanePid: async () => 10 }, parentToken: token,
      listProcesses: () => [{ ...rows()[3]!, pid: 10, ppid: 1, command: argv.join(" "), argv }] };
    expect((await observeCodexForkProcess(input))?.process.pid).toBe(10);
    const other = "00000000-0000-7000-8000-000000000002";
    expect(await observeCodexForkProcess({ ...input, listProcesses: () => [{ ...rows()[3]!, pid: 10, ppid: 1,
      command: `codex fork --add-dir /tmp/${token} ${other}`,
      argv: ["codex", "fork", "--add-dir", `/tmp/${token}`, other] }] })).toBeNull();
  });
  it("selects the unique native process, not its Node wrapper", async () => {
    expect((await check(rows))?.process.pid).toBe(13);
    expect(findExactNativeResumeProcess(rows(), 10, "codex", token)?.pid).toBe(13);
  });
  it("proves direct-native resume", async () => {
    expect((await check(() => [{ ...rows()[3]!, pid: 10, ppid: 1 }]))?.process.pid).toBe(10);
  });
  it.each([
    `resume ${token} --add-dir /Users/me/code/Bob's app`,
    `resume --add-dir /Users/me/code/Bob's-app ${token}`,
    `resume ${token} What's next?`,
    `resume ${token} --add-dir /Users/me/code/review"app`,
  ])("preserves literal quote characters in Codex resume argv: %s", async args => {
    const list = () => rows().map(r => r.pid === 13 ? codexCommand(r, `/opt/native/codex ${args}`) : r);
    expect((await check(list))?.process.pid).toBe(13);
    expect(await check(list, { expectedToken: "different" })).toBeNull();
  });
  it("observes a fresh Codex launch into an apostrophe path", async () => {
    const list = () => rows().map(r => r.pid === 13
      ? codexCommand(r, "/opt/native/codex -C /Users/me/code/Bob's-app") : r);
    expect((await check(list, { requireResume: false }))?.process.pid).toBe(13);
    expect(await check(list)).toBeNull();
  });
  it("distinguishes fresh/non-strict runtime proof from exact resume", async () => {
    const fresh = () => rows().map(r => r.pid === 13 ? codexCommand(r, "/opt/native/codex -m model") : r);
    expect(await check(fresh)).toBeNull();
    expect(await check(fresh, { requireResume: false })).not.toBeNull();
    expect(await check(rows, { requireResume: false, expectedToken: "different" })).toBeNull();
    expect(await check(rows, { requireResume: true, expectedToken: null })).toBeNull();
    expect(await check(rows, { requireResume: false, expectedToken: null })).toBeNull();
    expect(await check(() => rows().map(r => r.pid === 13 ? codexCommand(r, "/opt/native/codex resume --last") : r), { requireResume: false, expectedToken: null })).toBeNull();
  });
  const controls: [string, (r: NativeProcessRow[]) => NativeProcessRow[]][] = [
    ["wrong UUID", r => r.map(x => x.pid === 13 ? codexCommand(x, "/opt/native/codex resume other") : x)],
    ["missing UUID", r => r.map(x => x.pid === 13 ? codexCommand(x, "/opt/native/codex resume") : x)],
    ["token only in prompt", r => r.map(x => x.pid === 13 ? codexCommand(x, `/opt/native/codex resume other ${token}`) : x)],
    ["wrong OS executable", r => r.map(x => x.pid === 13 ? { ...x, executableName: "printf" } : x)],
    ["argv-only executable", r => r.map(x => x.pid === 13 ? codexCommand(x, `/bin/echo codex resume ${token}`) : x)],
    ["unrelated descendant", r => r.map(x => x.pid === 13 ? { ...x, ppid: 999 } : x)],
    ["background native", r => r.map(x => x.pid === 13 ? { ...x, pgid: 99 } : x)],
    ["conflicting foreground", r => r.map(x => x.pid === 13 ? { ...x, tpgid: 99 } : x)],
    ["missing root", r => r.slice(1)],
    ["missing ancestry", r => r.filter(x => x.pid !== 11)],
    ["cyclic ancestry", r => r.map(x => x.pid === 11 ? { ...x, ppid: 13 } : x)],
    ["multiple native candidates", r => [...r, { ...r[3]!, pid: 14 }]],
    ["duplicate PID", r => [...r, r[3]!]],
    ["missing start time", r => r.map(x => ({ ...x, startedAt: undefined }))],
    ["missing group", r => r.map(x => ({ ...x, tpgid: undefined }))],
    ["exited native", r => r.filter(x => x.pid !== 13)],
  ];
  it.each(controls)("refuses %s", async (_name, mutate) => {
    expect(await check(() => mutate(rows()))).toBeNull();
  });
  it.each(["startedAt", "command", "ppid", "pgid"] as const)("refuses a changed native %s between observations", async (field) => {
    const changed = rows().map(r => r.pid === 13 ? { ...r, [field]: field === "startedAt" ? "Sat Jan  1 12:00:01 2000" : field === "command" ? r.command + " --verbose" : 99 } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(rows()).mockResolvedValueOnce(changed))).toBeNull();
  });
  it("refuses a reused pane PID even when the native PID is unchanged", async () => {
    const changed = rows().map(r => r.pid === 10 ? { ...r, startedAt: "Sat Jan  1 12:00:01 2000" } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(rows()).mockResolvedValueOnce(changed))).toBeNull();
  });
  it("refuses a changed or missing pane and process observation failures", async () => {
    expect(await check(rows, { tmux: { getPanePid: vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(11) } })).toBeNull();
    expect(await check(rows, { tmux: { getPanePid: async () => null } })).toBeNull();
    expect(await check(async () => { throw new Error("ps failed"); })).toBeNull();
  });
  it("retains the existing Claude exact-token contract", () => {
    expect(findExactNativeResumeProcess([{ pid: 10, ppid: 1, command: `claude --resume ${token}` }], 10, "claude-code", token)?.pid).toBe(10);
    expect(findExactNativeResumeProcess([{ pid: 10, ppid: 1, command: "claude --resume wrong" }], 10, "claude-code", token)).toBeNull();
  });
  // #1080 maintainer review of 6e36b94d: a recorded rotation proves only with no Claude, of any
  // runtime shape, beneath the launched process in its foreground.
  it("refuses a recorded rotation with any shape of Claude beneath it in the foreground", () => {
    const rotated = "00000000-0000-4000-8000-000000001077";
    const startedAt = "Thu Oct  1 05:53:16 2026";
    const rotation = { token, process: { pid: 10, startedAt } };
    const top = { pid: 10, ppid: 1, pgid: 10, tpgid: 10, executableName: "claude", command: `claude --resume ${token}`, startedAt };
    const find = (child?: NativeProcessRow) => findExactNativeResumeProcess(child ? [top, child] : [top], 10, "claude-code", rotated, rotation)?.pid ?? null;
    expect(find()).toBe(10);
    const beneath = { pid: 11, ppid: 10, pgid: 10 };
    for (const child of [
      { ...beneath, executableName: "node", command: "node /usr/local/bin/claude --resume other" },
      { ...beneath, executableName: "node", command: "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi" },
      { ...beneath, executableName: "node", command: "node --no-warnings /usr/local/bin/claude --resume other" },
      { ...beneath, executableName: "node", command: "node -r ./preload.cjs --max-old-space-size=4096 -- /usr/local/bin/claude --resume other" },
      // Node's options are not parsed, so a value option the guard does not know cannot hide Claude
      // (maintainer, against 8208c721), and a claude path given to -r or after -e refuses too.
      { ...beneath, executableName: "node", command: "node --max-old-space-size 8192 /usr/local/bin/claude --session-id other" },
      { ...beneath, executableName: "node", command: "node --diagnostic-dir /tmp/d /usr/local/bin/claude --session-id other" },
      { ...beneath, executableName: "node", command: "node --stack-size 4000 /usr/lib/node_modules/@anthropic-ai/claude-code/cli.mjs" },
      { ...beneath, executableName: "node", command: "node -r /usr/local/bin/claude relay.cjs" },
      { ...beneath, executableName: "node", command: "node --no-warnings -e 1 /usr/local/bin/claude" },
      { ...beneath, command: "claude --resume other" },
      { pid: 11, ppid: 10, command: "/opt/claude.exe --resume other" },
    ]) expect(find(child), child.command).toBeNull();
    // Not Claude, or not in the foreground: the launched process still proves.
    expect(find({ ...beneath, executableName: "node", command: "node relay.cjs" })).toBe(10);
    expect(find({ ...beneath, executableName: "node", command: "node -e 'require(\"/usr/local/bin/claude\")'" })).toBe(10);
    expect(find({ pid: 11, ppid: 10, pgid: 11, executableName: "claude", command: "claude mcp serve" })).toBe(10);
  });

  // A foreground group of -1 or 0 (no controlling terminal) is unknown, not a group no child is in.
  it("refuses a recorded rotation over a Claude child when the launched process's foreground group reads -1 or 0", () => {
    const rotated = "00000000-0000-4000-8000-000000001077";
    const startedAt = "Thu Oct  1 05:53:16 2026";
    const rotation = { token, process: { pid: 10, startedAt } };
    const child = { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "claude", command: "claude --resume other", startedAt };
    for (const tpgid of [-1, 0]) {
      const top = { pid: 10, ppid: 1, pgid: 10, tpgid, executableName: "claude", command: `claude --resume ${token}`, startedAt };
      expect(findExactNativeResumeProcess([top, child], 10, "claude-code", rotated, rotation)?.pid ?? null, String(tpgid)).toBeNull();
      expect(findExactNativeResumeProcess([top], 10, "claude-code", rotated, rotation)?.pid ?? null, String(tpgid)).toBe(10);
    }
  });
});

describe("observeClaudePaneStartedAt", () => {
  const claudeStart = "Fri Oct  2 11:00:00 2026";
  const claudeRows = (extra: NativeProcessRow[] = []): NativeProcessRow[] => [
    { pid: 20, ppid: 1, pgid: 20, tpgid: 21, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 21, ppid: 20, pgid: 21, tpgid: 21, executableName: "claude", command: "claude --name seat@rig", startedAt: claudeStart },
    ...extra,
  ];
  const observe = (list: NativeProcessRow[], panePid: number | null = 20) =>
    observeClaudePaneStartedAt({ target: "seat@rig", tmux: { getPanePid: async () => panePid }, listProcesses: () => list });

  it("returns the start time of the one Claude process in the pane's foreground, without a token", async () => {
    expect(await observe(claudeRows())).toBe(claudeStart);
  });

  it("is unknown when the pane, the process or a single candidate cannot be established", async () => {
    expect(await observe(claudeRows(), null)).toBeNull();
    expect(await observe(claudeRows().slice(0, 1))).toBeNull();
    expect(await observe(claudeRows([{ pid: 22, ppid: 20, pgid: 21, tpgid: 21, executableName: "claude", command: "claude", startedAt: claudeStart }]))).toBeNull();
  });
});

describe("Claude identity with inline settings in ps output", () => {
  const settings = [
    ["kernel", operationalLaunchArgs("claude-code", { kernelAuthority: true })[1]!],
    ["team", operationalLaunchArgs("claude-code", { teamPermissionDefault: true })[1]!],
    ["escaped quotes and hooks", JSON.stringify({
      permissions: { allow: ["Bash(npm run test:*)"] },
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: 'node "/fixture with spaces/check.cjs" --label "it\'s fine"', timeout: 5 }] }] },
    })],
  ];
  function input(args: string) {
    const list = [
      { pid: 20, ppid: 1, pgid: 20, tpgid: 21, executableName: "zsh", command: "-zsh", startedAt },
      { pid: 21, ppid: 20, pgid: 21, tpgid: 21, executableName: "claude",
        command: `claude --permission-mode acceptEdits ${args} --name seat@rig`, startedAt },
    ];
    return { target: "%1", tmux: { getPanePid: async () => 20 }, listProcesses: async () => list, expectedToken: token };
  }
  for (const [name, value] of settings) {
    for (const flag of ["--session-id", "--resume"]) {
      it.each(["before", "after"])(`${name}: ${flag} %s settings stays exact for identity and delivery`, async order => {
        // ps joins argv without putting shell quotes around the JSON argument.
        const identity = `${flag} ${token}`, option = `--settings ${value}`;
        const args = order === "before" ? `${identity} ${option}` : `${option} ${identity}`;
        const actual = input(args);
        expect((await verifyClaudePaneProcess(actual))?.process.pid).toBe(21);
        expect((await observeClaudeDelivery(actual)).state).toBe("verified");
        expect(await verifyClaudePaneProcess({ ...actual, expectedToken: "different" })).toBeNull();
        expect((await observeClaudeDelivery({ ...actual, expectedToken: "different" })).state).toBe("unknown");
      });
    }
  }
  it.each([
    `--settings="/fixture/settings with spaces.json" --session-id ${token}`,
    `--settings {"label":"two words"} --resume ${token}`,
    `--settings={"label":"two words"} --session-id=${token}`,
    `--settings /fixture/settings.json --session-id ${token}`,
    `--settings /fixture/review's-settings.json --session-id ${token}`,
    `--settings /fixture/review"settings.json --session-id ${token}`,
  ])("accepts inline and file settings: %s", async args => {
    expect((await verifyClaudePaneProcess(input(args)))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(input(args))).state).toBe("verified");
    expect(await verifyClaudePaneProcess({ ...input(args), expectedToken: "different" })).toBeNull();
  });
  it.each([
    `--remote-control orch.lead@rig --session-id ${token}`,
    `--session-id ${token} --remote-control orch.lead@rig`,
    `--remote-control=orch.lead@rig --resume ${token}`,
  ])("proves the exact Claude identity with the launch-only Remote Control option: %s", async args => {
    const actual = input(args);
    expect((await verifyClaudePaneProcess(actual))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(actual)).state).toBe("verified");
    expect(await verifyClaudePaneProcess({ ...actual, expectedToken: "different" })).toBeNull();
    expect((await observeClaudeDelivery({ ...actual, expectedToken: "different" })).state).toBe("unknown");
  });
  it.each([
    `--advisor opus --session-id ${token}`,
    `--resume ${token} --advisor claude-opus-5-5`,
    `--advisor=opus --session-id=${token}`,
    `--resume=${token} --advisor=opus`,
    `--advisor opus --agent openrig:reviewer --append-system-prompt-file /home/u/.openrig/state/seats/r/dev.impl/claude-code/additions/system-prompt.md --resume ${token}`,
  ])("Advisor leaves the exact primary conversation verifiable: %s", async args => {
    const actual = input(args);
    expect((await verifyClaudePaneProcess(actual))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(actual)).state).toBe("verified");
    expect(await verifyClaudePaneProcess({ ...actual, expectedToken: "different" })).toBeNull();
    expect((await observeClaudeDelivery({ ...actual, expectedToken: "different" })).state).toBe("unknown");
  });
  it.each([
    `--session-id ${token} --advisor`,
    `--advisor --session-id ${token}`,
    `--session-id ${token} --advisor=`,
    `--session-id ${token} --advisor=--resume`,
    `--advisor opus --resume ${token} --fork-session`,
  ])("malformed Advisor or a fork's parent cannot prove the current identity: %s", async args => {
    expect(await verifyClaudePaneProcess(input(args))).toBeNull();
    expect((await observeClaudeDelivery(input(args))).state).not.toBe("verified");
  });
  it("preserves an apostrophe in the native Claude executable path", async () => {
    const actual = input(`--settings ${settings[0]![1]} --session-id ${token}`);
    const list = (await actual.listProcesses()).map(r => r.pid === 21 ? { ...r,
      executableName: "2.1.1", command: r.command.replace(/^claude/, "/home/o'neil/.local/share/claude/versions/2.1.1"),
    } : r);
    const native = { ...actual, listProcesses: async () => list };
    expect((await verifyClaudePaneProcess(native))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(native)).state).toBe("verified");
    expect(await verifyClaudePaneProcess({ ...native, expectedToken: "different" })).toBeNull();
  });
  it.each([
    `--settings ${JSON.stringify({ label: `two words --session-id ${token}` })}`,
    `--settings {"env":{"note":"text --session-id ${token} --model trailing`,
    `--settings ${settings[0]![1]} --session-id ${token} --session-id different`,
    `--settings ${settings[1]![1]} --session-id ${token} --unknown`,
  ])("does not promote ambiguous argv: %s", async args => {
    expect(await verifyClaudePaneProcess(input(args))).toBeNull();
    expect((await observeClaudeDelivery(input(args))).state).not.toBe("verified");
  });
  it.each([
    `--resume ${parent} --fork-session --session-id ${token}`,
    `--fork-session --session-id=${token} --resume=${parent}`,
  ])("a fork that names its own --session-id proves the fork, never its parent: %s", async args => {
    const actual = input(args);
    expect((await verifyClaudePaneProcess(actual))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(actual)).state).toBe("verified");
    expect(findExactNativeResumeProcess(await actual.listProcesses(), 20, "claude-code", token)?.pid).toBe(21);
    expect(await verifyClaudePaneProcess({ ...actual, expectedToken: parent })).toBeNull();
    expect((await observeClaudeDelivery({ ...actual, expectedToken: parent })).state).toBe("unknown");
  });
  it.each([
    `--resume ${token} --fork-session`,
    `--fork-session --session-id ${token}`,
    `--resume ${parent} --session-id ${token}`,
    `--resume ${parent} --fork-session --session-id ${token} --session-id other`,
  ])("still refuses a fork without its own id or its parent, and two identities without --fork-session: %s", async args => {
    expect(await verifyClaudePaneProcess(input(args))).toBeNull();
    expect((await observeClaudeDelivery(input(args))).state).not.toBe("verified");
  });
  it.each(["before", "after"])("a literal quote %s settings never promotes settings text into identity", async order => {
    const settings = `--settings ${JSON.stringify({ env: { REVIEW_NOTE: `text --session-id ${token} --model trailing` } })}`;
    const name = '--name review"desk';
    const args = order === "before" ? `${name} ${settings}` : `${settings} ${name}`;
    expect(await verifyClaudePaneProcess(input(args))).toBeNull();
    expect((await observeClaudeDelivery(input(args))).state).toBe("unknown");
    const actualIdentity = input(`${args} --session-id ${token}`);
    expect((await verifyClaudePaneProcess(actualIdentity))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(actualIdentity)).state).toBe("verified");
    expect(await verifyClaudePaneProcess({ ...actualIdentity, expectedToken: "different" })).toBeNull();
  });
  // OPR.0.7.0.9: a seat's own launch additions are value-taking flags; identity proof must still hold. `ps` joins argv
  // with spaces, so a prompt file path with ordinary spaces runs to the next `--` option. OpenRig launches only a path
  // that reads back that way (its launch-time check), so a path holding a `--` or `{` token proves nothing here.
  const spaced = "/home/u/Library/Application Support/openrig/state/seats/r/dev.impl/claude-code/additions/system-prompt.md";
  it.each([
    `--agent openrig:reviewer --session-id ${token}`,
    `--append-system-prompt-file /home/u/.openrig/state/seats/r/dev.impl/claude-code/additions/system-prompt.md --resume ${token}`,
    `--append-system-prompt-file ${spaced} --session-id ${token}`,
    `--append-system-prompt-file ${spaced} --resume ${token}`,
    `--agent openrig:a --append-system-prompt-file ${spaced} --resume parent-1 --fork-session --session-id ${token}`,
    `--model opus --append-system-prompt-file /seat/additions/system-prompt.md --agent openrig:a --effort high --session-id ${token}`,
    `--agent=openrig:reviewer --append-system-prompt-file=/fixture/prompt.md --session-id=${token}`,
  ])("proves identity with a seat's launch additions: %s", async args => {
    const actual = input(args);
    expect((await verifyClaudePaneProcess(actual))?.process.pid).toBe(21);
    expect((await observeClaudeDelivery(actual)).state).toBe("verified");
    expect(await verifyClaudePaneProcess({ ...actual, expectedToken: "different" })).toBeNull();
  });
  it.each([
    `--agent --session-id ${token}`,
    `--append-system-prompt-file --session-id ${token}`,
    `--plugin-dir /fixture/plugin --session-id ${token}`,
    `--append-system-prompt-file /tmp/Backup -- 2026/additions/system-prompt.md --session-id ${token}`,
    `--append-system-prompt-file /tmp/team --unexpected part/additions/system-prompt.md --session-id ${token}`,
    `--append-system-prompt-file /tmp/a {b}/additions/system-prompt.md --session-id ${token}`,
    `--agent openrig:two words --session-id ${token}`,
    `--agent -openrig --session-id ${token}`,
  ])("proves nothing for a missing, unbounded or malformed value, or a flag OpenRig doesn't emit: %s", async args => {
    expect(await verifyClaudePaneProcess(input(args))).toBeNull();
    expect((await observeClaudeDelivery(input(args))).state).not.toBe("verified");
  });
});

describe("observeClaudeDelivery's idle-shell policy: delivery versus launch", () => {
  const startedAt = "Fri Oct 9 07:00:00 2026";
  const shell: NativeProcessRow = { pid: 10, ppid: 1, pgid: 10, tpgid: 10, command: "/bin/bash", executableName: "bash", startedAt };
  // A foreground wrapper starting between the two samples: its own group now owns the terminal.
  const starting: NativeProcessRow[] = [{ ...shell, tpgid: 12 }, { pid: 12, ppid: 10, pgid: 12, tpgid: 12, command: "bash ./start-agent.sh", executableName: "bash", startedAt }];
  const input = (...samples: NativeProcessRow[][]) => {
    let call = 0;
    return { target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses: async () => samples[Math.min(call++, samples.length - 1)]! };
  };

  it("delivery keeps a positive idle shell when the other sample is unknown", async () => {
    expect((await observeClaudeDelivery(input([shell], starting))).state).toBe("idle_shell");
  });

  it("launch needs both samples idle with the same fingerprint, so a starting foreground reads unknown", async () => {
    expect((await observeClaudeDelivery(input([shell], starting), { unknownKeepsIdle: false })).state).toBe("unknown");
    expect((await observeClaudeDelivery(input(starting, [shell]), { unknownKeepsIdle: false })).state).toBe("unknown");
    expect((await observeClaudeDelivery(input([shell], [shell]), { unknownKeepsIdle: false })).state).toBe("idle_shell");
  });
});

// #1079: a `codex` launcher that spawns (not execs) Codex, which spawns its native
// child, as in the report: pane -> sh -> codex (launcher) -> codex -> codex (native).
describe("Codex behind a spawning launcher", () => {
  const launcherRows = (launcher = "", middle = "", native = ""): NativeProcessRow[] => [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "sh", command: "sh /tmp/openrig-tmux-send.txt", startedAt },
    codexCommand({ pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: "codex", command: "", startedAt },
      `codex ${launcher}--no-daemon -s workspace-write -c check_for_update_on_startup=false`.trim()),
    codexCommand({ pid: 13, ppid: 12, pgid: 11, tpgid: 11, executableName: "codex", command: "", startedAt },
      `codex ${middle}--no-daemon -s workspace-write`.trim()),
    codexCommand({ pid: 14, ppid: 13, pgid: 11, tpgid: 11, executableName: "codex", command: "", startedAt },
      `codex ${native}-c model_provider=local`.trim()),
  ];
  const resume = `resume ${token} `;

  it("resolves the reporter's fresh three-level chain to the deepest Codex", async () => {
    expect((await check(() => launcherRows(), { requireResume: false }))?.process.pid).toBe(14);
    expect((await check(() => launcherRows(), { requireResume: false, expectedToken: null }))?.process.pid).toBe(14);
  });
  it("delivers to a child that names no identity under a launcher's resume, but never proves it", async () => {
    expect((await check(() => launcherRows(resume), { requireResume: false }))?.process.pid).toBe(14);
    expect(await check(() => launcherRows(resume))).toBeNull();
    expect(await check(() => launcherRows(resume, resume))).toBeNull();
    expect(findExactNativeResumeProcess(launcherRows(resume), 10, "codex", token)).toBeNull();
    expect(await check(() => launcherRows(resume), { requireResume: false, expectedToken: "different" })).toBeNull();
    expect(await check(() => launcherRows(resume), { requireResume: false, expectedToken: null })).toBeNull();
  });
  it("proves a chain whose deepest Codex names the expected conversation", async () => {
    expect((await check(() => launcherRows(resume, resume, resume)))?.process.pid).toBe(14);
    expect((await check(() => launcherRows("", "", resume)))?.process.pid).toBe(14);
    expect(findExactNativeResumeProcess(launcherRows(resume, resume, resume), 10, "codex", token)?.pid).toBe(14);
  });
  it("keeps exact resume strict across the chain", async () => {
    expect(await check(() => launcherRows())).toBeNull();
    expect(await check(() => launcherRows(resume, "resume other "))).toBeNull();
    expect(await check(() => launcherRows(resume, "", "resume --last "))).toBeNull();
    // A deeper `resume --last` is read before the launcher's token, whatever the ps row order.
    const deeperLast = () => launcherRows(resume).map(r => r.pid === 13 ? codexCommand(r, "codex resume --last") : r);
    expect(await check(deeperLast)).toBeNull();
    expect(await check(() => deeperLast().reverse())).toBeNull();
  });
  it("still refuses Codex processes on different branches", async () => {
    const siblings = (r: NativeProcessRow[]) => [...r, { ...r[4]!, pid: 15 }];
    expect(await check(() => siblings(launcherRows()), { requireResume: false })).toBeNull();
    const twoNatives = launcherRows().filter(r => r.pid !== 14).concat({ ...launcherRows()[3]!, pid: 15, ppid: 12 });
    expect(await check(() => twoNatives, { requireResume: false })).toBeNull();
  });
  it("still refuses a non-Codex foreground", async () => {
    expect(await check(() => launcherRows().map(r => r.pid >= 12 ? { ...r, executableName: "node" } : r), { requireResume: false })).toBeNull();
  });
  it("refuses when a launcher link changes between observations", async () => {
    const changed = launcherRows().map(r => r.pid === 12 ? { ...r, startedAt: "Sat Jan  1 12:00:01 2000" } : r);
    expect(await check(vi.fn().mockResolvedValueOnce(launcherRows()).mockResolvedValueOnce(changed), { requireResume: false })).toBeNull();
  });
});

// #1091: Claude's strict finder rejects a shallower token only when a deeper, verified Claude
// runtime in the same chain positively names another conversation (Root's option (b)).
describe("Claude exact-resume finder behind a spawning launcher", () => {
  const other = "00000000-0000-7000-8000-00000000000f";
  const find = (rows: NativeProcessRow[]) => findExactNativeResumeProcess(rows, 10, "claude-code", token)?.pid ?? null;
  // A verified Claude binary (argv0 and OS name claude) on the token, over one child.
  const realRows = (child: string, childName = "claude"): NativeProcessRow[] => [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "zsh", command: "-zsh", startedAt },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "claude", command: `claude --resume ${token} --name dev@rig`, startedAt },
    { pid: 12, ppid: 11, pgid: 11, tpgid: 11, executableName: childName, command: child, startedAt },
  ];
  // A script launcher: ps shows the interpreter as argv0, so it is not a verified Claude runtime.
  const scriptRows = (child: string) => realRows(child).map(r => r.pid === 11
    ? { ...r, command: `/bin/sh /shim/claude --resume ${token} --name dev@rig` } : r);
  // #563/#567 company-launcher model: three claude processes; the real Claude names no token.
  const companyRows = (): NativeProcessRow[] => [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh /fixture/launch", startedAt },
    { pid: 102, ppid: 101, pgid: 101, tpgid: 101, executableName: "claude", command: `/opt/claude --permission-mode auto --session-id ${token} --name test-c@native-test`, startedAt },
    { pid: 104, ppid: 102, pgid: 101, tpgid: 101, executableName: "claude", command: `/shim/bin/claude --permission-mode auto --session-id ${token} --name test-c@native-test`, startedAt },
    { pid: 105, ppid: 104, pgid: 101, tpgid: 101, executableName: "claude", command: "/shim/claude --settings /shim/settings.json --permission-mode auto", startedAt },
  ];

  it("keeps main's proof for the company-launcher model (opaque real Claude)", () => {
    // Proved as on main; the evidence names 104, the deepest link that names the token.
    expect(findExactNativeResumeProcess(companyRows(), 100, "claude-code", token)?.pid).toBe(104);
  });
  it.each([
    ["ripgrep with a claude pattern", "rg", "rg -n claude src"],
    ["ugrep with a token-like argument", "ugrep", `ugrep -n claude --session-id ${other} file.ts`],
    ["claude mcp serve", "claude", "claude mcp serve"],
  ])("a helper child (%s) neither suppresses nor becomes the proof", (_name, comm, command) => {
    expect(find(realRows(command, comm))).toBe(11);
  });
  it("refuses a script launcher's token over a verified child on another conversation", () => {
    expect(find(scriptRows(`claude --session-id ${other}`))).toBeNull();
  });
  it("keeps main's proof for an opaque child under a script launcher", () => {
    expect(find(scriptRows("claude --settings /shim/settings.json"))).toBe(11);
  });
  it("attributes proof to a child that names the token", () => {
    expect(find(realRows(`claude --session-id ${token}`))).toBe(12);
    expect(find(scriptRows(`claude --resume ${token}`))).toBe(12);
  });
  // Limit: ps cannot tell a launcher binary over the real Claude on Y from a real Claude on X
  // that started a child Claude on Y, so a verified Claude on the token keeps main's proof.
  it("keeps a verified Claude's proof when it starts a child Claude on another conversation", () => {
    expect(find(realRows(`claude --session-id ${other}`))).toBe(11);
  });
  it("keeps main's result without process groups, through a shell, or in another group", () => {
    expect(find(scriptRows(`claude --session-id ${other}`).map(({ pid, ppid, command, executableName }) => ({ pid, ppid, command, executableName })))).toBe(11);
    const viaShell = scriptRows(`claude --session-id ${other}`).flatMap(r => r.pid === 12
      ? [{ ...r, pid: 13, executableName: "bash", command: `/bin/bash -c claude --session-id ${other}` }, { ...r, ppid: 13 }] : [r]);
    expect(find(viaShell)).toBe(11);
    expect(find(scriptRows(`claude --session-id ${other}`).map(r => r.pid === 12 ? { ...r, pgid: 99 } : r))).toBe(11);
  });
  // #1091 round 3.
  it("does not count a grandchild of an intermediate Claude runtime against the launcher", () => {
    const rows = scriptRows("claude --settings /shim/settings.json");
    rows.push({ ...rows[2]!, pid: 13, ppid: 12, command: `claude --session-id ${other}` });
    expect(find(rows)).toBe(11);
  });
  const helper = (pid: number, args: string): NativeProcessRow =>
    ({ pid, ppid: 11, pgid: 11, tpgid: 11, executableName: "ugrep", command: `ugrep -n claude ${args} file.ts`, startedAt });
  it("returns the exact Claude child, never a helper, whatever the row order", () => {
    const base = scriptRows(`claude --resume ${token}`);
    const withHelper = [...base.slice(0, 2), helper(9, `--session-id ${token}`), base[2]!];
    expect(find(withHelper)).toBe(12);
    expect(find([...withHelper].reverse())).toBe(12);
    expect(find([...base, helper(13, `--session-id ${token}`)])).toBe(12);
  });
  it("refuses a script on X with a helper on X over a real Claude on Y", () => {
    const rows = [...scriptRows(`claude --session-id ${other}`), helper(9, `--session-id ${token}`)];
    expect(find(rows)).toBeNull();
    expect(find([...rows].reverse())).toBeNull();
  });
  it("keeps the pane root as the proof when the root Claude has an exact child", () => {
    const rows = realRows(`claude --session-id ${token}`);
    expect(findExactNativeResumeProcess(rows, 11, "claude-code", token)?.pid).toBe(11);
  });
  // #1091 round 4: parents main already accepts as Claude keep main's result.
  it("keeps main's proof for a Node-run Claude or an older Claude row over a child on another conversation", () => {
    const nodeRun = realRows(`claude --session-id ${other}`).map(r => r.pid === 11
      ? { ...r, executableName: "node", command: `node /usr/local/bin/claude --resume ${token}` } : r);
    expect(find(nodeRun)).toBe(11);
    const older = realRows(`claude --session-id ${other}`).map(r => r.pid === 11
      ? { pid: r.pid, ppid: r.ppid, pgid: r.pgid, tpgid: r.tpgid, command: r.command, startedAt } : r);
    expect(find(older)).toBe(11);
    expect(find(scriptRows(`claude --session-id ${other}`))).toBeNull();
    // A Node-shaped argv whose OS executable is a shell is not Node-hosted Claude.
    expect(find(nodeRun.map(r => r.pid === 11 ? { ...r, executableName: "bash" } : r))).toBeNull();
  });
  it.each([
    ["ugrep", `ugrep -n claude --session-id ${token} file.ts`],
    ["rg", `rg claude --resume ${token}`],
  ])("never treats a token-shaped helper (%s) as a runtime parent", (comm, command) => {
    const rows = realRows(`claude --session-id ${other}`).map(r => r.pid === 11 ? { ...r, executableName: comm, command } : r);
    expect(find(rows)).toBeNull();
  });
  it("leaves a --fork-session child that names only its parent as on main", () => {
    expect(find(scriptRows(`claude --resume ${token} --fork-session`))).toBe(11);
  });
  const forkChild = `claude --resume ${token} --fork-session --session-id ${other} --name dev@rig`;
  it("refuses a script launcher's token over its Claude fork child naming the fork's own id", () => {
    expect(find(scriptRows(forkChild))).toBeNull();
  });
  it("keeps a real Claude's proof when it starts a fork of its conversation", () => {
    expect(find(realRows(forkChild))).toBe(11);
  });
  const delivery = (rows: NativeProcessRow[], expectedToken: string) => observeClaudeDelivery({
    target: "%1", tmux: { getPanePid: async () => 10 }, listProcesses: async () => rows, expectedToken,
  });
  it.each([["the parent's", token], ["the fork's", other]])(
    "delivery to a Claude with its fork in the foreground warns and sends with %s token stored, verifying neither", async (_label, stored) => {
      const observed = await delivery(realRows(forkChild), stored);
      expect(observed.state).toBe("unknown");
      expect(observed.detail).toContain("fork");
    });
  it("delivery still reports a conflict when two Claude processes name different conversations without a fork", async () => {
    expect((await delivery(realRows(`claude --session-id ${other} --name dev@rig`), token)).state).toBe("conflict");
  });
});
