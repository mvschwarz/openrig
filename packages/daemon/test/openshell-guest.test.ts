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
