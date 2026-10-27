// OPR.0.4.4.11 — hosts-registry reader (the shared P3/P4 interface cell).
//
// PARITY DISCIPLINE (the scope-audit twin pattern, and the exact drift class
// the slice-20 MISSION_BRIEF_HEADERS miss demonstrated): the daemon reader
// deliberately mirrors packages/cli/src/host-registry.ts (arch ruling 3 —
// CLI copy untouched, no unification this slice). These shared fixtures run
// through BOTH validators and must agree verdict-for-verdict; a divergence
// here means one twin drifted.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHostRegistry,
  validateHostRegistry as daemonValidate,
  resolveHost,
  resolvePlacementHost,
} from "../src/domain/hosts/hosts-registry-reader.js";
import { validateHostRegistry as cliValidate } from "../../cli/src/host-registry.js";

const SRC = "/fixture/hosts.yaml";

const SHARED_FIXTURES: Array<{ label: string; parsed: unknown; ok: boolean }> = [
  {
    label: "valid: one ssh + one http (bearer_env)",
    parsed: { hosts: [
      { id: "vm-a", transport: "ssh", target: "vm-a.local", user: "admin" },
      { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "VPS_B_TOKEN" },
    ] },
    ok: true,
  },
  { label: "valid: http with bearer_file", parsed: { hosts: [{ id: "h", transport: "http", url: "http://h:7433", bearer_file: "/tmp/tok" }] }, ok: true },
  { label: "valid: empty hosts array", parsed: { hosts: [] }, ok: true },
  { label: "invalid: not an object", parsed: "nope", ok: false },
  { label: "invalid: hosts not an array", parsed: { hosts: {} }, ok: false },
  { label: "invalid: duplicate id", parsed: { hosts: [{ id: "x", transport: "ssh", target: "a" }, { id: "x", transport: "ssh", target: "b" }] }, ok: false },
  { label: "invalid: unknown transport", parsed: { hosts: [{ id: "x", transport: "carrier-pigeon", target: "a" }] }, ok: false },
  { label: "invalid: ssh missing target", parsed: { hosts: [{ id: "x", transport: "ssh" }] }, ok: false },
  { label: "invalid: http missing url", parsed: { hosts: [{ id: "x", transport: "http", bearer_env: "T" }] }, ok: false },
  { label: "valid: http with NO bearer (anonymous/tokenless daemon)", parsed: { hosts: [{ id: "x", transport: "http", url: "http://x" }] }, ok: true },
  { label: "invalid: http with BOTH bearers (never both)", parsed: { hosts: [{ id: "x", transport: "http", url: "http://x", bearer_env: "T", bearer_file: "/f" }] }, ok: false },
  { label: "invalid: empty id", parsed: { hosts: [{ id: "  ", transport: "ssh", target: "a" }] }, ok: false },
  // OPR.0.4.6.MH1 FR-7 — reserved host ids rejected in BOTH twins.
  { label: "invalid: reserved id 'kernel' (human-seat collision)", parsed: { hosts: [{ id: "kernel", transport: "ssh", target: "a" }] }, ok: false },
  { label: "invalid: reserved id 'host' (human-seat collision)", parsed: { hosts: [{ id: "host", transport: "ssh", target: "a" }] }, ok: false },
  { label: "invalid: reserved id 'local' (LOCAL_HOST_ID shadow)", parsed: { hosts: [{ id: "local", transport: "http", url: "http://x", bearer_env: "T" }] }, ok: false },
  // M1 A1 — the A2 virtual-domain tokens are reserved in BOTH twins (a host 'external'
  // would collide with the <local>@external classifier). Sourced from VIRTUAL_DOMAIN_TOKENS.
  { label: "invalid: reserved id 'external' (M1 A1 virtual-domain token collision)", parsed: { hosts: [{ id: "external", transport: "ssh", target: "a" }] }, ok: false },
  // OPR.0.4.6.MH1 rev1-r2 B1 — path-bearing ids rejected in BOTH twins
  // (ids name credential files; the pair token path embeds the id).
  { label: "invalid: path-traversal id '../escape'", parsed: { hosts: [{ id: "../escape", transport: "ssh", target: "a" }] }, ok: false },
  { label: "invalid: slash-bearing id 'a/b'", parsed: { hosts: [{ id: "a/b", transport: "ssh", target: "a" }] }, ok: false },
  { label: "invalid: dot-leading id '.hidden'", parsed: { hosts: [{ id: ".hidden", transport: "ssh", target: "a" }] }, ok: false },
  { label: "valid: hostname-shaped id keeps working", parsed: { hosts: [{ id: "vm-a.local", transport: "ssh", target: "a" }] }, ok: true },
  // Slice 14 — the optional join key. A schema edit that lands on only ONE twin passes nothing:
  // these fixtures are what force the CLI validator and the daemon reader to agree about it.
  { label: "valid: ssh entry carrying the hostId join key", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "host-84c37990" }] }, ok: true },
  { label: "valid: http entry carrying the hostId join key", parsed: { hosts: [{ id: "vps-b", transport: "http", url: "http://vps-b:7433", hostId: "host-deadbeef" }] }, ok: true },
  { label: "valid: entry with NO hostId (every entry that exists today)", parsed: { hosts: [{ id: "legacy", transport: "http", url: "http://legacy:7433" }] }, ok: true },
  { label: "valid: hostname-shaped hostId", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "mm2-openrig1.local" }] }, ok: true },
  { label: "invalid: empty hostId", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "  " }] }, ok: false },
  { label: "invalid: non-string hostId", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: 42 }] }, ok: false },
  { label: "invalid: path-bearing hostId 'a/b'", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "a/b" }] }, ok: false },
  { label: "invalid: dot-leading hostId '.hidden'", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: ".hidden" }] }, ok: false },
  // A join key names a real machine's OWN identity, so it can never be one of the tokens that are
  // not machines. The first cut applied only the format regex to hostId and accepted `local`.
  { label: "invalid: reserved hostId 'local'", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "local" }] }, ok: false },
  { label: "invalid: reserved hostId 'kernel'", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "kernel" }] }, ok: false },
  { label: "invalid: reserved hostId 'host'", parsed: { hosts: [{ id: "vm-a", transport: "ssh", target: "a", hostId: "host" }] }, ok: false },
  { label: "invalid: reserved hostId 'external'", parsed: { hosts: [{ id: "vm-a", transport: "http", url: "http://x", hostId: "external" }] }, ok: false },
];

