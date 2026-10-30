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
