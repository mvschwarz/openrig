import { afterEach, expect, it, vi } from "vitest";
import fs, { renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DispatchBuffer, dispatchBufferPath } from "../src/domain/gateway/dispatch-buffer.js";
import { addHumanFragment, humansDir, projectionPath, atomicWrite } from "../src/domain/gateway/human-registry.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import { expectPrivateFile } from "./helpers/private-file.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const dirs: string[] = [];
const home = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-private-")); dirs.push(dir); return dir; };
afterEach(() => {
  vi.mocked(renameSync).mockReset().mockImplementation(fs.renameSync);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const decision = (id: string): OutboundDecision => ({ kind: "outbound_decision", decisionId: id, op: "post_message", entityBindingRef: "synthetic#slack", payload: { text: `synthetic 中文\r\n${id}` } });

it("keeps exact pending messages private across enqueue, restart and ack", () => {
  const root = home(), buffer = new DispatchBuffer(root), file = dispatchBufferPath(root);
  buffer.enqueue(decision("one"));
  expectPrivateFile(file);
  buffer.enqueue(decision("two"));
  expectPrivateFile(file);
  expect(new DispatchBuffer(root).pendingStrict()).toEqual([decision("one"), decision("two")]);
  buffer.ack("one");
  expectPrivateFile(file);
  expect(new DispatchBuffer(root).pendingStrict()).toEqual([decision("two")]);
  expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
});

it("keeps authored human fragments and their generated projection private", () => {
  const root = home();
  expect(addHumanFragment({ entityId: "synthetic", class: "human", displayName: "Synthetic 中文", address: "synthetic@external", connectorBindings: [{ kind: "slack", connectorRef: "fixture", secretsRef: "synthetic-reference", role: "primary" }], prefs: { deliveryClass: "B" } }, root).ok).toBe(true);
  expectPrivateFile(path.join(humansDir(root), "synthetic.yaml"));
  expectPrivateFile(projectionPath(root));
  expect(fs.readFileSync(projectionPath(root), "utf8")).toContain("Synthetic 中文");
});

it.runIf(process.platform === "win32")("failed publication retains pending decisions and the prior human file without orphan staging", () => {
  const root = home(), buffer = new DispatchBuffer(root), file = dispatchBufferPath(root);
  buffer.enqueue(decision("one"));
  const human = path.join(root, "human.yaml");
  expect(atomicWrite(human, "synthetic prior").ok).toBe(true);
  vi.mocked(renameSync).mockImplementation(() => { throw new Error("owned publication blocked"); });
  expect(() => buffer.ack("one")).toThrow("owned publication blocked");
  expect(new DispatchBuffer(root).pendingStrict()).toEqual([decision("one")]);
  expect(atomicWrite(human, "synthetic next").ok).toBe(false);
  expect(fs.readFileSync(human, "utf8")).toBe("synthetic prior");
  expectPrivateFile(file); expectPrivateFile(human);
  expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  expect(fs.readdirSync(root).sort()).toEqual(["gateway", "human.yaml"]);
});
