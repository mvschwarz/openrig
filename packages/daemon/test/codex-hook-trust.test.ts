// OPR.0.4.3.33 hook-trust-autoclear — reproduce Codex's own `[hooks.state."<key>"] trusted_hash`
// record for the daemon's 4 authored activity hooks, pre-written on the provisioning seam so the
// unmanaged inline hooks are trusted on every path (launch/adopt/reconcile) without a manual
// `/hooks` "Trust all" keystroke.
//
// GROUND-TRUTH CAVEAT: Codex's key/hash is a private impl. The HASH is reproduced deterministically
// from the open source (canonical-JSON sha256 of NormalizedHookIdentity → version_for_toml; see the
// block comment in codex-runtime-adapter.ts). The fixtures below are marked PIN-TO-VM: they are the
// values THIS reproduction emits and the perturbation tests prove the identity fields are folded in
// — but the DEFINITIVE correctness check is a byte-for-byte read-back of a real Codex `[hooks.state]`
// after `/hooks`→"Trust all" (the QA VM proof). Until that read-back confirms them, the exact
// key_source (canonicalized config path) and positional indices are PROVISIONAL. A mismatch is
// fail-safe (gate reappears + Layer-2 keystroke floor), never a false-trusted run.
import { describe, it, expect, vi } from "vitest";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  CodexRuntimeAdapter,
  computeCodexHookTrust,
  upsertCodexHookTrust,
  type CodexAdapterFsOps,
} from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const RELAY = "/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
const CONFIG = nodePath.join("/home/test", ".codex", "config.toml");
const COMMAND = `node "${RELAY}"`;
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"] as const;

// PIN TO VM READ-BACK (qa gate) — PROVISIONAL from open-source reproduction (PR #20321 / commits
// 0452dca, ffcc9cc; codex-rs fingerprint.rs version_for_toml). keySource here is the NON-canonical
// mock path `/home/test/.codex/config.toml`; the real key_source is std::fs::canonicalize(config.toml).
const PROVISIONAL_FIXTURE: Record<(typeof EVENTS)[number], { key: string; hash: string }> = {
  SessionStart: {
    key: `${CONFIG}:session_start:0:0`,
    hash: "sha256:bbe395fdcffc4448b019a7621ff4c4ca57c43107e775ea286394724944fd4fe1",
  },
  UserPromptSubmit: {
    key: `${CONFIG}:user_prompt_submit:0:0`,
    hash: "sha256:88a4916f162eb0fb90e90ebfe5844c4d552efb7e9b70f4616ea497026f6b61d4",
  },
  Stop: {
    key: `${CONFIG}:stop:0:0`,
    hash: "sha256:7349b4836f7c53f7fbe92917a5a598b25a0e699b98a91cf5909bb40dc60da822",
  },
  PermissionRequest: {
    key: `${CONFIG}:permission_request:0:0`,
    hash: "sha256:f3e7b08eef7376efd47d8cd066a2d7284d5ee12b54c7bac2d484b8bbe6ab803c",
  },
};

function mockCodexFs(files?: Record<string, string>): CodexAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    homedir: "/home/test",
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

function mockTmux(): TmuxAdapter {
  return { sendText: vi.fn(async () => ({ ok: true as const })) } as unknown as TmuxAdapter;
}

