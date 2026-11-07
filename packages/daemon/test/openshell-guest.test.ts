import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const run = promisify(execFile), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const helper = resolve(import.meta.dirname, "../assets/openshell/guest.py");
async function command(root: string, ...args: string[]) {
  const result = await run("python3", [helper, "--root", root, ...args], { timeout: 5000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  return JSON.parse(result.stdout);
}
it("uses the shipped helper to verify installed bytes and preserve an unmanaged destination", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openshell-helper-"))); roots.push(root);
  mkdirSync(join(root, "control")); mkdirSync(join(root, "work"));
  writeFileSync(join(root, "control", "transfer"), "required current bytes");
  expect(await command(root, "--install", join(root, "control", "transfer"), "--destination", join(root, "work", "role.md"), "--previous", "missing")).toMatchObject({ ok: true, bytes: 22 });
  expect((await command(root, "--read", join(root, "work", "role.md"))).base64).toBe(Buffer.from("required current bytes").toString("base64"));
  writeFileSync(join(root, "control", "transfer-two"), "replacement");
  expect(await command(root, "--install", join(root, "control", "transfer-two"), "--destination", join(root, "work", "role.md"), "--previous", "missing")).toMatchObject({ ok: false, code: "environment_projection_conflict" });
  expect(readFileSync(join(root, "work", "role.md"), "utf8")).toBe("required current bytes");
});
it("rejects traversal and symlink reads instead of copying native or owner files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openshell-helper-"))); roots.push(root);
  writeFileSync(join(root, "outside"), "preserved"); mkdirSync(join(root, "work"));
  symlinkSync(join(root, "outside"), join(root, "work", "link"));
  expect(await command(root, "--read", join(root, "work", "link"))).toMatchObject({ ok: false, code: "environment_symlink" });
  expect(await command(root, "--read", root + "/../outside")).toMatchObject({ ok: false });
});

it("caps a file that grows after descriptor stat without reading its full content", async () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"openshell-helper-"))); roots.push(root);
  mkdirSync(join(root,"work")); const file=join(root,"work","report.json"); writeFileSync(file,"{}");
  const script=`import importlib.util,os,sys
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
original=os.fstat
changed=False
def race(fd):
 global changed
 value=original(fd)
 if not changed:
  changed=True
  with open(sys.argv[3],"ab") as stream: stream.write(b"x"*(g.LIMIT+1))
 return value
os.fstat=race
try:
 g.regular(sys.argv[2],sys.argv[3]); print("unexpected-success")
except g.Refused as error: print(str(error))
`;
  const result=await run("python3",["-c",script,helper,root,file],{timeout:5000});
  expect(result.stdout.trim()).toBe("environment_file_invalid");
});

it("the shipped resume latch refuses missing exact history before provider preparation", async () => {
  const root=realpathSync(mkdtempSync(join(tmpdir(),"openshell-resume-"))); roots.push(root); mkdirSync(join(root,"control"));
  const id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  writeFileSync(join(root,"control","launch.pending.json"),JSON.stringify({version:1,bindingId:"binding-one",generation:"generation-two",nativeId:id,resumeToken:id,nativeType:"community:openshell-claude",files:[],checkpoint:{nativeId:id,nativeType:"community:openshell-claude",files:[]}}));
  expect(await command(root,"--prepare")).toMatchObject({ok:false,code:"environment_checkpoint_invalid"});
});

// Model the measured filesystem grant: the selected root is readable, its ancestors are not.
it("reads inside the granted workspace when opening every ancestor is denied", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openshell-granted-root-"))); roots.push(root);
  mkdirSync(join(root, "work")); const file = join(root, "work", "role.md"); writeFileSync(file, "selected context");
  const script = `import importlib.util,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
original=os.open
ancestors={str(p) for p in Path(sys.argv[2]).parents}
def granted(path, flags, *args, **kwargs):
 if str(path) in ancestors: raise PermissionError(13,"ancestor not granted",str(path))
 return original(path,flags,*args,**kwargs)
os.open=granted
try:
 print(g.regular(sys.argv[2],sys.argv[3]).decode())
except Exception as error: print(type(error).__name__+":"+str(error))
`;
  const result = await run("python3", ["-c", script, helper, root, file], { timeout: 5000 });
  expect(result.stdout.trim()).toBe("selected context");
});

it("preserves rejection of a symlink in the selected root's ancestors", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openshell-root-link-"))); roots.push(root);
  mkdirSync(join(root, "real")); mkdirSync(join(root, "real", "workspace"));
  writeFileSync(join(root, "real", "workspace", "role.md"), "preserved");
  symlinkSync(join(root, "real"), join(root, "link"));
  expect(await command(join(root, "link", "workspace"), "--read", "role.md"))
    .toMatchObject({ ok: false, code: "environment_root_invalid" });
});