describe("hosts-registry reader — CLI/daemon validator parity (shared fixtures)", () => {
  for (const f of SHARED_FIXTURES) {
    it(`agrees with the CLI validator: ${f.label}`, () => {
      const d = daemonValidate(f.parsed, SRC);
      const c = cliValidate(f.parsed, SRC);
      expect(d.ok).toBe(f.ok);
      expect(c.ok).toBe(f.ok); // both twins, same verdict
      if (d.ok && c.ok) {
        expect(d.registry).toEqual(c.registry); // and the same normalized shape
      }
    });
  }
});

describe("hosts-registry reader — daemon behaviors", () => {
  it("missing file returns the canonical what/why/fix error, never a throw", () => {
    const res = loadHostRegistry("/nonexistent/hosts.yaml");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("host registry not found at /nonexistent/hosts.yaml");
  });

  it("loads + validates a real file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "hosts-reg-"));
    const p = join(dir, "hosts.yaml");
    writeFileSync(p, "hosts:\n  - id: vps-1\n    transport: http\n    url: http://vps-1:7433\n    bearer_env: VPS1_TOKEN\n");
    const res = loadHostRegistry(p);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.registry.hosts[0]).toMatchObject({ id: "vps-1", transport: "http" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("unknown host id names the id and lists known ids (the FR-4 per-entry message)", () => {
    const reg = { hosts: [{ id: "a", transport: "ssh" as const, target: "a.local" }] };
    const res = resolveHost(reg, "nope");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("unknown host id 'nope'");
      expect(res.error).toContain("Known host ids: a");
    }
  });

  it("placement resolution rejects ssh-transport hosts with the remote-up fix message (mirrors runRemoteHttpOp's shipped rejection, surfaced at validation time)", () => {
    const reg = {
      hosts: [
        { id: "ssh-host", transport: "ssh" as const, target: "x.local" },
        { id: "http-host", transport: "http" as const, url: "http://y:7433", bearer_env: "T" },
      ],
    };
    const sshRes = resolvePlacementHost(reg, "ssh-host");
    expect(sshRes.ok).toBe(false);
    if (!sshRes.ok) expect(sshRes.error).toContain("cannot carry remote rig-up");
    expect(resolvePlacementHost(reg, "http-host").ok).toBe(true);
  });
});