describe("OPR.0.4.3.33 — computeCodexHookTrust (key + hash derivation)", () => {
  it("reproduces the PROVISIONAL (PIN-TO-VM) key + trusted_hash for all four authored hooks", () => {
    for (const ev of EVENTS) {
      const got = computeCodexHookTrust(ev, { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
      expect(got).toEqual(PROVISIONAL_FIXTURE[ev]);
      expect(got.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("folds the timeout into the hash (perturbation: timeout 5 -> 6 changes the hash, not the key)", () => {
    const base = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
    const perturbed = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 6 });
    expect(perturbed.key).toBe(base.key);
    expect(perturbed.hash).not.toBe(base.hash);
  });

  it("folds the command (relay path) into the hash (perturbation: different relay -> different hash)", () => {
    const base = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
    const perturbed = computeCodexHookTrust("Stop", {
      keySource: CONFIG,
      command: `node "/other/relay.cjs"`,
      timeoutSec: 5,
    });
    expect(perturbed.hash).not.toBe(base.hash);
  });

  it("folds a present matcher into the hash (proves matcher is part of the identity, not absent)", () => {
    const none = computeCodexHookTrust("Stop", { keySource: CONFIG, command: COMMAND, timeoutSec: 5 });
    const withMatcher = computeCodexHookTrust("Stop", {
      keySource: CONFIG,
      command: COMMAND,
      timeoutSec: 5,
      matcher: "Bash",
    });
    expect(withMatcher.hash).not.toBe(none.hash);
  });

  it("keys off the source path + event label + positional indices", () => {
    const got = computeCodexHookTrust("PermissionRequest", {
      keySource: "/x/config.toml",
      command: COMMAND,
      timeoutSec: 5,
    });
    expect(got.key).toBe("/x/config.toml:permission_request:0:0");
  });
});

describe("OPR.0.4.3.33 — upsertCodexHookTrust (idempotent, non-clobbering, section-scoped)", () => {
  const KEY = PROVISIONAL_FIXTURE.SessionStart.key;
  const HASH = PROVISIONAL_FIXTURE.SessionStart.hash;

  it("creates the [hooks.state.\"<key>\"] table with trusted_hash when absent", () => {
    const out = upsertCodexHookTrust("", KEY, HASH);
    expect(out).toBe(`[hooks.state.${JSON.stringify(KEY)}]\ntrusted_hash = ${JSON.stringify(HASH)}\n`);
  });

  it("is idempotent — same key+hash twice is byte-identical (no-op)", () => {
    const once = upsertCodexHookTrust("", KEY, HASH);
    const twice = upsertCodexHookTrust(once, KEY, HASH);
    expect(twice).toBe(once);
  });

  it("splices only the trusted_hash line when the hash changes (does not duplicate the table)", () => {
    const first = upsertCodexHookTrust("", KEY, "sha256:old");
    const updated = upsertCodexHookTrust(first, KEY, HASH);
    expect(updated.match(new RegExp(`\\[hooks\\.state\\.`, "g"))?.length).toBe(1);
    expect(updated).toContain(`trusted_hash = ${JSON.stringify(HASH)}`);
    expect(updated).not.toContain("sha256:old");
  });

  it("does NOT clobber an unrelated [hooks.state], a [projects] trust entry, or other content", () => {
    const existing =
      '[projects."/some/project"]\ntrust_level = "trusted"\n\n' +
      '[hooks.state."/other/config.toml:pre_tool_use:0:0"]\ntrusted_hash = "sha256:other"\n';
    const out = upsertCodexHookTrust(existing, KEY, HASH);
    // every pre-existing line preserved byte-identically
    expect(out).toContain('[projects."/some/project"]');
    expect(out).toContain('trust_level = "trusted"');
    expect(out).toContain('[hooks.state."/other/config.toml:pre_tool_use:0:0"]');
    expect(out).toContain('trusted_hash = "sha256:other"');
    // our new entry appended
    expect(out).toContain(`[hooks.state.${JSON.stringify(KEY)}]`);
    expect(out).toContain(`trusted_hash = ${JSON.stringify(HASH)}`);
    // the OTHER state entry's hash was NOT touched
    expect(out.match(/sha256:other/g)?.length).toBe(1);
  });

  // #2029: Codex saves its tables with literal-quoted keys. A second table for the same key is a duplicate key, and
  // Codex then refuses to start, so the writer finds the table by key.
  it("updates a literal-quoted table Codex saved, in place, without adding a duplicate", () => {
    const out = upsertCodexHookTrust(`[hooks.state.'${KEY}']\ntrusted_hash = 'sha256:old'\n`, KEY, HASH);
    expect(out.match(/^\[hooks\.state\./gm)?.length).toBe(1);
    expect((parseToml(out) as { hooks: { state: Record<string, { trusted_hash: string }> } }).hooks.state[KEY]!.trusted_hash).toBe(HASH);
  });

  it("leaves a key defined another way (an inline table) as it is rather than add a duplicate", () => {
    const existing = `[hooks.state]\n'${KEY}' = { trusted_hash = 'sha256:old' }\n`;
    expect(upsertCodexHookTrust(existing, KEY, HASH)).toBe(existing);
  });

  // A table example inside a person's multi-line instructions isn't a table: it stays exact, and the real one is written.
  it("leaves a single-quoted table example inside a multi-line string alone and writes the real table", () => {
    const existing = `developer_instructions = """\n[hooks.state.'${KEY}']\ntrusted_hash = 'example only'\n"""\n`;
    const out = upsertCodexHookTrust(existing, KEY, HASH);
    const parsed = parseToml(out) as { developer_instructions: string; hooks: { state: Record<string, { trusted_hash: string }> } };
    expect(parsed.developer_instructions).toBe((parseToml(existing) as { developer_instructions: string }).developer_instructions);
    expect(parsed.hooks.state[KEY]!.trusted_hash).toBe(HASH);
  });

  // Appending can't make an unreadable config readable, and would stack another table on every launch.
  it("leaves a config that doesn't parse exactly as it is", () => {
    const existing = `model = "gpt-6"\nmodel = "gpt-6.1"\n\n[hooks.state.'${KEY}']\ntrusted_hash = 'sha256:old'\n`;
    expect(() => parseToml(existing)).toThrow();
    expect(upsertCodexHookTrust(existing, KEY, HASH)).toBe(existing);
  });

  // The probe header's name is one the document doesn't already have, so a person's own key or table of that name can't
  // stand in for it.
  it.each(['"""', "'''"])("leaves a table example in %s instructions alone beside a root key named like the probe", (quote) => {
    const existing = `openrig-header-probe-2 = 'personal'\ndeveloper_instructions = ${quote}\n[hooks.state.'${KEY}']\ntrusted_hash = 'example only'\n${quote}\n`;
    const out = upsertCodexHookTrust(existing, KEY, HASH);
    const parsed = parseToml(out) as Record<string, any>;
    expect(parsed.developer_instructions).toBe((parseToml(existing) as Record<string, any>).developer_instructions);
    expect(parsed["openrig-header-probe-2"]).toBe("personal");
    expect(parsed.hooks.state[KEY].trusted_hash).toBe(HASH);
  });

  it("finds the real table when the document already has a table named like the probe", () => {
    const existing = `[hooks.state.'${KEY}']\ntrusted_hash = 'sha256:old'\n\n[openrig-header-probe-0]\nkept = true\n`;
    const out = upsertCodexHookTrust(existing, KEY, HASH);
    expect(out).toBe(existing.replace("trusted_hash = 'sha256:old'", `trusted_hash = "${HASH}"`));
    expect((parseToml(out) as Record<string, any>)["openrig-header-probe-0"]).toEqual({ kept: true });
  });
});

describe("OPR.0.4.3.33 — provisioning-seam coupling (ensureCodexActivityHooks pre-trusts our 4 hooks)", () => {
  function makeAdapter(fs: CodexAdapterFsOps): CodexRuntimeAdapter {
    return new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: RELAY });
  }

  it("emits BOTH the managed hook block AND exactly the 4 [hooks.state] trust records", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(cfg).toBeDefined();
    // the managed hook block is present
    expect(cfg).toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    for (const ev of EVENTS) expect(cfg).toContain(`[[hooks.${ev}]]`);
    // and exactly the 4 trust state entries (keySource falls back to the plain config path
    // because the mock fs never lands the file on the real disk for realpathSync)
    for (const ev of EVENTS) {
      const { key, hash } = PROVISIONAL_FIXTURE[ev];
      expect(cfg).toContain(`[hooks.state.${JSON.stringify(key)}]`);
      expect(cfg).toContain(`trusted_hash = ${JSON.stringify(hash)}`);
    }
    // scope: exactly 4 hooks.state tables, no more, no wildcard/blanket entry
    expect(cfg.match(/^\[hooks\.state\./gm)?.length).toBe(4);
    expect(cfg).not.toContain('[hooks.state."*"]');
  });

  // #2029: after "Trust all", Codex saves hook state with literal-quoted keys. The next launch updates those tables;
  // a second table for each key is a duplicate key, and Codex then refuses to start.
  it("finds the literal-quoted trust tables Codex saved and adds no duplicate", () => {
    const saved = EVENTS.map(ev => `[hooks.state.'${PROVISIONAL_FIXTURE[ev].key}']\ntrusted_hash = 'sha256:old'\n`).join("\n");
    const fs = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: saved });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    const parsed = parseToml(cfg) as { hooks: { state: Record<string, { trusted_hash: string }> } };
    for (const ev of EVENTS) expect(parsed.hooks.state[PROVISIONAL_FIXTURE[ev].key]!.trusted_hash).toBe(PROVISIONAL_FIXTURE[ev].hash);
    expect(cfg.match(/^\[hooks\.state\./gm)?.length).toBe(4);
  });

  it.each(EVENTS)("trusts the authored %s group at its real position without changing a person's trust", (event) => {
    const userGroups = [0, 1].map(index => `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = "person-${index}"\ntimeout = 9\n`).join("\n");
    const userKey = computeCodexHookTrust(event, { keySource: CONFIG, command: "person-0", timeoutSec: 9 }).key;
    const userState = `[hooks.state.${JSON.stringify(userKey)}]\ntrusted_hash = "sha256:person"\nenabled = false\n`;
    const fs = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: `${userGroups}\n${userState}` });
    const adapter = makeAdapter(fs);
    adapter.ensureCodexActivityHooks();
    const config = fs._store[CONFIG]!;
    const parsed = parseToml(config) as { hooks: { state: Record<string, unknown> } };
    const own = computeCodexHookTrust(event, { keySource: CONFIG, command: COMMAND, timeoutSec: 5, groupIndex: 2 });
    expect(parsed.hooks.state[own.key]).toEqual({ trusted_hash: own.hash });
    expect(parsed.hooks.state[userKey]).toEqual({ trusted_hash: "sha256:person", enabled: false });
    expect(config).toContain(userGroups);
    expect(config).toContain(userState);
    adapter.ensureCodexActivityHooks();
    expect(fs._store[CONFIG]).toBe(config);
  });

  it("does not count a person's groups appended after the managed block as preceding it", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    const adapter = makeAdapter(fs);
    adapter.ensureCodexActivityHooks();
    const userGroup = '\n[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = "person-after"\ntimeout = 9\n';
    fs._store[CONFIG] += userGroup;
    const before = fs._store[CONFIG];
    adapter.ensureCodexActivityHooks();
    expect(fs._store[CONFIG]).toBe(before);
  });

  it("uses native canonical path casing for Codex hook trust keys", () => {
    const canonicalConfigPath = "C:\\Users\\Test\\.codex\\config.toml";
    const nativeRealpath = vi.spyOn(nodeFs.realpathSync, "native").mockReturnValue(canonicalConfigPath);
    try {
      const fakeFs = mockCodexFs({ [RELAY]: "// relay" });
      makeAdapter(fakeFs).ensureCodexActivityHooks();
      const configPath = Object.keys(fakeFs._store).find((path) => path.endsWith("config.toml"))!;
      const config = fakeFs._store[configPath]!;

      expect(nativeRealpath).toHaveBeenCalledWith(configPath);
      expect(config).toContain(`[hooks.state.${JSON.stringify(`${canonicalConfigPath}:session_start:0:0`)}]`);
    } finally {
      nativeRealpath.mockRestore();
    }
  });

  it("is idempotent — re-running produces byte-identical config (no duplicate trust tables)", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay" });
    const adapter = makeAdapter(fs);
    adapter.ensureCodexActivityHooks();
    const first = fs._store[CONFIG]!;
    adapter.ensureCodexActivityHooks();
    const second = fs._store[CONFIG]!;
    expect(second).toBe(first);
    expect(second.match(/^\[hooks\.state\./gm)?.length).toBe(4);
  });

  it("preserves a pre-existing [projects] trust entry through the hook + trust write", () => {
    const fs = mockCodexFs({
      [RELAY]: "// relay",
      [CONFIG]: '[projects."/some/project"]\ntrust_level = "trusted"\n',
    });
    makeAdapter(fs).ensureCodexActivityHooks();
    const cfg = fs._store[CONFIG]!;
    expect(cfg).toContain('[projects."/some/project"]');
    expect(cfg).toContain('trust_level = "trusted"');
    expect(cfg).toContain("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS");
    expect(cfg.match(/^\[hooks\.state\./gm)?.length).toBe(4);
  });
});

