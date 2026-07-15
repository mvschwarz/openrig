import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateHostRegistry,
  resolveRemoteBearer,
  classifyHttpFailedStep,
  classifyHttpError,
  type HttpHostEntry,
} from "../src/host-registry.js";

describe("host-registry HTTP transport validation", () => {
  it("accepts valid http entry with bearer_env", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "host-b", transport: "http", url: "http://192.168.64.97:7433", bearer_env: "HOST_B_TOKEN" }],
    }, "test.yaml");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.registry.hosts[0]!.transport).toBe("http");
      expect((r.registry.hosts[0] as HttpHostEntry).url).toBe("http://192.168.64.97:7433");
    }
  });

  it("accepts valid http entry with bearer_file", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "host-b", transport: "http", url: "http://192.168.64.97:7433", bearer_file: "/tmp/token" }],
    }, "test.yaml");
    expect(r.ok).toBe(true);
  });

  it("accepts http entry with NO bearer source (anonymous/tokenless daemon)", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "host-b", transport: "http", url: "http://192.168.64.97:7433" }],
    }, "test.yaml");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const h = r.registry.hosts[0] as HttpHostEntry;
      expect(h.bearer_env).toBeUndefined();
      expect(h.bearer_file).toBeUndefined();
    }
  });

  it("rejects http entry with both bearer sources (never both)", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "host-b", transport: "http", url: "http://192.168.64.97:7433", bearer_env: "TOK", bearer_file: "/tmp/tok" }],
    }, "test.yaml");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not both");
  });

  it("rejects http entry with empty url", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "host-b", transport: "http", url: "", bearer_env: "TOK" }],
    }, "test.yaml");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("url");
  });

  it("ssh entries still validate normally", () => {
    const r = validateHostRegistry({
      hosts: [{ id: "vm", transport: "ssh", target: "vm.local" }],
    }, "test.yaml");
    expect(r.ok).toBe(true);
  });

  it("mixed ssh + http hosts both validate", () => {
    const r = validateHostRegistry({
      hosts: [
        { id: "vm", transport: "ssh", target: "vm.local" },
        { id: "host-b", transport: "http", url: "http://192.168.64.97:7433", bearer_env: "TOK" },
      ],
    }, "test.yaml");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.registry.hosts).toHaveLength(2);
  });
});

describe("resolveRemoteBearer", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("resolves from bearer_env when set", () => {
    vi.stubEnv("HOST_B_TOKEN", "secret-token-123");
    const r = resolveRemoteBearer({ id: "b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe("secret-token-123");
  });

  it("returns permission-gate when env var unset", () => {
    delete process.env.MISSING_VAR;
    const r = resolveRemoteBearer({ id: "b", transport: "http", url: "http://x", bearer_env: "MISSING_VAR" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failedStep).toBe("permission-gate");
      expect(r.error).not.toContain("secret");
    }
  });

  it("returns anonymous ok (no token) when no source configured", () => {
    const r = resolveRemoteBearer({ id: "b", transport: "http", url: "http://x" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBeUndefined();
  });

  it("no token appears in error output", () => {
    vi.stubEnv("HOST_B_TOKEN", "");
    const r = resolveRemoteBearer({ id: "b", transport: "http", url: "http://x", bearer_env: "HOST_B_TOKEN" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain("secret");
    }
  });
});

describe("classifyHttpFailedStep", () => {
  it("200 => none", () => expect(classifyHttpFailedStep(200)).toBe("none"));
  it("201 => none", () => expect(classifyHttpFailedStep(201)).toBe("none"));
  it("401 => permission-gate", () => expect(classifyHttpFailedStep(401)).toBe("permission-gate"));
  it("403 => permission-gate", () => expect(classifyHttpFailedStep(403)).toBe("permission-gate"));
  it("404 => remote-command-failed", () => expect(classifyHttpFailedStep(404)).toBe("remote-command-failed"));
  it("500 => remote-command-failed", () => expect(classifyHttpFailedStep(500)).toBe("remote-command-failed"));
  it("0 (connection error) => remote-daemon-unreachable", () => expect(classifyHttpFailedStep(0)).toBe("remote-daemon-unreachable"));
});

describe("classifyHttpError", () => {
  it("any error => remote-daemon-unreachable", () => {
    expect(classifyHttpError(new Error("ECONNREFUSED"))).toBe("remote-daemon-unreachable");
  });
});
