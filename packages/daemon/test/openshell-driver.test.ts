import { afterEach, expect, it, vi } from "vitest";
import { closeSync, openSync, fstatSync, mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenShellDriver } from "../src/adapters/openshell-driver.js";
import { sha256, type Placement, type EnvironmentBinding } from "../src/domain/environment-platform.js";
import { OpenShellPodmanObserver } from "../src/adapters/openshell-podman-observer.js";
import { assessWindowsFilePermissions } from "../src/domain/windows-owned-text.js";
import { assertWindowsPrivateDirectory } from "../src/domain/private-text-file.js";
import { dirname } from "node:path";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
async function expectPrivate(file:string){
  const fd=openSync(file,"r");
  try{
    if(process.platform==="win32")expect(await assessWindowsFilePermissions(fd)).toEqual({owned:true,privateAcl:true});
    else expect(fstatSync(fd).mode&0o077).toBe(0);
  }finally{closeSync(fd);}
}
it("stages exact policy bytes privately before dispatch and removes only its stage afterward",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"openshell-private-policy-")));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const policy=join(root,"source.yaml"),bytes=Buffer.from("provider: owned\ncomment: Unicode Ω\n");writeFileSync(policy,bytes);
  let staged="";
  const driver=new OpenShellDriver(async args=>{
    staged=args[args.indexOf("--policy")+1]!;expect(readFileSync(staged)).toEqual(bytes);await expectPrivate(staged);
    if(process.platform==="win32")await assertWindowsPrivateDirectory(dirname(staged));
    return JSON.stringify({id:"immutable",name:"worker-one",workspace:"w",phase:"Ready"});
  });
  expect(await driver.create({operationId:"owned",placement:{gateway:"g",workspace:"w",name:"worker-one",image:"image",provider:"provider",policy,policySha256:sha256(bytes)}})).toMatchObject({id:"immutable"});
  expect(existsSync(dirname(staged))).toBe(false);expect(readFileSync(policy)).toEqual(bytes);
});
it("creates binary downloads privately and never overwrites an existing destination",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"openshell-private-download-")));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const bytes=Buffer.from([0,255,128,13,10,42]);
  const driver=new OpenShellDriver(async args=>args.includes("get")?JSON.stringify({id:"immutable",name:"worker-one",workspace:"w",phase:"Ready"}):JSON.stringify({ok:true,base64:bytes.toString("base64")}));
  const binding={guestRoot:"/sandbox/openrig",placement:{gateway:"g",workspace:"w",name:"worker-one"},resource:{id:"immutable",name:"worker-one",workspace:"w"}} as EnvironmentBinding;
  const destination=join(root,"binary Ω.dat");await driver.download(binding,"/sandbox/openrig/work/artifact",destination);
  expect(readFileSync(destination)).toEqual(bytes);await expectPrivate(destination);
  await expect(driver.download(binding,"/sandbox/openrig/work/artifact",destination)).rejects.toMatchObject({code:"EEXIST"});
  expect(readFileSync(destination)).toEqual(bytes);
});
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

it("ingests bounded raw bytes instead of vendor tar after a growing stat", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openshell-ingest-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let vendorDownloads = 0;
  const command = vi.fn(async (args: string[]) => {
    if (args.includes("get")) return JSON.stringify({ id: "immutable", name: "worker-one", workspace: "workspace", phase: "Ready", labels: {} });
    if (args.includes("download")) { vendorDownloads++; writeFileSync(join(root, "artifact.json"), Buffer.alloc(1024*1024+1)); return ""; }
    if (args.includes("--stat")) return JSON.stringify({ ok: true, bytes: 2 });
    return JSON.stringify({ ok: true, base64: Buffer.alloc(1024*1024+1).toString("base64") });
  });
  const binding = { guestRoot: "/sandbox/openrig", placement: { gateway: "gateway", workspace: "workspace", name: "worker-one" }, resource: { id: "immutable", name: "worker-one", workspace: "workspace" } } as EnvironmentBinding;
  await expect(new OpenShellDriver(command).download(binding, "/sandbox/openrig/work/artifacts/report.json", join(root,"artifact.json"))).rejects.toMatchObject({ code: "environment_file_invalid" });
  expect(vendorDownloads).toBe(0); expect(existsSync(join(root,"artifact.json"))).toBe(false);
});
it("transfers one bounded file without extracting a vendor archive", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openshell-ingest-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const command = vi.fn(async (args: string[]) => args.includes("get") ? JSON.stringify({ id: "immutable", name: "worker-one", workspace: "workspace", phase: "Ready" })
    : JSON.stringify({ ok: true, base64: Buffer.from('{"ok":true}').toString("base64") }));
  const binding = { guestRoot: "/sandbox/openrig", placement: { gateway: "gateway", workspace: "workspace", name: "worker-one" }, resource: { id: "immutable", name: "worker-one", workspace: "workspace" } } as EnvironmentBinding;
  await new OpenShellDriver(command).download(binding, "/sandbox/openrig/work/artifacts/report.json", join(root,"artifact.json"));
  expect(readFileSync(join(root,"artifact.json"),"utf8")).toBe('{"ok":true}');
  expect(command.mock.calls.some(([args]) => args.includes("download"))).toBe(false);
});

