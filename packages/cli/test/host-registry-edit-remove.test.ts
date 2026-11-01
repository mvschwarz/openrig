// OPR.0.4.6.MH1 FR-1 extension (issue #2128, maintainer-approved boundary) —
// the registry WRITE path for `rig host edit` / `rig host remove`:
//
// - an edit keeps the host's id and transport FIXED (the boundary's first rule);
// - unknown fields fail loud with the allowed set for the transport (a typo'd
//   flag must never silently no-op an edit);
// - an empty string clears an OPTIONAL field (user, notes) — clearing is how
//   you drop a wrong value; required fields (target, url) stay non-empty;
// - a present-but-INVALID registry is never overwritten (add's rule, verbatim);
// - remove deletes ONLY the registry entry.
//
// The daemon twin (packages/daemon/src/domain/hosts/hosts-registry-writer.ts)
// mirrors these verbatim; byte-parity is pinned in
// packages/daemon/test/hosts-registry-parity.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { addHostEntry, loadHostRegistry, updateHostEntry, removeHostEntry } from "../src/host-registry.js";

describe("updateHostEntry (rig host edit write path)", () => {
  let dir: string;
  let regPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostreg-edit-"));
    regPath = path.join(dir, "hosts.yaml");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trip: add an ssh host, edit target/user/notes, loader reads back the edit; id+transport fixed", () => {
    expect(addHostEntry({ id: "vm-a", transport: "ssh", target: "vm-a.local", user: "admin", notes: "old" }, regPath).ok).toBe(true);
    const res = updateHostEntry("vm-a", { target: "vm-b.local", user: "bob", notes: "moved" }, regPath);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.entry).toMatchObject({ id: "vm-a", transport: "ssh", target: "vm-b.local", user: "bob", notes: "moved" });
    expect(res.previous).toMatchObject({ id: "vm-a", transport: "ssh", target: "vm-a.local", user: "admin", notes: "old" });
    const loaded = loadHostRegistry(regPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.registry.hosts).toHaveLength(1);
    expect(loaded.registry.hosts[0]).toEqual({ id: "vm-a", transport: "ssh", target: "vm-b.local", user: "bob", notes: "moved" });
  });

  it("edit keeps the host id and transport fixed (both refusals, bytes untouched)", () => {
    expect(addHostEntry({ id: "vm-a", transport: "ssh", target: "vm-a.local" }, regPath).ok).toBe(true);
    const before = fs.readFileSync(regPath, "utf8");
    const idRes = updateHostEntry("vm-a", { id: "renamed" }, regPath);
    expect(idRes.ok).toBe(false);
    if (!idRes.ok) expect(idRes.error).toContain("id");
    const transportRes = updateHostEntry("vm-a", { transport: "http", url: "http://x" }, regPath);
    expect(transportRes.ok).toBe(false);
    if (!transportRes.ok) expect(transportRes.error).toContain("transport");
    expect(fs.readFileSync(regPath, "utf8")).toBe(before);
  });

  it("edit on an unknown host id names the id and lists known ids", () => {
    expect(addHostEntry({ id: "vm-a", transport: "ssh", target: "vm-a.local" }, regPath).ok).toBe(true);
    const res = updateHostEntry("nope", { target: "x" }, regPath);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("unknown host id 'nope'");
      expect(res.error).toContain("Known host ids");
    }
  });

  it("edit with no changes given is refused", () => {
    expect(addHostEntry({ id: "vm-a", transport: "ssh", target: "vm-a.local" }, regPath).ok).toBe(true);
    const res = updateHostEntry("vm-a", {}, regPath);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no changes/i);
  });

  it("edit refuses fields that are not editable for the transport, naming the allowed set", () => {
    expect(addHostEntry({ id: "vm-a", transport: "ssh", target: "vm-a.local" }, regPath).ok).toBe(true);
    const res = updateHostEntry("vm-a", { url: "http://x" }, regPath);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("url");
      expect(res.error).toContain("ssh");
    }
    // and for an http host, ssh-only fields are refused
    expect(addHostEntry({ id: "h1", transport: "http", url: "http://h1:7433" }, regPath).ok).toBe(true);
    const sshRes = updateHostEntry("h1", { target: "somewhere" }, regPath);
    expect(sshRes.ok).toBe(false);
    if (!sshRes.ok) expect(sshRes.error).toContain("target");
  });

  it("edit clears an optional field with an empty string", () => {
    expect(addHostEntry({ id: "vm-a", transport: "ssh", target: "vm-a.local", user: "admin", notes: "old" }, regPath).ok).toBe(true);
    const res = updateHostEntry("vm-a", { user: "", notes: "" }, regPath);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    const loaded = loadHostRegistry(regPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error);
    const entry = loaded.registry.hosts[0]!;
    expect(entry.user).toBeUndefined();
    expect(entry.notes).toBeUndefined();
    expect(entry.target).toBe("vm-a.local");
  });

  it("edit refuses an invalid required value and leaves the registry untouched", () => {
    expect(addHostEntry({ id: "vm-a", transport: "ssh", target: "vm-a.local" }, regPath).ok).toBe(true);
    const before = fs.readFileSync(regPath, "utf8");
    const res = updateHostEntry("vm-a", { target: "" }, regPath);
    expect(res.ok).toBe(false);
    expect(fs.readFileSync(regPath, "utf8")).toBe(before);
  });

  it("edit on a MISSING registry file is an error (nothing to edit)", () => {
    const res = updateHostEntry("vm-a", { target: "x" }, regPath);
    expect(res.ok).toBe(false);
  });

  it("edit refuses to touch an INVALID registry (never clobber)", () => {
    fs.writeFileSync(regPath, "hosts: [not-valid-yaml");
    const res = updateHostEntry("vm-a", { target: "x" }, regPath);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("refusing to modify an invalid registry");
    expect(fs.readFileSync(regPath, "utf8")).toBe("hosts: [not-valid-yaml");
  });
});

