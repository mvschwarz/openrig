import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadHostRegistry,
  resolveHost,
  validateHostRegistry,
  defaultHostRegistryPath,
} from "../src/host-registry.js";

function withTempFile(name: string, contents: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "openrig-host-registry-"));
  const path = join(dir, name);
  writeFileSync(path, contents, "utf-8");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("host registry — defaultHostRegistryPath", () => {
  it("returns ~/.openrig/hosts.yaml under the canonical OpenRig home", () => {
    const path = defaultHostRegistryPath();
    expect(path.endsWith("/hosts.yaml")).toBe(true);
    expect(path.includes(".openrig")).toBe(true);
  });
});

describe("host registry — loadHostRegistry", () => {
  it("loads a valid single-host registry", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-claude-test
    transport: ssh
    target: vm-claude-test.local
    user: tester
    notes: "Tart VM"
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.registry.hosts).toHaveLength(1);
        expect(r.registry.hosts[0]).toEqual({
          id: "vm-claude-test",
          transport: "ssh",
          target: "vm-claude-test.local",
          user: "tester",
          notes: "Tart VM",
        });
      }
    });
  });

  it("loads a valid multi-host registry with optional fields omitted", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-a
    transport: ssh
    target: vm-a.local
  - id: laptop-b
    transport: ssh
    target: laptop-b.tail-scale-net
    user: tester
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.registry.hosts.map((h) => h.id)).toEqual(["vm-a", "laptop-b"]);
        expect(r.registry.hosts[0]?.user).toBeUndefined();
        expect(r.registry.hosts[1]?.user).toBe("tester");
      }
    });
  });

  it("returns a clear error when the registry file is missing", () => {
    const r = loadHostRegistry("/tmp/openrig-non-existent-hosts.yaml");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("host registry not found");
      expect(r.error).toContain("transport: ssh");
    }
  });

  it("rejects non-array hosts field", () => {
    withTempFile("hosts.yaml", `hosts: "not-an-array"\n`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("'hosts' must be an array");
    });
  });

  it("rejects entry missing required id", () => {
    withTempFile("hosts.yaml", `
hosts:
  - transport: ssh
    target: x.local
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("id: required non-empty string");
    });
  });

  it("rejects entry missing required target", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-x
    transport: ssh
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("target: required non-empty string");
    });
  });

  it("rejects non-ssh transport with v0-scope message", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-x
    transport: tailscale
    target: x.local
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("transport: v0 supports 'ssh' only");
        expect(r.error).toContain('"tailscale"');
      }
    });
  });

  it("rejects duplicate host ids", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-x
    transport: ssh
    target: x.local
  - id: vm-x
    transport: ssh
    target: y.local
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("duplicate host id 'vm-x'");
    });
  });

  it("rejects empty user field", () => {
    withTempFile("hosts.yaml", `
hosts:
  - id: vm-x
    transport: ssh
    target: x.local
    user: ""
`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("user: optional, but if present must be a non-empty string");
    });
  });

  it("rejects malformed YAML with a clear error", () => {
    withTempFile("hosts.yaml", `hosts:\n  - id: vm-x\n  transport: ssh\n  target: x.local\nnot-valid: [`, (path) => {
      const r = loadHostRegistry(path);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("failed to parse host registry YAML");
    });
  });

  it("rejects top-level non-object YAML", () => {
    const result = validateHostRegistry("just-a-string", "/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must be a YAML object with a 'hosts' array");
  });
});

describe("host registry — resolveHost", () => {
  const registry = {
    hosts: [
      { id: "vm-a", transport: "ssh" as const, target: "vm-a.local" },
      { id: "vm-b", transport: "ssh" as const, target: "vm-b.local", user: "ops" },
    ],
  };

  it("resolves a known id", () => {
    const r = resolveHost(registry, "vm-b");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.host.target).toBe("vm-b.local");
  });

  it("rejects an unknown id with the supported-list hint", () => {
    const r = resolveHost(registry, "vm-unknown");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("unknown host id 'vm-unknown'");
      expect(r.error).toContain("vm-a");
      expect(r.error).toContain("vm-b");
    }
  });

  it("indicates an empty registry honestly", () => {
    const r = resolveHost({ hosts: [] }, "vm-x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("registry is empty");
  });
});