it("captures creator cleanup identities after compute is stopped", async () => {
  const command = vi.fn(async () => JSON.stringify({id:"immutable",name:"worker-one",workspace:"workspace",phase:"Stopped"}));
  const capture = vi.spyOn(OpenShellPodmanObserver.prototype,"capture").mockResolvedValue({version:1} as never);
  cleanup.push(() => capture.mockRestore());
  const binding = {guestRoot:"/sandbox/openrig",placement:{gateway:"gateway",workspace:"workspace",name:"worker-one"},resource:{id:"immutable",name:"worker-one",workspace:"workspace"}} as EnvironmentBinding;
  expect(await new OpenShellDriver(command).captureCleanup(binding,"/owned/engine.sock")).toEqual({version:1});
  expect(capture).toHaveBeenCalledWith(binding,"/owned/engine.sock");
});

it.each(["Pending", "Error"])("dispatches exact compute stop while live phase is %s", async phase => {
  const command = vi.fn(async (args: string[]) => args.includes("get") ? JSON.stringify({ id: "immutable", name: "worker-one", workspace: "workspace", phase }) : "");
  const binding = { placement: { gateway: "gateway", workspace: "workspace", name: "worker-one" }, resource: { id: "immutable", name: "worker-one", workspace: "workspace" } } as EnvironmentBinding;
  await new OpenShellDriver(command).stopCompute(binding, "selected-stop");
  expect(command.mock.calls.filter(([args]) => args.includes("stop"))).toHaveLength(1);
});
it("rechecks dispatch permission after the driver's own identity await", async () => {
  let enter!: () => void, release!: () => void, eligible = true;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const command = vi.fn(async (args: string[]) => { if (args.includes("get")) { enter(); await gate; return JSON.stringify({ id: "immutable", name: "worker-one", workspace: "workspace", phase: "Ready" }); } return ""; });
  const binding = { placement: { gateway: "gateway", workspace: "workspace", name: "worker-one" }, resource: { id: "immutable", name: "worker-one", workspace: "workspace" } } as EnvironmentBinding;
  const driver = new OpenShellDriver(command);
  const attempt = Reflect.apply(driver.stopCompute, driver, [binding, "selected-stop", () => eligible]);
  const refused = expect(attempt).rejects.toMatchObject({ code: "environment_selection_changed" });
  await entered; eligible = false; release(); await refused;
  expect(command.mock.calls.some(([args]) => args.includes("stop"))).toBe(false);
});

it("rechecks cleanup selection after delete's identity await", async () => {
  let eligible = true;
  const command = vi.fn(async (args: string[]) => {
    if (args.includes("get")) { eligible = false; return JSON.stringify({ id: "immutable", name: "worker-one", workspace: "workspace", phase: "Ready" }); }
    return "";
  });
  const binding = { placement: { gateway: "gateway", workspace: "workspace", name: "worker-one" }, resource: { id: "immutable", name: "worker-one", workspace: "workspace" } } as EnvironmentBinding;
  await expect(new OpenShellDriver(command).deleteEnvironment(binding, "cleanup-one", () => eligible))
    .rejects.toMatchObject({ code: "environment_selection_changed" });
  expect(command.mock.calls.some(([args]) => args.includes("delete"))).toBe(false);
});
