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
import {
  CodexRuntimeAdapter,
  computeCodexHookTrust,
  upsertCodexHookTrust,
  type CodexAdapterFsOps,
} from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const RELAY = "/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
const CONFIG = "/home/test/.codex/config.toml";
const COMMAND = `node "${RELAY}"`;
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"] as const;

// PIN TO VM READ-BACK (qa gate) — PROVISIONAL from open-source reproduction (PR #20321 / commits
// 0452dca, ffcc9cc; codex-rs fingerprint.rs version_for_toml). keySource here is the NON-canonical
// mock path `/home/test/.codex/config.toml`; the real key_source is std::fs::canonicalize(config.toml).
const PROVISIONAL_FIXTURE: Record<(typeof EVENTS)[number], { key: string; hash: string }> = {
  SessionStart: {
    key: "/home/test/.codex/config.toml:session_start:0:0",
    hash: "sha256:bbe395fdcffc4448b019a7621ff4c4ca57c43107e775ea286394724944fd4fe1",
  },
  UserPromptSubmit: {
    key: "/home/test/.codex/config.toml:user_prompt_submit:0:0",
    hash: "sha256:88a4916f162eb0fb90e90ebfe5844c4d552efb7e9b70f4616ea497026f6b61d4",
  },
  Stop: {
    key: "/home/test/.codex/config.toml:stop:0:0",
    hash: "sha256:7349b4836f7c53f7fbe92917a5a598b25a0e699b98a91cf5909bb40dc60da822",
  },
  PermissionRequest: {
    key: "/home/test/.codex/config.toml:permission_request:0:0",
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
