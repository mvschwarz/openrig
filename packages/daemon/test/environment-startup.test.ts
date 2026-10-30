import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { EnvironmentError, EnvironmentPlatform, sha256 } from "../src/domain/environment-platform.js";
import { EnvironmentStartup } from "../src/domain/environment-startup.js";
import { OpenShellDriver } from "../src/adapters/openshell-driver.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "environment-startup-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const app = createTestApp(db), rig = app.rigRepo.createRig("startup-fixture");
  const node = app.rigRepo.addNode(rig.id, "team.worker", { runtime: "openshell-claude", cwd: root });
  const files = new Map<string, Buffer>(), resource = { id: "resource-one", name: "worker-one", workspace: "workspace", phase: "Ready", operationId: "create-one" };
  let native: Record<string, unknown> | undefined, losePrepare = false;
  const guest = vi.fn(async (_binding: unknown, args: string[]) => {
    if (args[0] === "--prepare") {
      native = JSON.parse(files.get("/sandbox/openrig/control/launch.pending.json")!.toString());
      if (losePrepare) throw new EnvironmentError("openshell_transport_unconfirmed", "Lost preparation reply");
      return { ok: true, ...native };
    }
    if (!native) throw new EnvironmentError("environment_native_unconfirmed", "Native is not observed");
    return { ok: true, ...native, pid: 1 };
  });
  // The fixed CLI boundary is replaced; no OpenShell executable or provider is invoked.
  const driver = Object.assign(new OpenShellDriver(async () => { throw new Error("unexpected vendor invocation"); }), {
    list: async () => ({ complete: true, resources: [] }), create: async () => resource, inspect: async () => resource,
    upload: async (_binding: unknown, source: string, destination: string) => { files.set(destination, readFileSync(source)); },
    read: async (_binding: unknown, path: string) => { const data = files.get(path); if (!data) throw new EnvironmentError("environment_file_missing", "No file"); return data; },
    guest,
  });
  const platform = new EnvironmentPlatform(db, driver), policy = join(root, "policy.yaml"), connection = join(root, "work.json");
  writeFileSync(policy, "version: 1\n");
  writeFileSync(connection, JSON.stringify({ version: 1, seat: "team-worker@startup-fixture", mcpUrl: "http://guest.test:7781/mcp", token: "fixture-work-token" }), { mode: 0o600 });
  await platform.create({ version: 1, bindingId: "binding-one", operationId: "create-one", nodeId: node.id, seat: "team-worker@startup-fixture", baseRuntime: "claude-code", guestRoot: "/sandbox/openrig", guestBaseUrl: "http://guest.test:7433", coordinationRef: connection,
    placement: { gateway: "gateway", workspace: "workspace", name: "worker-one", image: `image@sha256:${"a".repeat(64)}`, provider: "provider", policy } });
  const activity = vi.fn(async () => ({ grantId: "grant-one", env: { OPENRIG_ACTIVITY_HOOK_TOKEN: "scoped-fixture-token" } }));
  const startup = new EnvironmentStartup(platform, join(root, "stage"), activity);
  const binding = { nodeId: node.id, tmuxSession: "team-worker@startup-fixture", cwd: root, launchGeneration: "generation-one" } as NodeBinding;
  const plan = { runtime: "openshell-claude", cwd: root, entries: [], conflicts: [], noOps: [], diagnostics: [], startup: { files: [], actions: [] } } as ProjectionPlan;
  const tmux = { sendShellCommand: vi.fn(async () => ({ ok: true as const })) };
  await startup.project(plan, binding);
  return { root, db, files, startup, platform, activity, guest, tmux, binding, losePrepare: () => { losePrepare = true; } };
}
it("stages all resolved startup inputs before native dispatch and binds separate work/activity connections", async () => {
  const f = await fixture(), role = join(f.root, "role.md"); writeFileSync(role, "Current nonce and useful task guidance");
  await f.startup.deliverStartup([{ path: "role.md", absolutePath: role, ownerRoot: f.root, deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }], f.binding);
  const result = await f.startup.launch(f.binding, {}, f.tmux);
  expect(result.ok).toBe(true);
  expect(f.files.get("/sandbox/openrig/work/.openrig/startup/role.md")!.toString()).toBe("Current nonce and useful task guidance");
  expect(f.files.get("/sandbox/openrig/work/CLAUDE.md")!.toString()).toContain("Read /sandbox/openrig/work/.openrig/startup/role.md");
  expect(f.activity).toHaveBeenCalledWith({ nodeId: f.binding.nodeId, generation: "generation-one", seat: "team-worker@startup-fixture", guestBaseUrl: "http://guest.test:7433" });
  const coordination = f.files.get("/sandbox/openrig/control/coordination.json")!.toString();
  expect(coordination).toContain("fixture-work-token"); expect(coordination).not.toContain("scoped-fixture-token");
  const receipt = f.db.prepare("SELECT receipt_json FROM environment_operations WHERE kind='launch'").get() as { receipt_json: string };
  expect(receipt.receipt_json).toContain("grant-one"); expect(receipt.receipt_json).not.toContain("fixture-token");
  expect(f.tmux.sendShellCommand).toHaveBeenCalledTimes(1);
});
it("reconciles a lost latch reply without issuing another grant or rewriting an execution", async () => {
  const f = await fixture(); f.losePrepare();
  await expect(f.startup.launch(f.binding, {}, f.tmux)).rejects.toThrow("Lost preparation reply");
  const before = sha256(f.files.get("/sandbox/openrig/control/launch.pending.json")!);
  expect((await f.startup.launch(f.binding, {}, f.tmux)).ok).toBe(true);
  expect(f.activity).toHaveBeenCalledTimes(1); expect(f.guest.mock.calls.filter(call => call[1][0] === "--prepare")).toHaveLength(1);
  expect(sha256(f.files.get("/sandbox/openrig/control/launch.pending.json")!)).toBe(before);
});
it("blocks a changed required source before issuing a grant or preparing native", async () => {
  const f = await fixture(), role = join(f.root, "role.md"); writeFileSync(role, "selected source");
  await f.startup.deliverStartup([{ path: "role.md", absolutePath: role, ownerRoot: f.root, deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }], f.binding);
  writeFileSync(role, "changed after resolution");
  await expect(f.startup.launch(f.binding, {}, f.tmux)).rejects.toMatchObject({ code: "environment_projection_source_changed" });
  expect(f.activity).not.toHaveBeenCalled(); expect(f.guest).not.toHaveBeenCalled(); expect(f.tmux.sendShellCommand).not.toHaveBeenCalled();
});
it("refuses an exact-resume request without launching a fresh native", async () => {
  const f = await fixture(), result = await f.startup.launch(f.binding, { resumeToken: "saved-conversation" }, f.tmux);
  expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
  expect(f.activity).not.toHaveBeenCalled(); expect(f.tmux.sendShellCommand).not.toHaveBeenCalled();
});
