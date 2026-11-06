import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildPermissionStopDescriptor: describeStop, buildPermissionRuleSuggestions: describeRules } = require(
  "../assets/plugins/openrig-core/hooks/scripts/permission-stop-descriptor.cjs",
) as { buildPermissionStopDescriptor: (input: unknown) => string;
  buildPermissionRuleSuggestions: (input: unknown) => { state: string; entries: unknown[]; unsupported: boolean; size_cut: boolean } };

const tools = ["git", "npm", "node", "python3", "ls", "pwd", "cat", "sed", "find", "echo", "printf"];
const generic = "Tool: details withheld";
const shell = "Bash: details withheld";
const bash = (command: unknown) => ({ tool_name: "Bash", tool_input: { command } });

describe("read-only Claude suggested rule evidence", () => {
  it.each([
    ["addRules", "allow", "session"], ["replaceRules", "deny", "localSettings"],
    ["removeRules", "ask", "projectSettings"], ["addRules", "allow", "userSettings"],
  ])("preserves %s/%s/%s and ordered optional rule content as given", (type, behavior, destination) => {
    const entry = { type, rules: [{ toolName: "Bash", ruleContent: "  SYNTHETIC_RULE(*)\t " },
      { toolName: "Read" }, { toolName: "Edit", ruleContent: "" }], behavior, destination };
    const input = { permission_suggestions: [entry], tool_input: { command: "SYNTHETIC_SECRET" }, reason: "SYNTHETIC_SECRET" };
    const before = JSON.stringify(input);
    expect(describeRules(input)).toEqual({ state: "present", entries: [entry], unsupported: false, size_cut: false });
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(describeRules(input))).not.toContain("SYNTHETIC_SECRET");
  });

  it("distinguishes missing from present-empty suggestions", () => {
    expect(describeRules({})).toEqual({ state: "missing", entries: [], unsupported: false, size_cut: false });
    expect(describeRules({ permission_suggestions: [] })).toEqual({ state: "present", entries: [], unsupported: false, size_cut: false });
    expect(describeRules({ permission_suggestions: null })).toEqual({ state: "present", entries: [], unsupported: true, size_cut: false });
  });

  it.each([
    { type: "setMode", mode: "auto", destination: "session" },
    { type: "addDirectories", directories: ["SYNTHETIC_PATH"], destination: "session" },
    { type: "removeDirectories", directories: [], destination: "session" },
    { type: "futureUpdate" }, { type: "addRules", rules: [], behavior: "allow" },
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: null }], behavior: "allow", destination: "session" },
    { type: "addRules", rules: [], behavior: "allow", destination: "session", unknown: "SYNTHETIC_SECRET" },
  ])("marks unsupported/malformed entries without inventing a supported rule (case %#)", entry => {
    expect(describeRules({ permission_suggestions: [entry] })).toEqual({
      state: "present", entries: [], unsupported: true, size_cut: false,
    });
  });

  it.each([
    { rules: [{ toolName: "x".repeat(129) }] },
    { rules: [{ toolName: "Bash", ruleContent: "x".repeat(2049) }] },
    { rules: Array.from({ length: 17 }, () => ({ toolName: "Read" })) },
  ])("drops an entire oversized entry rather than truncating it into a rule (case %#)", extra => {
    const entry = { type: "replaceRules", behavior: "deny", destination: "projectSettings", ...extra };
    expect(describeRules({ permission_suggestions: [entry] })).toEqual({
      state: "present", entries: [], unsupported: false, size_cut: true,
    });
  });

  it("bounds entries and serialized UTF-8 bytes while preserving retained strings", () => {
    const entry = { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "ask", destination: "session" };
    expect(describeRules({ permission_suggestions: Array(9).fill(entry) })).toEqual({
      state: "present", entries: Array(8).fill(entry), unsupported: false, size_cut: true,
    });
    const large = { ...entry, rules: [{ toolName: "Bash", ruleContent: "é".repeat(2048) }] };
    const bounded = describeRules({ permission_suggestions: Array(8).fill(large) });
    expect(bounded.size_cut).toBe(true);
    expect(bounded.unsupported).toBe(false);
    expect(bounded.entries.length).toBeGreaterThan(0);
    expect(bounded.entries.length).toBeLessThan(8);
    expect(bounded.entries.every(item => JSON.stringify(item) === JSON.stringify(large))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(16384);
  });
});

