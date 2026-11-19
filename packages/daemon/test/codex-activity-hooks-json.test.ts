// A Codex home that keeps its hooks in hooks.json gets OpenRig's activity hooks there too, so Codex never sees both formats in
// one layer. The user's hooks stay where they are; only OpenRig's own groups are written, moved or removed.
import { describe, it, expect, vi } from "vitest";
import nodeFs from "node:fs";
import { parse as parseToml } from "smol-toml";
import path from "node:path";
import { CodexRuntimeAdapter, computeCodexHookTrust, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const RELAY = "/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
const HOME = "/home/test/.codex";
const CONFIG = path.join(HOME, "config.toml");
const HOOKS = path.join(HOME, "hooks.json");
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"] as const;
const LABEL = { SessionStart: "session_start", UserPromptSubmit: "user_prompt_submit", Stop: "stop", PermissionRequest: "permission_request" };
const USER_GROUP = { matcher: "startup", hooks: [{ type: "command", command: "echo hello", timeout: 10 }] };

function mockCodexFs(files?: Record<string, string>) {
  const canonical = (file: string) => file.replaceAll("\\", "/");
  const store = new Proxy<Record<string, string>>({}, {
    get: (target, key) => target[canonical(String(key))],
    set: (target, key, value) => { target[canonical(String(key))] = value; return true; },
    has: (target, key) => canonical(String(key)) in target,
  });
  Object.assign(store, files);
  const writes: string[] = [];
  const fs = {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { writes.push(p); store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    homedir: "/home/test",
  } as CodexAdapterFsOps;
  return { fs, store, writes };
}

const adapter = (fs: CodexAdapterFsOps, relay = RELAY) =>
  new CodexRuntimeAdapter({ tmux: { sendText: vi.fn() } as unknown as TmuxAdapter, fsOps: fs, activityRelayPath: relay });

const ours = (relay = RELAY) => ({ hooks: [{ type: "command", command: `node "${relay}"`, timeout: 5, statusMessage: "OpenRig activity" }] });
const trustOf = (event: (typeof EVENTS)[number], groupIndex: number, relay = RELAY) =>
  computeCodexHookTrust(event, { keySource: HOOKS, command: `node "${relay}"`, timeoutSec: 5, groupIndex, statusMessage: "OpenRig activity" });

describe("Codex activity hooks with an existing hooks.json", () => {
  it("adds OpenRig's groups after the user's, trusts exactly them, and writes no inline block", () => {
    const user = { hooks: { SessionStart: [USER_GROUP] } };
    const m = mockCodexFs({ [RELAY]: "// relay", [HOOKS]: JSON.stringify(user), [CONFIG]: 'model = "gpt"\n' });
    adapter(m.fs).ensureCodexActivityHooks();

    const hooks = JSON.parse(m.store[HOOKS]!).hooks;
    expect(hooks.SessionStart).toEqual([USER_GROUP, ours()]);
    for (const event of ["UserPromptSubmit", "Stop", "PermissionRequest"] as const) expect(hooks[event]).toEqual([ours()]);
    const config = m.store[CONFIG]!;
    expect(config).not.toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(config).not.toContain("[[hooks.");
    expect(config).toContain('model = "gpt"');
    expect(config).toMatch(/\[features\]\nhooks = true/);
    for (const event of EVENTS) {
      const { key, hash } = trustOf(event, event === "SessionStart" ? 1 : 0);
      expect(key).toBe(`${HOOKS}:${LABEL[event]}:${event === "SessionStart" ? 1 : 0}:0`);
      expect(config).toContain(`[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}`);
    }
    // The user's own group is never trusted on their behalf.
    expect(config).not.toContain(`${HOOKS}:session_start:0:0`);
  });

  it("moves OpenRig's inline block from an earlier launch out of config.toml, so the layer keeps one format", () => {
    const first = mockCodexFs({ [RELAY]: "// relay" });
    adapter(first.fs).ensureCodexActivityHooks();
    expect(first.store[CONFIG]).toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");

    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: first.store[CONFIG]!, [HOOKS]: JSON.stringify({ hooks: {} }) });
    adapter(m.fs).ensureCodexActivityHooks();
    expect(m.store[CONFIG]).not.toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(m.store[CONFIG]).not.toContain("[[hooks.");
    expect(JSON.parse(m.store[HOOKS]!).hooks.Stop).toEqual([ours()]);
  });

  it("leaves a user's own inline hooks in config.toml", () => {
    const userInline = '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "echo bye"\n';
    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: userInline, [HOOKS]: JSON.stringify({ hooks: {} }) });
    adapter(m.fs).ensureCodexActivityHooks();
    expect(m.store[CONFIG]).toContain(userInline.trimEnd());
  });

  it("is idempotent, and a new relay path replaces OpenRig's group where it is", () => {
    const user = { hooks: { Stop: [USER_GROUP] } };
    const m = mockCodexFs({ [RELAY]: "// relay", [HOOKS]: JSON.stringify(user) });
    adapter(m.fs).ensureCodexActivityHooks();
    const writes = m.writes.length;
    adapter(m.fs).ensureCodexActivityHooks();
    expect(m.writes.length).toBe(writes);

    const moved = "/new/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
    m.store[moved] = "// relay";
    // A user group added after OpenRig's stays after it.
    const later = JSON.parse(m.store[HOOKS]!);
    later.hooks.Stop.push({ hooks: [{ type: "command", command: "echo later" }] });
    m.store[HOOKS] = JSON.stringify(later);
    adapter(m.fs, moved).ensureCodexActivityHooks();
    const stop = JSON.parse(m.store[HOOKS]!).hooks.Stop;
    expect(stop).toEqual([USER_GROUP, ours(moved), { hooks: [{ type: "command", command: "echo later" }] }]);
    const { key, hash } = trustOf("Stop", 1, moved);
    expect(m.store[CONFIG]).toContain(`[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}`);
  });

  it("leaves a hooks.json it can't read as hooks untouched, and writes no inline block beside it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = mockCodexFs({ [RELAY]: "// relay", [HOOKS]: '{"hooks": {"Stop": "not a list"}}', [CONFIG]: 'model = "gpt"\n' });
    adapter(m.fs).ensureCodexActivityHooks();
    expect(m.store[HOOKS]).toBe('{"hooks": {"Stop": "not a list"}}');
    expect(m.store[CONFIG]).toBe('model = "gpt"\n');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("left untouched"));
    spy.mockRestore();
  });

  it("removes only OpenRig's groups when hooks are turned off", () => {
    const m = mockCodexFs({ [RELAY]: "// relay", [HOOKS]: JSON.stringify({ hooks: { Stop: [USER_GROUP] } }) });
    const a = adapter(m.fs);
    a.ensureCodexActivityHooks();
    a.removeCodexActivityHooks();
    expect(JSON.parse(m.store[HOOKS]!).hooks).toEqual({ Stop: [USER_GROUP] });
  });

  it("uses the hooks.json in a seat's own CODEX_HOME", () => {
    const seat = "/homes/seat-codex";
    const m = mockCodexFs({ [RELAY]: "// relay", [`${seat}/hooks.json`]: "{}" });
    adapter(m.fs).ensureCodexActivityHooks(seat);
    expect(JSON.parse(m.store[`${seat}/hooks.json`]!).hooks.SessionStart).toEqual([ours()]);
    expect(m.store[`${seat}/config.toml`]).not.toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(m.store[CONFIG]).toBeUndefined();
  });
});

