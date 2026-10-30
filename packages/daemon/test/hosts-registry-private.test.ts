import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { addHostEntry as cliAdd } from "../../cli/src/host-registry.js";
import { addHostEntry as daemonAdd } from "../src/domain/hosts/hosts-registry-writer.js";
import { expectPrivateFile } from "./helpers/private-file.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const directories: string[] = [];
afterEach(() => {
  vi.mocked(renameSync).mockReset().mockImplementation(fs.renameSync);
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it.each([["CLI", cliAdd], ["daemon", daemonAdd]] as const)("%s publishes private host registries on creation and replacement", (_name, add) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-registry-private-"));
  directories.push(dir);
  const file = path.join(dir, "hosts.yaml");
  expect(add({ id: "first", transport: "ssh", target: "fixture.invalid", notes: "synthetic 中文" }, file).ok).toBe(true);
  expectPrivateFile(file);
  const prior = fs.readFileSync(file, "utf8");
  expect(add({ id: "second", transport: "http", url: "http://fixture.invalid", bearer_env: "SYNTHETIC_TOKEN" }, file).ok).toBe(true);
  expectPrivateFile(file);
  expect(fs.readFileSync(file, "utf8")).toContain("synthetic 中文");
  expect(fs.readFileSync(file, "utf8")).toContain("SYNTHETIC_TOKEN");
  expect(fs.readdirSync(dir)).toEqual(["hosts.yaml"]);
  const updated = fs.readFileSync(file, "utf8");
  expect(updated).not.toBe(prior);
  expect(add({ id: "second", transport: "ssh", target: "other.invalid" }, file).ok).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe(updated);
  expectPrivateFile(file);
});

it.runIf(process.platform === "win32").each([["CLI", cliAdd], ["daemon", daemonAdd]] as const)("%s keeps the prior private registry when publication fails", (_name, add) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-registry-private-failure-"));
  directories.push(dir);
  const file = path.join(dir, "hosts.yaml");
  expect(add({ id: "first", transport: "ssh", target: "fixture.invalid" }, file).ok).toBe(true);
  const prior = fs.readFileSync(file, "utf8");
  vi.mocked(renameSync).mockImplementation(() => { throw new Error("owned publication blocked"); });
  expect(add({ id: "second", transport: "ssh", target: "other.invalid" }, file).ok).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe(prior);
  expectPrivateFile(file);
  expect(fs.readdirSync(dir)).toEqual(["hosts.yaml"]);
});