describe("permission stop descriptor privacy boundary", () => {
  it("rejects the whole oversized command rather than accepting its allowed prefix", () => {
    expect(describeStop(bash("git " + "x".repeat(508)))).toBe("Bash: git [arguments hidden]");
    expect(describeStop(bash("git " + "x".repeat(509)))).toBe(shell);
    expect(describeStop(bash(" \t  "))).toBe(shell);
  });

  it.each([
    ["Read", "Tool: Read"], ["Write", "Tool: Write"], ["Edit", "Tool: Edit"],
    ["MultiEdit", "Tool: MultiEdit"], ["NotebookEdit", "Tool: NotebookEdit"],
    ["Glob", "Tool: Glob"], ["Grep", "Tool: Grep"], ["LS", "Tool: LS"],
    ["WebFetch", "Tool: WebFetch"], ["WebSearch", "Tool: WebSearch"], ["Skill", "Tool: Skill"],
    ["Task", "Tool: Task"], ["TodoWrite", "Tool: TodoWrite"],
  ])("uses a fixed descriptor for known tool %s", (tool_name, expected) => {
    expect(describeStop({ tool_name, tool_input: { path: "/SYNTHETIC_SECRET", url: "https://user:SECRET@example.invalid" },
      reason: "SYNTHETIC_SECRET" })).toBe(expected);
    expect(describeStop({ tool_name, tool_input: [] })).toBe(generic);
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])("does not treat prototype key %s as a known tool", tool_name => {
    expect(describeStop({ tool_name })).toBe(generic);
    expect(describeStop(bash(tool_name))).toBe(shell);
  });

  it("supports JSON-like null-prototype inputs and withholds throwing accessors", () => {
    const input = Object.assign(Object.create(null), { tool_name: "Bash",
      tool_input: Object.assign(Object.create(null), { command: "git status" }) });
    expect(describeStop(input)).toBe("Bash: git [arguments hidden]");
    expect(describeStop(Object.create({ tool_name: "Bash", tool_input: { command: "git" } }))).toBe(generic);
    expect(describeStop({ get tool_name() { throw new Error("SYNTHETIC_SECRET"); } })).toBe(generic);
    expect(describeStop({ tool_name: "Bash", tool_input: { get command() { throw new Error("SYNTHETIC_SECRET"); } } })).toBe(generic);
  });

  it.each(tools)("describes only the allowlisted first executable %s", tool => {
    expect(describeStop(bash(tool))).toBe(`Bash: ${tool} [arguments hidden]`);
    expect(describeStop(bash(`${tool}\t--version`))).toBe(`Bash: ${tool} [arguments hidden]`);
    expect(describeStop(bash(`${tool} --token=SYNTHETIC_SECRET https://user:password@example.invalid/private`)))
      .toBe(`Bash: ${tool} [arguments hidden]`);
  });

  it.each([
    null, undefined, false, 42, "Bash", [], {},
    { tool_name: "SYNTHETIC_SECRET", tool_input: { command: "git" } },
    { tool_name: "bash", tool_input: { command: "git" } },
    { tool_name: ["Bash"], tool_input: { command: "git" } },
    { tool_name: "Bash", tool_input: null },
    { tool_name: "Bash", tool_input: [] },
  ])("withholds malformed or unknown tool input (%j)", input => {
    expect(describeStop(input)).toBe(generic);
  });

  it.each([
    "", "git-secret", "git/secret", "gіt", "unknown SYNTHETIC_SECRET",
    "'git' status", '"git" status', "/usr/bin/git status", "./git status",
    "env git status", "sudo git status", "command git status", "exec git status",
    "TOKEN=SYNTHETIC_SECRET git status", "git status; echo SYNTHETIC_SECRET",
    "git status && pwd", "git status || pwd", "git status | cat", "git &",
    "git > /private/SYNTHETIC_SECRET", "git < /private/SYNTHETIC_SECRET",
    "git $(echo SYNTHETIC_SECRET)", "git `echo SYNTHETIC_SECRET`",
    "git ${TOKEN}", "git $TOKEN", "git <(echo SYNTHETIC_SECRET)",
    "(git status)", "{ git status; }", "git # SYNTHETIC_SECRET",
    "git\npwd", "git\rstatus", "git\u0000status", "git\u001b[31msecret",
    "git\bsecret", "git\u007fsecret", "git\u0085secret", "git\u2028secret",
    "git\\\nstatus", "git\\ status", "git status\n", "git status\r",
    "git " + "SYNTHETIC_SECRET".repeat(100_000),
  ])("withholds ambiguous shell syntax (case %#)", command => {
    expect(describeStop(bash(command))).toBe(shell);
  });

  it.each([null, undefined, 42, {}, [], true])("withholds a non-string command (%j)", command => {
    expect(describeStop(bash(command))).toBe(generic);
  });

  it("returns only bounded ASCII constants even when unrelated fields carry secrets", () => {
    const input = {
      ...bash("git status"),
      reason: "SYNTHETIC_SECRET", tool_result: "SYNTHETIC_SECRET",
      tool_input: { command: "git status", token: "SYNTHETIC_SECRET", path: "/private/SYNTHETIC_SECRET" },
    };
    const before = JSON.stringify(input);
    const result = describeStop(input);
    expect(result).toBe("Bash: git [arguments hidden]");
    expect(result).toMatch(/^[\x20-\x7e]{1,80}$/);
    expect(result).not.toContain("SYNTHETIC_SECRET");
    expect(JSON.stringify(input)).toBe(before);
  });
});