describe("removeHostEntry (rig host remove write path)", () => {
  let dir: string;
  let regPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostreg-remove-"));
    regPath = path.join(dir, "hosts.yaml");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trip: add two hosts, remove one; loader reads back only the other", () => {
    expect(addHostEntry({ id: "vm-a", transport: "ssh", target: "vm-a.local" }, regPath).ok).toBe(true);
    expect(addHostEntry({ id: "vm-b", transport: "http", url: "http://vm-b" }, regPath).ok).toBe(true);
    const res = removeHostEntry("vm-a", regPath);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.entry).toMatchObject({ id: "vm-a", transport: "ssh", target: "vm-a.local" });
    const loaded = loadHostRegistry(regPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.registry.hosts).toHaveLength(1);
    expect(loaded.registry.hosts[0]!.id).toBe("vm-b");
  });

  it("remove an unknown id names it and lists known ids", () => {
    expect(addHostEntry({ id: "vm-a", transport: "ssh", target: "vm-a.local" }, regPath).ok).toBe(true);
    const res = removeHostEntry("nope", regPath);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("unknown host id 'nope'");
      expect(res.error).toContain("Known host ids");
    }
  });

  it("remove on a MISSING registry file is an error", () => {
    const res = removeHostEntry("vm-a", regPath);
    expect(res.ok).toBe(false);
  });

  it("remove refuses to touch an INVALID registry (never clobber)", () => {
    fs.writeFileSync(regPath, "hosts: [not-valid-yaml");
    const res = removeHostEntry("vm-a", regPath);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("refusing to modify an invalid registry");
    expect(fs.readFileSync(regPath, "utf8")).toBe("hosts: [not-valid-yaml");
  });

  it("remove of the last entry leaves a valid empty registry", () => {
    expect(addHostEntry({ id: "vm-a", transport: "ssh", target: "vm-a.local" }, regPath).ok).toBe(true);
    const res = removeHostEntry("vm-a", regPath);
    expect(res.ok).toBe(true);
    const loaded = loadHostRegistry(regPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.registry.hosts).toEqual([]);
  });
});