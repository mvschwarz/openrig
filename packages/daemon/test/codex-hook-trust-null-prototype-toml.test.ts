// #2720: smol-toml 1.9 parses every table with a null prototype, which `^1.8.0` installs, while this repo's lockfile
// keeps 1.8.0, whose tables have Object's. With 1.9, OpenRig's check that its trust records were written exactly
// compared prototypes as well as content, so it refused every write: Codex seats with a hooks.json stopped at "Hooks
// need review". Here smol-toml's parser returns tables the way 1.9 does, and the trust records are written and moved
// as with 1.8.
import { describe, it, expect, vi } from "vitest";
import { parse as parseToml } from "smol-toml";
import { CodexRuntimeAdapter, computeCodexHookTrust, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

vi.mock("smol-toml", async (importOriginal) => {
  const real = await importOriginal<typeof import("smol-toml")>();
  // smol-toml 1.9's shape: each table a null-prototype object. Arrays and other values (such as dates) are unchanged.
  const asNullPrototype = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(asNullPrototype);
    if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
    return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, asNullPrototype(entry)])));
  };
  return { ...real, parse: (text: string, options?: Parameters<typeof real.parse>[1]) => asNullPrototype(real.parse(text, options)) };
});

const RELAY = "/daemon/assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs";
const HOME = "/home/test/.codex";
const CONFIG = `${HOME}/config.toml`;
const HOOKS = `${HOME}/hooks.json`;
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"] as const;
const USER_GROUP = { matcher: "startup", hooks: [{ type: "command", command: "echo hello", timeout: 10 }] };
const ours = { hooks: [{ type: "command", command: `node "${RELAY}"`, timeout: 5, statusMessage: "OpenRig activity" }] };

function codexHome(files: Record<string, string>) {
  const store: Record<string, string> = { [RELAY]: "// relay", ...files };
  const fs = {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    homedir: "/home/test",
  } as CodexAdapterFsOps;
  const adapter = new CodexRuntimeAdapter({ tmux: { sendText: vi.fn() } as unknown as TmuxAdapter, fsOps: fs, activityRelayPath: RELAY });
  const state = () => (parseToml(store[CONFIG] ?? "") as { hooks?: { state?: Record<string, Record<string, unknown>> } }).hooks?.state ?? {};
  return { adapter, store, state };
}

describe("#2720: Codex hook trust records with smol-toml 1.9's null-prototype tables", () => {
  it("the parser here gives tables smol-toml 1.9's null prototype", () => {
    const parsed = parseToml('[hooks.state."k"]\ntrusted_hash = "h"\n') as { hooks: { state: { k: object } } };
    expect(Object.getPrototypeOf(parsed.hooks.state.k)).toBeNull();
  });

  it("OpenRig's hooks.json groups are added and their trust records written, so Codex doesn't ask for a review", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const home = codexHome({ [HOOKS]: JSON.stringify({ hooks: { SessionStart: [USER_GROUP] } }), [CONFIG]: 'model = "gpt"\n' });
    home.adapter.ensureCodexActivityHooks();
    expect(errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("activity hooks skipped"))).toEqual([]);
    errors.mockRestore();
    expect(JSON.parse(home.store[HOOKS]!).hooks.SessionStart).toEqual([USER_GROUP, ours]);
    for (const event of EVENTS) {
      const { key, hash } = computeCodexHookTrust(event, { keySource: HOOKS, command: `node "${RELAY}"`, timeoutSec: 5,
        groupIndex: event === "SessionStart" ? 1 : 0, statusMessage: "OpenRig activity" });
      expect(home.state()[key]?.trusted_hash).toBe(hash);
    }
  });

  it("removing OpenRig's group still moves a later hook's trust and disable to its new place", () => {
    const later = { hooks: [{ type: "command", command: "echo later", timeout: 7 }] };
    const config = `model = "gpt"\n\n[hooks.state."${HOOKS}:stop:1:0"]\ntrusted_hash = "openrig-old"\n\n`
      + `[hooks.state."${HOOKS}:stop:2:0"]\ntrusted_hash = "person-hash"\nenabled = false\n`;
    const home = codexHome({ [CONFIG]: config, [HOOKS]: JSON.stringify({ hooks: { Stop: [USER_GROUP, ours, later] } }) });
    home.adapter.removeCodexActivityHooks();
    expect(JSON.parse(home.store[HOOKS]!).hooks.Stop).toEqual([USER_GROUP, later]);
    expect({ ...home.state()[`${HOOKS}:stop:1:0`] }).toEqual({ trusted_hash: "person-hash", enabled: false });
    expect(home.state()[`${HOOKS}:stop:2:0`]).toBeUndefined();
  });
});