it.each([false, true])("the real guest latch binds its initial input without a host viewer (changed=%s)", async changed => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openshell-first-input-"))); roots.push(root);
  for (const name of ["control", "work"]) mkdirSync(join(root, name));
  const input = "Selected identity and role; $(literal-not-a-host-command)";
  writeFileSync(join(root, "control", "first-input.txt"), input);
  const script = `import importlib.util,json,sys,hashlib
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
root=sys.argv[2]; payload=sys.argv[3].encode()
value={"version":1,"bindingId":"binding-one","generation":"generation-one","nativeId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","files":[],"firstInput":{"path":"control/first-input.txt","bytes":len(payload),"sha256":hashlib.sha256(payload).hexdigest()}}
g.atomic(root,"control/launch.json",json.dumps(value).encode())
g.atomic(root,"control/activity.json",json.dumps({"OPENRIG_URL":"http://guest.test:7782","OPENRIG_ACTIVITY_HOOK_TOKEN":"fixture-token","OPENRIG_NODE_ID":"node-one","OPENRIG_SESSION_NAME":"worker@test","OPENRIG_OCCUPANT_GENERATION":"generation-one"}).encode())
if sys.argv[4]=="true": g.atomic(root,"control/first-input.txt",b"changed")
class Captured(Exception): pass
class Child:
 pid=123
 def wait(self): raise Captured()
def spawn(argv,**kwargs):
 print(json.dumps({"argv":argv,"input":g.regular(root,"control/first-input.txt").decode()})); return Child()
g.subprocess.Popen=spawn; g.process_start=lambda pid:"start"
try: g.launch(root)
except Captured: pass
except g.Refused as error: print(json.dumps({"error":str(error)}))
`;
  const result = JSON.parse((await run("python3", ["-c", script, helper, root, input, String(changed)], { timeout: 5000 })).stdout);
  if (changed) expect(result).toEqual({ error: "environment_projection_changed" });
  else {
    expect(result.input).toBe(input);
    expect(result.argv[0]).toBe("/usr/local/bin/claude");
    expect(result.argv.at(-1)).toContain(join(root, "control", "first-input.txt"));
    expect(result.argv.at(-1)).not.toContain("$(literal");
  }
});

it("requires a verified first input before publishing a launch that selected it", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openshell-input-required-"))); roots.push(root); mkdirSync(join(root, "control"));
  writeFileSync(join(root, "control", "launch.pending.json"), JSON.stringify({ version: 1, bindingId: "binding-one", generation: "generation-one", nativeId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", files: [] }));
  expect(await command(root, "--prepare", "--first-input-required")).toEqual({ ok: false, code: "environment_descriptor_invalid" });
  expect(() => readFileSync(join(root, "control", "launch.json"))).toThrow();
});

it.each([true, false])("the guest launch preserves only supplied CA references (supplied=%s)", async supplied => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openshell-ca-"))); roots.push(root);
  mkdirSync(join(root, "control"));
  const ca = {
    NODE_EXTRA_CA_CERTS: "/example/provider-ca.crt",
    SSL_CERT_FILE: "/example/guest-ca-bundle.crt",
    REQUESTS_CA_BUNDLE: "/example/guest-ca-bundle.crt",
    CURL_CA_BUNDLE: "/example/guest-ca-bundle.crt",
  };
  const script = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("guest",sys.argv[1]); g=importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
root=sys.argv[2]
g.atomic(root,"control/launch.json",json.dumps({"version":1,"bindingId":"binding-one","generation":"generation-one","nativeId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","files":[]}).encode())
g.atomic(root,"control/activity.json",json.dumps({"OPENRIG_URL":"http://guest.test:7782","OPENRIG_ACTIVITY_HOOK_TOKEN":"fixture-token","OPENRIG_NODE_ID":"node-one","OPENRIG_SESSION_NAME":"worker@test","OPENRIG_OCCUPANT_GENERATION":"generation-one"}).encode())
class Captured(Exception): pass
class Child:
 pid=123
 def wait(self): raise Captured()
def spawn(argv,**kwargs):
 print(json.dumps({"argv":argv,"env":kwargs["env"]})); return Child()
g.subprocess.Popen=spawn; g.process_start=lambda pid:"start"
try: g.launch(root)
except Captured: pass
`;
  const result = JSON.parse((await run("python3", ["-c", script, helper, root], {
    timeout: 5000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ANTHROPIC_BASE_URL: "https://provider.test",
      ANTHROPIC_API_KEY: "fixture-provider-key",
      UNRELATED_SECRET: "must-not-inherit",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      ...(supplied ? ca : {}),
    },
  })).stdout);
  expect(result.argv[0]).toBe("/usr/local/bin/claude");
  expect(result.env).toMatchObject({
    HOME: join(root, "native"), CLAUDE_CONFIG_DIR: join(root, "native"),
    OPENRIG_ENVIRONMENT_BINDING: "binding-one", OPENRIG_OCCUPANT_GENERATION: "generation-one",
    ANTHROPIC_BASE_URL: "https://provider.test", ANTHROPIC_API_KEY: "fixture-provider-key",
  });
  expect(result.env).not.toHaveProperty("UNRELATED_SECRET");
  expect(result.env).not.toHaveProperty("NODE_TLS_REJECT_UNAUTHORIZED");
  if (supplied) expect(result.env).toMatchObject(ca);
  else for (const name of Object.keys(ca)) expect(result.env).not.toHaveProperty(name);
});
