import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";

const AGENT = `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    preferences:
      effort: low
    uses:
      skills: []
`;

describe("expansion member fidelity", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let bindings: NodeBinding[];
  beforeEach(() => {
    db = createFullTestDb(); bindings = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code", listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async binding => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    };
    setup = createTestApp(db, { adapters: { "claude-code": adapter }, podInstantiatorFsOps: {
      exists: p => p.includes("agents/impl"),
      readFile: p => { if (p.includes("agents/impl")) return AGENT; throw Error(`Not found: ${p}`); },
    } });
  });
  afterEach(() => { db.close(); });
  const member = () => ({ id: "reviewer", runtime: "claude-code", agent_ref: "local:agents/impl", profile: "default", cwd: "." });
  async function routeExpand(rigId: string, value: unknown) {
    return setup.app.request(`/api/rigs/${rigId}/expand`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigRoot: "/project/rig", pod: { id: "qa", label: "QA", members: [value], edges: [] } }) });
  }

  it.each(["route", "service", "single-add"])("%s preserves the member config home through persistence, launch and seat status, with effort", async path => {
    const rig = setup.rigRepo.createRig("env-rig");
    const selected = { ...member(), env: { CLAUDE_CONFIG_DIR: "/homes/selected-claude", PROJECT_SETTING: "kept" }, effort: "high" };
    if (path === "route") {
      const response = await routeExpand(rig.id, selected); expect(response.status).toBe(201);
    } else if (path === "service") {
      const { agent_ref, ...rest } = selected;
      const result = await setup.rigExpansionService.expand({ rigId: rig.id, rigRoot: "/project/rig",
        pod: { id: "qa", label: "QA", members: [{ ...rest, agentRef: agent_ref }], edges: [] } });
      expect(result.ok).toBe(true);
    } else {
      const seed = await setup.rigExpansionService.expand({ rigId: rig.id, pod: { id: "qa", label: "QA",
        members: [{ id: "terminal", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }], edges: [] } });
      expect(seed.ok).toBe(true);
      const response = await setup.app.request(`/api/rigs/${rig.id}/pods/qa/members`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rigRoot: "/project/rig", member: selected }) });
      expect(response.status).toBe(201);
    }
    const node = setup.rigRepo.getRig(rig.id)!.nodes.find(n => n.logicalId === "qa.reviewer")!;
    expect(node.env).toEqual(selected.env);
    expect(node.effort).toBe("high");
    expect(bindings).toHaveLength(1); expect(bindings[0]!.effort).toBe("high");
    const launch = vi.mocked(setup.tmuxAdapter.createSession).mock.calls.find(([name]) => name === "qa-reviewer@env-rig");
    expect(launch?.[2]).toMatchObject(selected.env);
    const status = await setup.app.request(`/api/seat/status/${encodeURIComponent("qa-reviewer@env-rig")}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ runtime_home: { variable: "CLAUDE_CONFIG_DIR", home: selected.env.CLAUDE_CONFIG_DIR, source: "member" } });
  });

  it.each(["canonical", "camel", "single-add"])("%s preserves a member token reference through validation and storage", async path => {
    const rig = setup.rigRepo.createRig("token-rig");
    const token = { label: "selected-account", file: "/synthetic/selected-token" };
    if (path === "single-add") {
      const seed = await setup.rigExpansionService.expand({ rigId: rig.id, pod: { id: "qa", label: "QA",
        members: [{ id: "terminal", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }], edges: [] } });
      expect(seed.ok).toBe(true);
      const response = await setup.app.request(`/api/rigs/${rig.id}/pods/qa/members`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rigRoot: "/project/rig", member: { ...member(), claude_token: token } }) });
      expect(response.status).toBe(201);
    } else {
      const response = await routeExpand(rig.id, { ...member(), [path === "camel" ? "claudeToken" : "claude_token"]: token });
      expect(response.status).toBe(201);
    }
    const node = setup.rigRepo.getRig(rig.id)!.nodes.find(n => n.logicalId === "qa.reviewer")!;
    expect(node.claudeTokenRef).toEqual({ label: token.label, tokenFile: token.file });
    expect(bindings).toHaveLength(1);
  });

  it("passes canonical member fields intact to the one validator instead of whitelisting them", async () => {
    const rig = setup.rigRepo.createRig("field-rig");
    const spy = vi.spyOn(setup.podInstantiator, "materializeStructured").mockResolvedValue({ ok: false, code: "validation_failed", errors: ["stop at validator"] });
    const raw = { ...member(), env: { CLAUDE_CONFIG_DIR: "/homes/selected" }, effort: "high", advisor: "haiku", role: "reviewer",
      startup: { files: [], actions: [] }, agent_file: "AGENT.md", append_system_prompt_file: "prompt.md", plugin_dirs: ["plugins"],
      compaction_strategy: "harness_native", mechanic: "harness_native", future_member_setting: { preserved: true } };
    await setup.rigExpansionService.expand({ rigId: rig.id, pod: { id: "qa", label: "QA", members: [raw], edges: [] } });
    const spec = spy.mock.calls[0]![0] as { pods: Array<{ members: unknown[] }> };
    expect(spec.pods[0]!.members[0]).toEqual(raw);
  });

  it.each([null, { CLAUDE_CONFIG_DIR: 7 }])("passes invalid env %j to canonical validation before any create or launch", async env => {
    const rig = setup.rigRepo.createRig("invalid-env");
    const response = await routeExpand(rig.id, { ...member(), env });
    expect(response.status).toBe(400); expect(JSON.stringify(await response.json())).toContain(".env");
    expect(setup.rigRepo.getRig(rig.id)!.nodes).toHaveLength(0); expect(bindings).toHaveLength(0);
  });

  it.each(["model", "label"])("returns 400 for a non-string %s before creating a member", async field => {
    const rig = setup.rigRepo.createRig("invalid-text-field");
    const response = await routeExpand(rig.id, { ...member(), [field]: {} });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(`.${field}: must be a string`);
    expect(setup.rigRepo.getRig(rig.id)!.nodes).toHaveLength(0);
    expect(bindings).toHaveLength(0);
  });

  it("preserves unknown member keys for the existing canonical typo check", async () => {
    const rig = setup.rigRepo.createRig("unknown-key");
    const response = await routeExpand(rig.id, { ...member(), unknown_member_key: "not silently erased" });
    expect(response.status).toBe(400); expect(JSON.stringify(await response.json())).toContain("unknown_member_key");
    expect(setup.rigRepo.getRig(rig.id)!.nodes).toHaveLength(0); expect(bindings).toHaveLength(0);
  });

  it("keeps the established camel alias precedence without modifying nested values", async () => {
    const rig = setup.rigRepo.createRig("alias-rig");
    const spy = vi.spyOn(setup.podInstantiator, "materializeStructured").mockResolvedValue({ ok: false, code: "validation_failed", errors: ["stop at validator"] });
    await setup.rigExpansionService.expand({ rigId: rig.id, pod: { id: "qa", label: "QA", members: [{ ...member(), agentRef: "local:agents/chosen",
      permissionPolicy: null, permission_policy: "builtin:yolo", sessionSource: { mode: "agent_image", ref: { kind: "image_name", value: "kept", version: "3" } } }], edges: [] } });
    const spec = spy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    expect(spec.pods[0]!.members[0]).toMatchObject({ agent_ref: "local:agents/chosen", permission_policy: null,
      session_source: { mode: "agent_image", ref: { kind: "image_name", value: "kept", version: "3" } } });
    expect(spec.pods[0]!.members[0]).not.toHaveProperty("agentRef");
  });

  it.each([
    ["agentRef", "agent_ref", "local:agents/impl"],
    ["codexConfigProfile", "codex_config_profile", "named-profile"],
    ["restorePolicy", "restore_policy", "checkpoint_only"],
  ])("a non-string %s falls back to its canonical string", async (camel, canonical, value) => {
    const rig = setup.rigRepo.createRig("string-alias-rig");
    const spy = vi.spyOn(setup.podInstantiator, "materializeStructured").mockResolvedValue({ ok: false, code: "validation_failed", errors: ["stop at validator"] });
    await routeExpand(rig.id, { ...member(), [camel!]: null, [canonical!]: value });
    expect(spy).toHaveBeenCalled();
    const spec = spy.mock.calls[0]![0] as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    expect(spec.pods[0]!.members[0]![canonical!]).toBe(value);
    expect(spec.pods[0]!.members[0]).not.toHaveProperty(camel!);
  });

  it("leaves malformed members to canonical validation", async () => {
    const rig = setup.rigRepo.createRig("malformed-member");
    const response = await routeExpand(rig.id, null);
    expect(response.status).toBe(400); expect(bindings).toHaveLength(0);
  });
});
