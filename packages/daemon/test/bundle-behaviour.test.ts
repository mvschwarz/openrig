import { describe, expect, it } from "vitest";
import { describeBundleBehaviour } from "../src/domain/bundle-behaviour.js";

const manifest = { schema_version: 2, rig_spec: "rig.yaml", integrity: { files: { "rig.yaml": "a".repeat(64) } } };
const generator = { openrigVersion: "0.6.6", commit: "1234567" };
function fixture(runtime = "claude-code") {
  return new Map<string, string>([
    ["rig.yaml", `name: demo\nversion: '1'\nmanaged_blocks: {claude-code: CLAUDE.local.md}\npermission_policy: builtin:yolo\nculture_file: CULTURE.md\npods:\n- id: build\n  members:\n  - id: worker\n    agent_ref: local:agents/worker\n    profile: default\n    runtime: ${runtime}\n    cwd: .\n`],
    ["agents/worker/agent.yaml", `name: worker\nversion: '1'\nprofiles:\n  default:\n    uses:\n      guidance: [role]\n      plugins: [core]\n      runtime_resources: [hooks]\nresources:\n  guidance:\n  - {id: role, path: role.md, target: AGENTS.md, merge: managed_block}\n  plugins:\n  - {id: core, source: {kind: local, path: 'openrig-home:plugins/core'}}\n  runtime_resources:\n  - {id: hooks, runtime: claude-code, type: hooks, path: hooks.json}\nstartup:\n  files:\n  - {path: brief.md, delivery_hint: send_text, required: true}\n`],
    ["agents/worker/role.md", "Use https://user:password@example.org/guide?token=secret#section"],
    ["agents/worker/brief.md", "Read the task."],
    ["agents/worker/hooks.json", '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node hooks/done.mjs"}]}]}}'],
    ["CULTURE.md", "# Culture"],
  ]);
}
const inspect = (files = fixture(), extra = {}) => describeBundleBehaviour({ files, manifest, generator, digestValid: true, filesVerified: true, ...extra });