// #17 (reported by @borfast): a config.toml Codex saved after "Trust all". Codex 0.164.0 persists hook trust as
// ConfigEdit::SetPath(["hooks", "state"], <the whole table>) (codex-rs app-server config_manager_service.rs, core
// config/edit.rs). toml_edit 0.24.0 keeps each replaced table's comments but not its file position, so it prints
// `[hooks.state]` and every entry, sorted by key with literal-quoted keys and values, after the last hook group:
// inside OpenRig's block, ahead of the `# END` comment that was the first OpenRig trust table's prefix
// (encode.rs, `Display for DocumentMut`). Build's own ~/.codex/config.toml shows the same for another marked block.
describe("#17 — a config.toml Codex saved after \"Trust all\"", () => {
  type State = Record<string, { trusted_hash?: string }>;
  type Hooks = Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  const PERSON = [
    "[features]", "hooks = true", "",
    "[[hooks.SessionStart]]", "[[hooks.SessionStart.hooks]]", 'type = "command"', 'command = "gortex hook session-start"', "",
    "[[hooks.PreToolUse]]", "[[hooks.PreToolUse.hooks]]", 'type = "command"', 'command = "gortex hook pre-tool-use"', "",
  ].join("\n");
  const PERSON_TRUST = { [`${CONFIG}:session_start:0:0`]: "sha256:person-session-start", [`${CONFIG}:pre_tool_use:0:0`]: "sha256:person-pre-tool-use" };
  const ours = (event: (typeof EVENTS)[number]) =>
    computeCodexHookTrust(event, { keySource: CONFIG, command: COMMAND, timeoutSec: 5, groupIndex: event === "SessionStart" ? 1 : 0 });
  const makeAdapter = (fs: CodexAdapterFsOps) => new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, activityRelayPath: RELAY });
  const launch = (config: string) => {
    const fs = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config });
    makeAdapter(fs).ensureCodexActivityHooks();
    return fs._store[CONFIG]!;
  };
  /** What Codex writes back after "Trust all" on OpenRig's launch of PERSON. */
  function codexSaved(): string {
    const launched = launch(PERSON);
    const groups = launched.slice(0, launched.indexOf("# END OPENRIG MANAGED ACTIVITY HOOKS")).trimEnd();
    const hashes: Record<string, string> = { ...PERSON_TRUST };
    for (const [key, value] of Object.entries((parseToml(launched) as { hooks: { state: State } }).hooks.state)) hashes[key] = value.trusted_hash!;
    const firstOurs = ours("SessionStart").key;
    const tables = Object.keys(hashes).sort().map((key) =>
      `${key === firstOurs ? "# END OPENRIG MANAGED ACTIVITY HOOKS\n\n" : ""}[hooks.state.'${key}']\ntrusted_hash = '${hashes[key]}'\n`);
    return `${groups}\n[hooks.state]\n${tables.join("\n")}`;
  }
  const relayGroups = (hooks: Hooks, event: string) => (hooks[event] ?? []).filter((group) => group.hooks[0]!.command === COMMAND).length;

  it("the fixture has the person's trust inside OpenRig's markers, as Codex leaves it", () => {
    const saved = codexSaved();
    const inside = saved.slice(saved.indexOf("# BEGIN OPENRIG MANAGED ACTIVITY HOOKS"), saved.indexOf("# END OPENRIG MANAGED ACTIVITY HOOKS"));
    expect(inside).toContain(`[hooks.state.'${CONFIG}:pre_tool_use:0:0']`);
    expect(() => parseToml(saved)).not.toThrow();
  });

  it("the next launch keeps the person's trust, their groups and order, and one set of OpenRig's groups", () => {
    const next = launch(codexSaved());
    const parsed = parseToml(next) as { hooks: Hooks & { state: State } };
    for (const [key, hash] of Object.entries(PERSON_TRUST)) expect(parsed.hooks.state[key]?.trusted_hash).toBe(hash);
    for (const event of EVENTS) {
      expect(relayGroups(parsed.hooks, event)).toBe(1);
      expect(parsed.hooks.state[ours(event).key]?.trusted_hash).toBe(ours(event).hash);
    }
    expect(parsed.hooks.SessionStart![0]!.hooks[0]!.command).toBe("gortex hook session-start");
    expect(parsed.hooks.PreToolUse!.map((group) => group.hooks[0]!.command)).toEqual(["gortex hook pre-tool-use"]);
    expect(launch(next)).toBe(next);
  });

  it("turning hooks off keeps the person's trust that Codex left inside the block", () => {
    const fs = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: codexSaved() });
    makeAdapter(fs).removeCodexActivityHooks();
    const parsed = parseToml(fs._store[CONFIG]!) as { hooks: Hooks & { state: State } };
    for (const [key, hash] of Object.entries(PERSON_TRUST)) expect(parsed.hooks.state[key]?.trusted_hash).toBe(hash);
    for (const event of EVENTS) expect(relayGroups(parsed.hooks, event)).toBe(0);
  });

  // Codex's saves can also leave a marker apart from the groups it named; Build's own config has an orphaned
  // `# END … CODEX CONFIG FRAGMENT` this way. Groups already running OpenRig's relay are then ours where they sit.
  it.each([
    ["the markers are gone", RELAY],
    ["the markers are gone and the groups run an earlier install's relay", "/old/openrig/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs"],
  ])("when %s, the next launch adds no second set of OpenRig's groups", (_name, relay) => {
    const unmarked = launch(PERSON).split("\n").filter((line) => !line.includes("OPENRIG MANAGED ACTIVITY HOOKS")).join("\n")
      .replaceAll(RELAY, relay);
    const next = launch(unmarked);
    const parsed = parseToml(next) as { hooks: Hooks & { state: State } };
    for (const event of EVENTS) {
      expect(relayGroups(parsed.hooks, event)).toBe(1);
      expect(parsed.hooks.state[ours(event).key]?.trusted_hash).toBe(ours(event).hash);
    }
    expect(next).not.toContain(relay === RELAY ? "# BEGIN OPENRIG" : "/old/openrig/");
    expect(launch(next)).toBe(next);
  });

  // OpenRig's groups are read as TOML, in document context: any key spelling, never text inside a string, and only a
  // group whose one handler runs OpenRig's relay. (#2035 round 1; the first five are review50-r2's controls.)
  describe("OpenRig's groups are found by what they are, not by their text", () => {
    const OLD = "/old/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
    const group = (event: string, relay = OLD, timeout = 5, quoted = false) => {
      const key = quoted ? JSON.stringify(event) : event;
      return `[[hooks.${key}]]\n[[hooks.${key}.hooks]]\ntype = "command"\ncommand = 'node "${relay}"'\ntimeout = ${timeout}\n`;
    };
    const marked = (inner: string) => `[features]\nhooks = true\n# BEGIN OPENRIG MANAGED ACTIVITY HOOKS\n${inner}# END OPENRIG MANAGED ACTIVITY HOOKS\n`;
    const hooksOff = (config: string) => {
      const fs = mockCodexFs({ [RELAY]: "// relay", [CONFIG]: config });
      makeAdapter(fs).removeCodexActivityHooks();
      return fs._store[CONFIG]!;
    };
    const read = (config: string) => parseToml(config) as Record<string, any>;

    it("leaves a relay command example inside a person's multi-line instructions exact", () => {
      const config = `developer_instructions = """\nUse this command in the old installation:\ncommand = 'node "${OLD}"'\nEnd example.\n"""\n${group("Stop")}`;
      expect(read(launch(config)).developer_instructions).toBe(read(config).developer_instructions);
    });

    it("leaves a person's own group for another event alone, even when it runs the relay", () => {
      const next = read(launch(group("PreToolUse", OLD, 60) + group("Stop")));
      expect(next.hooks.PreToolUse[0].hooks[0].command).toBe(`node "${OLD}"`);
      expect(next.hooks.Stop[0].hooks[0].command).toBe(COMMAND);
    });

    it("removes OpenRig's group written with a quoted event key when hooks are turned off", () => {
      const config = marked(group("Stop", OLD, 5, true));
      expect(read(config).hooks.Stop).toHaveLength(1);
      expect(read(hooksOff(config)).hooks?.Stop ?? []).toHaveLength(0);
    });

    it("replaces OpenRig's group written with a quoted event key rather than keep it beside the new one", () => {
      expect(read(launch(marked(group("Stop", OLD, 5, true)))).hooks.Stop).toHaveLength(1);
    });

    it("keeps a section whose multi-line string holds a header example whole, and the file readable", () => {
      const profile = '[profiles.personal]\ndeveloper_instructions = """\nExample:\n[[hooks.Stop]]\nThis is literal documentation.\n"""\n';
      const config = marked(group("Stop") + profile);
      const next = launch(config);
      expect(read(next).profiles).toEqual(read(config).profiles);
      expect(read(hooksOff(config)).profiles).toEqual(read(config).profiles);
    });

    it("keeps a person's own group for one of OpenRig's events that sits inside the markers", () => {
      const person = '[[hooks.PermissionRequest]]\n[[hooks.PermissionRequest.hooks]]\ntype = "command"\ncommand = "person-approve"\n';
      const config = marked(group("PermissionRequest") + person);
      const commands = (text: string) => (read(text).hooks.PermissionRequest ?? []).map((g: any) => g.hooks[0].command);
      expect(commands(launch(config))).toEqual([COMMAND, "person-approve"]);
      expect(commands(hooksOff(config))).toEqual(["person-approve"]);
    });

    it("leaves a config that doesn't parse as it is", () => {
      const config = `model = "a"\nmodel = "b"\n${marked(group("Stop"))}`;
      expect(launch(config)).toBe(config);
      expect(hooksOff(config)).toBe(config);
    });
  });
});
