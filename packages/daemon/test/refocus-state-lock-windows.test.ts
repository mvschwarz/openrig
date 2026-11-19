import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";

const helper = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/refocus-state-lock.cjs");
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("close", () => resolve()); child.kill("SIGKILL");
  })));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function holder(state: string) {
  const code = `const {acquireNativeStateLock}=require(${JSON.stringify(helper)}); (async()=>{await acquireNativeStateLock(${JSON.stringify(state)});console.log('owned');setInterval(()=>{},1000);})();`;
  const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  children.push(child);
  let owned = false, stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned pipe was not acquired: " + stderr)), 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.stdout!.on("data", chunk => { if (String(chunk).includes("owned")) { owned = true; clearTimeout(timer); resolve(); } });
    child.once("close", () => { clearTimeout(timer); if (!owned) reject(new Error("holder exited before acquisition: " + stderr)); });
  });
  return { child, ready, isOwned: () => owned };
}

describe.skipIf(process.platform !== "win32")("refocus kernel-owned Windows state serialization", () => {
  it.each([false, true])("releases after forced process termination, including canonical path alias: %s", async alias => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "refocus pipe Ω ")); roots.push(root);
    const state = path.join(root, "occupant.json");
    const first = holder(state); await first.ready;
    const second = holder(alias ? path.join(fs.realpathSync.native(root), "occupant.json") : state);
    const secondReady = second.ready;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(second.isOwned()).toBe(false);
    const closed = new Promise<void>(resolve => first.child.once("close", () => resolve()));
    first.child.kill("SIGKILL"); await closed;
    await secondReady;
    expect(second.isOwned()).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]); // no persistent lease to strand the next hook
  });

  it("does not serialize distinct occupants", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "refocus independent ")); roots.push(root);
    const first = holder(path.join(root, "one.json")); await first.ready;
    const second = holder(path.join(root, "two.json")); await second.ready;
    expect(first.isOwned()).toBe(true); expect(second.isOwned()).toBe(true);
  });
});
