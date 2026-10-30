import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenShellDriver } from "../src/adapters/openshell-driver.js";
import { sha256, type Placement, type EnvironmentBinding } from "../src/domain/environment-platform.js";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
it("reads pinned top-level list labels and treats pagination as incomplete", async () => {
  const command = vi.fn(async () => JSON.stringify({ next_page_token: "second-page", sandboxes: [{ id: "immutable", name: "worker-one", workspace: "workspace", phase: "Ready", host_key_fingerprint: "fingerprint", labels: { openrigoperation: "operation-one" } }] }));
  const result = await new OpenShellDriver(command).list({ gateway: "gateway", workspace: "workspace" } as Placement);
  expect(result).toEqual({ complete: false, resources: [{ id: "immutable", name: "worker-one", workspace: "workspace", phase: "Ready", fingerprint: "fingerprint", operationId: "operation-one" }] });
  expect(command.mock.calls[0][0]).toEqual(["--gateway", "gateway", "--workspace", "workspace", "sandbox", "list", "--output", "json", "--page-size", "100"]);
});
it("refuses changed provider policy bytes before a create command", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openshell-policy-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const policy = join(root, "policy.yaml"); writeFileSync(policy, "changed policy");
  const command = vi.fn(async () => "{}");
  await expect(new OpenShellDriver(command).create({ operationId: "operation-one", placement: { gateway: "g", workspace: "w", name: "worker-one", image: "image", provider: "provider", policy, policySha256: sha256("selected policy") } })).rejects.toMatchObject({ code: "environment_policy_changed" });
  expect(command).not.toHaveBeenCalled();
});
it("preserves a typed missing-file result from the fixed guest helper", async () => {
  const command = vi.fn(async (args: string[]) => args.includes("get")
    ? JSON.stringify({ id: "immutable", name: "worker-one", workspace: "workspace", phase: "Ready", labels: {} })
    : JSON.stringify({ ok: false, code: "environment_file_missing" }));
  const binding = { guestRoot: "/sandbox/openrig", placement: { gateway: "gateway", workspace: "workspace", name: "worker-one" }, resource: { id: "immutable", name: "worker-one", workspace: "workspace" } } as EnvironmentBinding;
  await expect(new OpenShellDriver(command).read(binding, "/sandbox/openrig/work/role.md")).rejects.toMatchObject({ code: "environment_file_missing" });
});