describe("Codex activity hooks without a hooks.json", () => {
  it("keep today's inline block and never create a hooks.json", () => {
    const m = mockCodexFs({ [RELAY]: "// relay" });
    adapter(m.fs).ensureCodexActivityHooks();
    expect(m.store[CONFIG]).toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(m.store[HOOKS]).toBeUndefined();
  });
});

describe("Codex activity hooks with a hooks.json keep the person's own state (#1957 round 1)", () => {
  const state = (config: string) => (parseToml(config) as { hooks?: { state?: Record<string, Record<string, unknown>> } }).hooks?.state ?? {};
  const inlineThenJson = (disableStop: boolean) => {
    const first = mockCodexFs({ [RELAY]: "// relay" });
    adapter(first.fs).ensureCodexActivityHooks();
    let config = first.store[CONFIG]!;
    // The person turns OpenRig's inline Stop hook off in Codex (its group is first among the inline Stop groups).
    if (disableStop) config = config.replace(`[hooks.state.${JSON.stringify(`${CONFIG}:stop:0:0`)}]\n`, `[hooks.state.${JSON.stringify(`${CONFIG}:stop:0:0`)}]\nenabled = false\n`);
    expect(state(config)[`${CONFIG}:stop:0:0`]?.enabled).toBe(disableStop ? false : undefined);
    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config, [HOOKS]: JSON.stringify({ hooks: { Stop: [USER_GROUP] } }) });
    adapter(m.fs).ensureCodexActivityHooks();
    return m;
  };

  it("a disable of OpenRig's inline hook moves with it to hooks.json (F1)", () => {
    const m = inlineThenJson(true);
    expect(JSON.parse(m.store[HOOKS]!).hooks.Stop).toEqual([USER_GROUP, ours()]);
    const moved = state(m.store[CONFIG]!)[`${HOOKS}:stop:1:0`]!;
    expect(moved.enabled).toBe(false);
    expect(moved.trusted_hash).toBe(trustOf("Stop", 1).hash);
    // The other events weren't disabled, so they're only trusted.
    expect(state(m.store[CONFIG]!)[`${HOOKS}:session_start:0:0`]).toEqual({ trusted_hash: trustOf("SessionStart", 0).hash });
  });

  it("an enabled inline hook moves as trusted only (F1 control)", () => {
    const m = inlineThenJson(false);
    expect(state(m.store[CONFIG]!)[`${HOOKS}:stop:1:0`]).toEqual({ trusted_hash: trustOf("Stop", 1).hash });
  });

  it("does not replace an explicit JSON enable with an old inline disable", () => {
    const first = mockCodexFs({ [RELAY]: "// relay" });
    adapter(first.fs).ensureCodexActivityHooks();
    const config = first.store[CONFIG]!
      + `\n[hooks.state."${HOOKS}:stop:0:0"]\nenabled = true\n`;
    const disabled = config.replace(`[hooks.state."${CONFIG}:stop:0:0"]\n`,
      `[hooks.state."${CONFIG}:stop:0:0"]\nenabled = false\n`);
    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: disabled, [HOOKS]: JSON.stringify({ hooks: {} }) });
    adapter(m.fs).ensureCodexActivityHooks();
    expect(state(m.store[CONFIG]!)[`${HOOKS}:stop:0:0`]?.enabled).toBe(true);
  });

  it("does not re-disable a JSON hook after the person re-enables it", () => {
    const m = inlineThenJson(true);
    m.store[CONFIG] = m.store[CONFIG]!.replace(`[hooks.state."${HOOKS}:stop:1:0"]\nenabled = false\n`,
      `[hooks.state."${HOOKS}:stop:1:0"]\nenabled = true\n`);
    expect(state(m.store[CONFIG]!)[`${HOOKS}:stop:1:0`]?.enabled).toBe(true);
    adapter(m.fs).ensureCodexActivityHooks();
    expect(state(m.store[CONFIG]!)[`${HOOKS}:stop:1:0`]?.enabled).toBe(true);
  });

  const linkedSources = (run: (sources: string[]) => void) => {
    const sources = [HOOKS, "/resolved/home/hooks.json", "/storage/hooks-source.json"];
    const realpath = vi.spyOn(nodeFs.realpathSync, "native").mockImplementation(path => {
      if (path === HOME) return "/resolved/home";
      if (path === HOOKS) return "/storage/hooks-source.json";
      throw new Error("fixture path not linked");
    });
    try { run(sources); } finally { realpath.mockRestore(); }
  };

  it("copies a disable only to aliases with no choice and keeps conflicting explicit choices", () => linkedSources(sources => {
    const config = sources.slice(0, 2).map((source, index) =>
      `[hooks.state."${source}:stop:0:0"]\nenabled = ${index === 0 ? "true" : "false"}\n`).join("\n");
    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config, [HOOKS]: JSON.stringify({ hooks: {} }) });
    adapter(m.fs).ensureCodexActivityHooks();
    const after = state(m.store[CONFIG]!);
    expect(sources.map(source => after[`${source}:stop:0:0`]?.enabled)).toEqual([true, false, false]);
    for (const source of sources) {
      const expected = computeCodexHookTrust("Stop", { keySource: source, command: `node "${RELAY}"`, timeoutSec: 5,
        groupIndex: 0, statusMessage: "OpenRig activity" });
      expect(after[expected.key]?.trusted_hash).toBe(expected.hash);
      expect(after[`${source}:session_start:0:0`]?.enabled).toBeUndefined();
    }
  }));

  it("moves every alias of a later person's state when OpenRig's JSON group is removed", () => linkedSources(sources => {
    const later = { hooks: [{ type: "command", command: "echo later", timeout: 7 }] };
    const config = sources.map((source, index) =>
      `[hooks.state."${source}:stop:1:0"]\ntrusted_hash = "ours"\n\n`
      + `[hooks.state."${source}:stop:2:0"]\ntrusted_hash = "person-${index}"\nenabled = ${index === 0 ? "true" : "false"}\n`).join("\n");
    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config,
      [HOOKS]: JSON.stringify({ hooks: { Stop: [USER_GROUP, ours(), later] } }) });
    adapter(m.fs).removeCodexActivityHooks();
    expect(JSON.parse(m.store[HOOKS]!).hooks.Stop).toEqual([USER_GROUP, later]);
    const after = state(m.store[CONFIG]!);
    sources.forEach((source, index) => {
      expect(after[`${source}:stop:1:0`]).toEqual({ trusted_hash: `person-${index}`, enabled: index === 0 });
      expect(after[`${source}:stop:2:0`]).toBeUndefined();
    });
  }));

  it("removing OpenRig's group keeps a later user hook's trust and disable with it (F2)", () => {
    const later = { hooks: [{ type: "command", command: "echo later", timeout: 7 }] };
    const config = `model = "gpt"\n\n[hooks.state.${JSON.stringify(`${HOOKS}:stop:1:0`)}]\ntrusted_hash = "openrig-old"\n\n`
      + `[hooks.state.${JSON.stringify(`${HOOKS}:stop:2:0`)}]\ntrusted_hash = "person-hash"\nenabled = false\n`;
    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config, [HOOKS]: JSON.stringify({ hooks: { Stop: [USER_GROUP, ours(), later] } }) });
    adapter(m.fs).removeCodexActivityHooks();
    expect(JSON.parse(m.store[HOOKS]!).hooks.Stop).toEqual([USER_GROUP, later]);
    const after = state(m.store[CONFIG]!);
    expect(after[`${HOOKS}:stop:1:0`]).toEqual({ trusted_hash: "person-hash", enabled: false });
    expect(after[`${HOOKS}:stop:2:0`]).toBeUndefined();
    expect(m.store[CONFIG]).toContain('model = "gpt"');
  });

  it.each(["8", "08"])("keeps stale state index %s under resolved source spellings when removing a known JSON group", index => linkedSources(sources => {
    const config = sources.map(source =>
      `[hooks.state.'${source}:stop:${index}:0']\ntrusted_hash = "stale-person"\nenabled = false\n`).join("\n");
    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config,
      [HOOKS]: JSON.stringify({ hooks: { Stop: [USER_GROUP, ours()] } }) });
    const a = adapter(m.fs);
    a.removeCodexActivityHooks();
    expect(JSON.parse(m.store[HOOKS]!).hooks.Stop).toEqual([USER_GROUP]);
    for (const source of sources) {
      expect(state(m.store[CONFIG]!)[`${source}:stop:${index}:0`]).toEqual({ trusted_hash: "stale-person", enabled: false });
    }
    expect(m.store[CONFIG]).toBe(config);
    const after = m.store[CONFIG];
    a.removeCodexActivityHooks();
    expect(m.store[CONFIG]).toBe(after);
  }));

  it.each([false, true].flatMap(json => ['"""', "'''"].map(quote => ({ json, quote }))))(
    "carries a disable to source aliases without changing a $quote note (JSON: $json)", ({ json, quote }) => {
      const file = json ? HOOKS : CONFIG;
      const basename = json ? "hooks.json" : "config.toml";
      const resolved = `/storage/${basename}`;
      const sources = [file, `/resolved/home/${basename}`, resolved];
      const note = `note = ${quote}\nenabled = true\n[example_only]\nenabled = false\n${quote}\n`;
      const config = `[hooks.state."${file}:stop:0:0"]\nenabled = false\n\n`
        + sources.slice(1).map(source => `[hooks.state."${source}:stop:0:0"]\n${note}`).join("\n");
      const realpath = vi.spyOn(nodeFs.realpathSync, "native").mockImplementation(path => {
        if (path === HOME) return "/resolved/home";
        if (path === file) return resolved;
        throw new Error("fixture path not linked");
      });
      try {
        const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config,
          ...(json ? { [HOOKS]: JSON.stringify({ hooks: {} }) } : {}) });
        const a = adapter(m.fs);
        a.ensureCodexActivityHooks();
        const written = m.store[CONFIG]!;
        for (const source of sources) {
          expect(state(written)[`${source}:stop:0:0`]).toMatchObject({ enabled: false });
        }
        for (const source of sources.slice(1)) {
          expect(state(written)[`${source}:stop:0:0`]?.note).toBe("enabled = true\n[example_only]\nenabled = false\n");
        }
        expect(written.split(note)).toHaveLength(3);
        if (json) expect(JSON.parse(m.store[HOOKS]!).hooks.Stop).toEqual([ours()]);
        a.ensureCodexActivityHooks();
        expect(m.store[CONFIG]).toBe(written);
      } finally { realpath.mockRestore(); }
    });

  it("the same move finds trust tables Codex saved with literal-quoted keys (#2029)", () => {
    const later = { hooks: [{ type: "command", command: "echo later", timeout: 7 }] };
    const config = `model = "gpt"\n\n[hooks.state.'${HOOKS}:stop:1:0']\ntrusted_hash = 'openrig-old'\n\n`
      + `[hooks.state.'${HOOKS}:stop:2:0']\ntrusted_hash = 'person-hash'\nenabled = false\n`;
    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config, [HOOKS]: JSON.stringify({ hooks: { Stop: [USER_GROUP, ours(), later] } }) });
    adapter(m.fs).removeCodexActivityHooks();
    expect(JSON.parse(m.store[HOOKS]!).hooks.Stop).toEqual([USER_GROUP, later]);
    const after = state(m.store[CONFIG]!);
    expect(after[`${HOOKS}:stop:1:0`]).toEqual({ trusted_hash: "person-hash", enabled: false });
    expect(after[`${HOOKS}:stop:2:0`]).toBeUndefined();
  });

  it("a config the trust write would make invalid leaves both files untouched (F3)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Valid TOML: an inline state table the line writer doesn't extend, on the key OpenRig would write.
    const config = `model = "gpt"\n\n[hooks.state]\n"${HOOKS}:stop:0:0" = { trusted_hash = "person-choice" }\n`;
    expect(() => parseToml(config)).not.toThrow();
    const json = JSON.stringify({ hooks: {} });
    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config, [HOOKS]: json });
    adapter(m.fs).ensureCodexActivityHooks();
    expect(m.store[CONFIG]).toBe(config);
    expect(m.store[HOOKS]).toBe(json);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("left untouched"));
    spy.mockRestore();
  });

  it.each(['"trusted_hash"', "'trusted_hash'"])("updates a quoted JSON hook trust field %s and keeps the person's choice", (field) => {
    const key = `${HOOKS}:stop:1:0`;
    const config = `model = "gpt"\n\n[hooks.state."${key}"]\n${field} = "old"\nenabled = true\n`;
    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config,
      [HOOKS]: JSON.stringify({ hooks: { Stop: [USER_GROUP] } }) });
    const a = adapter(m.fs);
    a.ensureCodexActivityHooks();
    expect(JSON.parse(m.store[HOOKS]!).hooks.Stop).toEqual([USER_GROUP, ours()]);
    expect(state(m.store[CONFIG]!)[key]).toEqual({ trusted_hash: trustOf("Stop", 1).hash, enabled: true });
    expect(parseToml(m.store[CONFIG]!).model).toBe("gpt");
    const after = m.store[CONFIG];
    a.ensureCodexActivityHooks();
    expect(m.store[CONFIG]).toBe(after);
  });

  it.each(['"""', "'''"])("provisions JSON hooks without rewriting quoted examples in a %s note", (quote) => {
    const key = `${HOOKS}:stop:1:0`;
    const note = `note = ${quote}\n"trusted_hash" = "double example"\n 'trusted_hash' = "literal example"\n${quote}\n`;
    const config = `model = "gpt"\n\n[hooks.state."${key}"]\n${note}trusted_hash = "old"\nenabled = true\n`;
    const m = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config,
      [HOOKS]: JSON.stringify({ hooks: { Stop: [USER_GROUP] } }) });
    const a = adapter(m.fs);
    a.ensureCodexActivityHooks();
    expect(JSON.parse(m.store[HOOKS]!).hooks.Stop).toEqual([USER_GROUP, ours()]);
    expect(m.store[CONFIG]).toContain(note);
    expect(state(m.store[CONFIG]!)[key]).toEqual({ trusted_hash: trustOf("Stop", 1).hash, enabled: true,
      note: '"trusted_hash" = "double example"\n \'trusted_hash\' = "literal example"\n' });
    const after = m.store[CONFIG];
    a.ensureCodexActivityHooks();
    expect(m.store[CONFIG]).toBe(after);
  });

  it("a person's own relay with the same file name and label is theirs: kept, and OpenRig's is added (F4)", () => {
    const theirs = { hooks: [{ type: "command", command: 'node "/home/test/tools/activity-relay.cjs"', timeout: 19, statusMessage: "OpenRig activity" }] };
    const m = mockCodexFs({ [RELAY]: "// relay", [HOOKS]: JSON.stringify({ hooks: { Stop: [theirs] } }) });
    const a = adapter(m.fs);
    a.ensureCodexActivityHooks();
    expect(JSON.parse(m.store[HOOKS]!).hooks.Stop).toEqual([theirs, ours()]);
    a.removeCodexActivityHooks();
    expect(JSON.parse(m.store[HOOKS]!).hooks.Stop).toEqual([theirs]);
  });
});