describe("archive-only bundle behaviour", () => {
  it("describes the selected team, explicit bypass, tells, writes and host references", () => {
    const view = inspect();
    expect(view.state).toBe("generated");
    if (view.state !== "generated") throw new Error(view.reason);
    expect(view.team).toMatchObject([{ seat: "build.worker", runtime: "claude-code", cwd: "." }]);
    expect(view.posture).toMatchObject([{ basis: "explicit", selection: expect.stringContaining("full_bypass"), nativeEffect: "unknown" }]);
    expect(view.toldFiles).toEqual(expect.arrayContaining([expect.objectContaining({ pathOrRef: "agents/worker/brief.md", delivery: "send_text" })]));
    expect(view.alsoRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ pathOrRef: "openrig-home:plugins/core", resolution: "host_at_launch" }),
      expect.objectContaining({ pathOrRef: "node hooks/done.mjs", kind: "hook_command" }),
    ]));
    expect(view.writes).toEqual(expect.arrayContaining([expect.objectContaining({ path: "CLAUDE.local.md", destinationBase: "seat_cwd" })]));
    expect(view.identity.assembler).toBeNull();
    expect(view.identity.generator).toEqual(generator);
  });

  it("reports literal URL domains without credentials or inferred traffic", () => {
    const view = inspect();
    expect(view.state === "generated" && view.outsideAddresses).toEqual([
      { domain: "example.org", sourceRefs: [{ path: "agents/worker/role.md" }] },
    ]);
    expect(JSON.stringify(view)).not.toContain("password");
    expect(JSON.stringify(view)).not.toContain("token=secret");
  });

  it.each(["claude-code", "codex", "pi"])("uses this archive's %s selection", (runtime) => {
    const view = inspect(fixture(runtime));
    expect(view.state === "generated" && view.team[0]?.runtime).toBe(runtime);
    if (runtime === "pi") expect(view.state === "generated" && view.posture[0]?.selection).toContain("resource trust");
  });

  it("distinguishes unsupported legacy archives from an empty team", () => {
    const view = inspect(new Map(), { manifest: { schema_version: 1 } });
    expect(view).toMatchObject({ state: "not_generated", reason: expect.stringContaining("schema-1"), localInspectCommand: expect.stringContaining("rig bundle inspect") });
    expect(view).not.toHaveProperty("team");
  });

  it("never reads host paths and keeps missing selected files explicit", () => {
    const files = fixture();
    files.set("agents/worker/agent.yaml", files.get("agents/worker/agent.yaml")!.replace("path: brief.md", "path: /private/host-context.md"));
    const get = files.get.bind(files);
    files.get = (path) => { if (path.startsWith("/") || path.startsWith("../")) throw new Error("outside archive read"); return get(path); };
    const view = inspect(files);
    expect(view.state).toBe("generated");
    expect(view.state === "generated" && view.toldFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ pathOrRef: "/private/host-context.md", resolution: "host_at_launch" }),
    ]));
  });

  it("uses declared imports without selecting unrelated resources", () => {
    const files = fixture();
    files.set("agents/worker/agent.yaml", files.get("agents/worker/agent.yaml")!.replace("name: worker", "imports: [{ref: 'local:../shared'}]\nname: worker").replace("guidance: [role]", "guidance: [shared:other]"));
    files.set("agents/shared/agent.yaml", "name: shared\nversion: '1'\nresources:\n  guidance:\n  - {id: other, path: other.md, target: AGENTS.md, merge: managed_block}\nprofiles: {default: {uses: {}}}\n");
    files.set("agents/shared/other.md", "Selected import.");
    const view = inspect(files);
    expect(view.state === "generated" && view.toldFiles).toEqual(expect.arrayContaining([expect.objectContaining({ pathOrRef: "agents/shared/other.md" })]));
    expect(view.state === "generated" && view.toldFiles.some(f => f.pathOrRef === "agents/worker/role.md")).toBe(false);
  });

  it("describes bundled packs as conditional configured-library additions before v2 launch", () => {
    const view = inspect(fixture(), { manifest: { ...manifest, context_packs: ["context-packs/world/manifest.yaml"] } });
    expect(view.state === "generated" && view.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "context_packs", destinationBase: "context.root", path: "world", phase: "before_launch" }),
    ]));
  });

  it("distinguishes host Codex config merges from seat-local extension files", () => {
    const files = fixture("codex");
    files.set("agents/worker/agent.yaml", files.get("agents/worker/agent.yaml")!.replace("runtime: claude-code, type: hooks", "runtime: codex, type: codex_config_fragment"));
    const view = inspect(files);
    expect(view.state === "generated" && view.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ destinationBase: "codex_home", path: "config.toml", operation: "merge managed configuration fragment" }),
    ]));
    expect(view.state === "generated" && view.writes.some(w => w.path.includes("extensions/hooks"))).toBe(false);
  });

  it("lists service commands and version requirements without probing either", () => {
    const files = fixture();
    files.set("rig.yaml", files.get("rig.yaml")! + "services:\n  kind: compose\n  compose_file: compose.yaml\n  checkpoints:\n  - id: db\n    export_command: ./export-db.sh\n");
    files.set("compose.yaml", "services: {}\n");
    const view = inspect(files, { manifest: { ...manifest, compatibility: { min_cli_version: "0.6.6" } } });
    expect(view.state === "generated" && view.alsoRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ pathOrRef: "compose.yaml", resolution: "archive" }),
      expect.objectContaining({ pathOrRef: "./export-db.sh", trigger: "export_command" }),
    ]));
    expect(view.state === "generated" && view.needs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "OpenRig CLI", versionConstraint: ">=0.6.6", status: "not_checked" }),
    ]));
  });

  it("does not invent a runtime when an external AgentSpec supplies its defaults", () => {
    const files = new Map([["rig.yaml", "name: demo\nversion: '1'\npods:\n- id: team\n  members:\n  - {id: worker, agent_ref: 'catalog:unavailable', profile: default, cwd: .}\n"]]);
    expect(inspect(files).state).toBe("not_generated");
    files.set("rig.yaml", files.get("rig.yaml")!.replace("catalog:unavailable", "builtin:terminal"));
    const terminal = inspect(files);
    expect(terminal.state === "generated" && terminal.team[0]?.runtime).toBe("terminal");
  });

  it("names both project content and catalog writes without reading configured host roots", () => {
    const view = inspect(fixture(), { manifest: { ...manifest, project: { id: "example", path: "project" } } });
    expect(view.state === "generated" && view.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "project_files", destinationBase: "workspace.projects_root", path: "example" }),
      expect.objectContaining({ kind: "project_registration", destinationBase: "workspace.catalog_path" }),
    ]));
  });

  it("is deterministic and does not borrow a configuration's identity from another view", () => {
    expect(inspect()).toEqual(inspect());
    const view = inspect();
    expect(view.identity.source).toBeNull();
    expect(view.identity.configurationId).toBeNull();
  });
});
