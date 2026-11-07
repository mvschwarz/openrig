import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const relayFile = fileURLToPath(new URL("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs", import.meta.url));
const relay = require(relayFile) as {
  buildOpenRigPayload: (input: object, env: object, now?: () => Date) => Record<string, unknown>;
  postHookPayload: (input: object, env: object) => Promise<void>;
};
const native = { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "git SYNTHETIC_SECRET" },
  permission_suggestions: [{ behavior: "allow", secret: "SYNTHETIC_SECRET" }] };
const env = { OPENRIG_SESSION_NAME: "worker@synthetic", OPENRIG_NODE_ID: "node",
  OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "generation" };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("synthetic passive PermissionRequest observer failure isolation", () => {
  // Schema-derived attribution only; these are not captured native PermissionRequest fixtures.
  it.each([
    { label: "omitted", input: {}, actor: null },
    { label: "null", input: { agent_id: null }, actor: null },
    { label: "subagent", input: { agent_id: "child-1" }, actor: "child-1" },
  ])("attributes the $label schema actor at the producer boundary", ({ input, actor }) => {
    expect(relay.buildOpenRigPayload({ ...native, ...input }, env)).toMatchObject({
      hookEvent: "PermissionRequest", hookAgentId: actor, permissionStopDescriptor: "Bash: git [arguments hidden]",
    });
  });

  it.each(["", " ", 42, true, {}, [], "child\nsecret", "a".repeat(129)])(
    "drops an invalid actor without inferring main at the producer boundary (case %#)", agent_id => {
      const payload = relay.buildOpenRigPayload({ ...native, agent_id }, env);
      expect(payload).not.toHaveProperty("hookAgentId");
      expect(payload).toMatchObject({ hookEvent: "PermissionRequest", permissionStopDescriptor: "Bash: git [arguments hidden]" });
    },
  );

  it("declares the passive relay with the existing hook timeout in the real shipped manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../assets/plugins/openrig-core/hooks/claude.json", import.meta.url), "utf8"));
    expect(manifest.hooks.PermissionRequest).toEqual([{ hooks: [{ type: "command",
      command: '\"${OPENRIG_NODE:-node}\" \"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs\" --from-plugin', timeout: 5 }] }]);
  });

  it.each(["missing", "throws"])("emits no decision or edited input when the formatter %s", formatter => {
    const dir = mkdtempSync(path.join(tmpdir(), "permission-relay-"));
    try {
      const script = path.join(dir, "activity-relay.cjs");
      copyFileSync(relayFile, script);
      if (formatter === "throws") writeFileSync(path.join(dir, "permission-stop-descriptor.cjs"),
        'module.exports = { buildPermissionStopDescriptor() { throw new Error("SYNTHETIC_SECRET"); }, '
        + 'buildPermissionRuleSuggestions() { throw new Error("SYNTHETIC_SECRET"); } };');
      const copiedRelay = require(script) as typeof relay;
      const payload = copiedRelay.buildOpenRigPayload(native, env);
      expect(payload.permissionRuleSuggestions).toEqual({
        state: "unavailable", entries: [], unsupported: false, size_cut: false,
      });
      expect(payload).not.toHaveProperty("decision");
      expect(payload).not.toHaveProperty("hookSpecificOutput");
      expect(payload).not.toHaveProperty("updatedInput");
      expect(JSON.stringify(payload)).not.toContain("SYNTHETIC_SECRET");
      const stdout = execFileSync(process.execPath, [script], { encoding: "utf8", input: JSON.stringify(native), timeout: 5000,
        env: { ...env, HOME: dir, OPENRIG_HOME: dir, PATH: path.dirname(process.execPath) } });
      expect(stdout).toBe("");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("posts only the sanitized observation and swallows a transport failure", async () => {
    const fetch = vi.fn(async (_url: string, _options: { body: string }) => { throw new Error("SYNTHETIC_SECRET"); });
    vi.stubGlobal("fetch", fetch);
    const payload = relay.buildOpenRigPayload(native, env);
    expect(await relay.postHookPayload(payload, { OPENRIG_URL: "http://127.0.0.1:1", OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture" })).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(payload);
    expect(JSON.stringify(payload)).not.toContain("SYNTHETIC_SECRET");
    expect(payload).not.toHaveProperty("decision");
    expect(payload).not.toHaveProperty("hookSpecificOutput");
  });

  it("retains the existing 1500ms network timeout and emits no provider decision", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal!.addEventListener("abort", () => reject(new Error("fixture timeout")), { once: true });
    })));
    const promise = relay.postHookPayload(relay.buildOpenRigPayload(native, env),
      { OPENRIG_URL: "http://127.0.0.1:1", OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture" });
    await vi.advanceTimersByTimeAsync(1499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });
});
