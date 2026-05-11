import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import {
  AuthBearerTokenStartupError,
  assertBindAuthInvariant,
  authBearerTokenMiddleware,
  constantTimeEqual,
  isLoopbackBind,
  isTailscaleBind,
  resolveToIpOrNull,
  findTailscaleIpInInterfaces,
} from "../src/middleware/auth-bearer-token.js";
import type { NetworkInterfaceInfo } from "node:os";

describe("auth-bearer-token middleware (PL-005 Phase B)", () => {
  it("constantTimeEqual returns true for equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });

  it("constantTimeEqual returns false for different strings (same length)", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  it("constantTimeEqual returns false for different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("isLoopbackBind detects loopback host names", () => {
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
    expect(isLoopbackBind("127.42.7.99")).toBe(true);
    expect(isLoopbackBind("localhost")).toBe(true);
    expect(isLoopbackBind("::1")).toBe(true);
    expect(isLoopbackBind("[::1]")).toBe(true);
  });

  it("isLoopbackBind treats non-loopback hosts as non-loopback", () => {
    expect(isLoopbackBind("0.0.0.0")).toBe(false);
    expect(isLoopbackBind("100.64.0.5")).toBe(false);
    expect(isLoopbackBind("10.0.0.1")).toBe(false);
    expect(isLoopbackBind("rig.local")).toBe(false);
  });

  it("isLoopbackBind treats empty/undefined as non-loopback (safety default)", () => {
    expect(isLoopbackBind("")).toBe(false);
    expect(isLoopbackBind(undefined)).toBe(false);
    expect(isLoopbackBind(null)).toBe(false);
  });

  // HARD-GATE audit row 8 (now async per auth-bearer-tailscale-trust slice).
  // Note: 100.64.0.5 is now treated as tailscale (CGNAT) per the new model;
  // the public-IP scenarios (0.0.0.0) still throw.
  it("HARD-GATE: assertBindAuthInvariant throws when truly public bind has empty bearer", async () => {
    await expect(
      assertBindAuthInvariant({ host: "0.0.0.0", bearerToken: null }),
    ).rejects.toThrow(AuthBearerTokenStartupError);
    await expect(
      assertBindAuthInvariant({ host: "0.0.0.0", bearerToken: "" }),
    ).rejects.toThrow(AuthBearerTokenStartupError);
  });

  it("HARD-GATE: assertBindAuthInvariant passes when loopback bind even with empty bearer", async () => {
    await expect(
      assertBindAuthInvariant({ host: "127.0.0.1", bearerToken: null }),
    ).resolves.toBeUndefined();
    await expect(
      assertBindAuthInvariant({ host: "localhost", bearerToken: "" }),
    ).resolves.toBeUndefined();
  });

  it("HARD-GATE: assertBindAuthInvariant passes when non-loopback has non-empty bearer", async () => {
    await expect(
      assertBindAuthInvariant({ host: "0.0.0.0", bearerToken: "secret" }),
    ).resolves.toBeUndefined();
    await expect(
      assertBindAuthInvariant({ host: "192.168.1.5", bearerToken: "secret" }),
    ).resolves.toBeUndefined();
  });

  // ==================================================================
  // bug-fix slice: auth-bearer-tailscale-trust (2026-05-11)
  // ==================================================================

  describe("isTailscaleBind (CGNAT IPv4 + ULA IPv6)", () => {
    it("matches CGNAT IPv4 100.64.0.0/10 — second octet 64..127 inclusive", () => {
      expect(isTailscaleBind("100.64.0.0")).toBe(true);
      expect(isTailscaleBind("100.64.0.5")).toBe(true);
      expect(isTailscaleBind("100.95.124.51")).toBe(true);
      expect(isTailscaleBind("100.127.255.255")).toBe(true);
    });

    it("rejects IPv4 outside CGNAT range (HG-3 boundary)", () => {
      // Below: 100.63.x.x is NOT in 100.64.0.0/10
      expect(isTailscaleBind("100.63.255.255")).toBe(false);
      // Above: 100.128.x.x is NOT in 100.64.0.0/10
      expect(isTailscaleBind("100.128.0.0")).toBe(false);
      // First octet mismatch
      expect(isTailscaleBind("101.64.0.0")).toBe(false);
      expect(isTailscaleBind("99.64.0.0")).toBe(false);
    });

    it("rejects unrelated IPv4 (LAN, public, loopback)", () => {
      expect(isTailscaleBind("127.0.0.1")).toBe(false);
      expect(isTailscaleBind("192.168.1.5")).toBe(false);
      expect(isTailscaleBind("10.0.0.1")).toBe(false);
      expect(isTailscaleBind("203.0.113.45")).toBe(false);
      expect(isTailscaleBind("0.0.0.0")).toBe(false);
    });

    it("matches tailscale ULA IPv6 prefix fd7a:115c:a1e0::/48", () => {
      expect(isTailscaleBind("fd7a:115c:a1e0::1")).toBe(true);
      expect(isTailscaleBind("fd7a:115c:a1e0:ab12:3456:7890:abcd:ef01")).toBe(true);
      // Bracketed form (URL-style)
      expect(isTailscaleBind("[fd7a:115c:a1e0::1]")).toBe(true);
      // Case-insensitive
      expect(isTailscaleBind("FD7A:115C:A1E0::1")).toBe(true);
    });

    it("rejects unrelated IPv6 (other ULA, public, loopback)", () => {
      expect(isTailscaleBind("fd00::1")).toBe(false);
      expect(isTailscaleBind("fd7b:115c:a1e0::1")).toBe(false); // off by one in first segment
      expect(isTailscaleBind("::1")).toBe(false);
      expect(isTailscaleBind("2001:db8::1")).toBe(false);
    });

    it("rejects empty / null / undefined / hostnames (resolver path handles those)", () => {
      expect(isTailscaleBind("")).toBe(false);
      expect(isTailscaleBind(undefined)).toBe(false);
      expect(isTailscaleBind(null)).toBe(false);
      expect(isTailscaleBind("foo.example.com")).toBe(false);
      expect(isTailscaleBind("host.tail-scale-net.ts.net")).toBe(false);
    });
  });

  describe("resolveToIpOrNull", () => {
    it("resolves a real loopback hostname to an IP", async () => {
      const ip = await resolveToIpOrNull("localhost");
      // localhost resolves to 127.0.0.1 or ::1 depending on platform
      expect(ip).toBeTruthy();
      expect(typeof ip).toBe("string");
    });

    it("returns null for an intentionally-unresolvable hostname (HG-4)", async () => {
      const ip = await resolveToIpOrNull("this-host-does-not-exist.invalid");
      expect(ip).toBeNull();
    });
  });

  describe("assertBindAuthInvariant — 7 IMPL-PRD scenarios", () => {
    // Scenario 1: Loopback bind, no bearer → OK
    it("(1) loopback bind 127.0.0.1 with no bearer → OK", async () => {
      await expect(
        assertBindAuthInvariant({ host: "127.0.0.1", bearerToken: null }),
      ).resolves.toBeUndefined();
    });

    // Scenario 2: Tailscale IPv4 bind, no bearer → OK
    it("(2) tailscale IPv4 100.95.124.51 with no bearer → OK", async () => {
      await expect(
        assertBindAuthInvariant({ host: "100.95.124.51", bearerToken: null }),
      ).resolves.toBeUndefined();
    });

    // Scenario 3: Tailscale magicDNS hostname → OK (DNS resolves to tailscale IP)
    it("(3) magicDNS hostname that resolves to tailscale IP → OK", async () => {
      const dns = await import("node:dns");
      const spy = vi.spyOn(dns.promises, "lookup").mockResolvedValue({ address: "100.95.124.51", family: 4 } as unknown as never);
      try {
        await expect(
          assertBindAuthInvariant({ host: "host.tail-scale-net.ts.net", bearerToken: null }),
        ).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    // Scenario 4: LAN bind, no bearer → THROW
    it("(4) LAN bind 192.168.1.50 with no bearer → THROW", async () => {
      await expect(
        assertBindAuthInvariant({ host: "192.168.1.50", bearerToken: null }),
      ).rejects.toThrow(AuthBearerTokenStartupError);
    });

    // Scenario 5: 0.0.0.0 bind, no bearer → THROW
    it("(5) wildcard 0.0.0.0 with no bearer → THROW", async () => {
      await expect(
        assertBindAuthInvariant({ host: "0.0.0.0", bearerToken: null }),
      ).rejects.toThrow(AuthBearerTokenStartupError);
    });

    // Scenario 6: Public IP, no bearer → THROW
    it("(6) public IP 203.0.113.45 (TEST-NET-3) with no bearer → THROW", async () => {
      await expect(
        assertBindAuthInvariant({ host: "203.0.113.45", bearerToken: null }),
      ).rejects.toThrow(AuthBearerTokenStartupError);
    });

    // Scenario 7: DNS-fails hostname, no bearer → THROW
    it("(7) DNS-unresolvable hostname with no bearer → THROW (HG-4)", async () => {
      await expect(
        assertBindAuthInvariant({ host: "this-host-does-not-exist.invalid", bearerToken: null }),
      ).rejects.toThrow(AuthBearerTokenStartupError);
    });

    // Existing-behavior preservation
    it("LAN bind WITH bearer → OK (bearer covers explicit public/LAN opt-in)", async () => {
      await expect(
        assertBindAuthInvariant({ host: "192.168.1.50", bearerToken: "secret" }),
      ).resolves.toBeUndefined();
    });

    it("Public IP WITH bearer → OK", async () => {
      await expect(
        assertBindAuthInvariant({ host: "203.0.113.45", bearerToken: "secret" }),
      ).resolves.toBeUndefined();
    });

    it("error message cites all 3 accepted paths (HG-10)", async () => {
      try {
        await assertBindAuthInvariant({ host: "192.168.1.50", bearerToken: null });
        expect.fail("should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toMatch(/loopback|127\.0\.0\.1|localhost/i);
        expect(msg).toMatch(/tailscale|100\.64\.0\.0\/10|fd7a/i);
        expect(msg).toMatch(/OPENRIG_AUTH_BEARER_TOKEN|bearer/i);
      }
    });

    it("error message names hostname AND resolved IP when DNS resolves to public IP", async () => {
      const dns = await import("node:dns");
      const spy = vi.spyOn(dns.promises, "lookup").mockResolvedValue({ address: "203.0.113.45", family: 4 } as unknown as never);
      try {
        await assertBindAuthInvariant({ host: "external.example.com", bearerToken: null });
        expect.fail("should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("external.example.com");
        expect(msg).toContain("203.0.113.45");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("findTailscaleIpInInterfaces (HG-5)", () => {
    function iface(opts: Partial<NetworkInterfaceInfo> & { address: string }): NetworkInterfaceInfo {
      return {
        address: opts.address,
        netmask: opts.netmask ?? "255.255.255.0",
        family: opts.family ?? "IPv4",
        mac: opts.mac ?? "00:00:00:00:00:00",
        internal: opts.internal ?? false,
        cidr: opts.cidr ?? null,
      } as NetworkInterfaceInfo;
    }

    it("returns the tailscale IPv4 when a CGNAT-range interface is present", () => {
      const result = findTailscaleIpInInterfaces({
        lo0: [iface({ address: "127.0.0.1", internal: true })],
        en0: [iface({ address: "192.168.1.5" })],
        utun4: [iface({ address: "100.95.124.51" })],
      });
      expect(result).toBe("100.95.124.51");
    });

    it("returns the tailscale ULA IPv6 when only the IPv6 tailnet address is present", () => {
      const result = findTailscaleIpInInterfaces({
        utun4: [iface({ address: "fd7a:115c:a1e0::1", family: "IPv6" })],
      });
      expect(result).toBe("fd7a:115c:a1e0::1");
    });

    it("returns null when no interface is in the tailnet range (HG-7 condition)", () => {
      const result = findTailscaleIpInInterfaces({
        lo0: [iface({ address: "127.0.0.1", internal: true })],
        en0: [iface({ address: "192.168.1.5" })],
      });
      expect(result).toBeNull();
    });

    it("skips internal interfaces (loopback) even if the address looked CGNAT-shaped", () => {
      // Defense in depth: an internal flag should win over IP match.
      const result = findTailscaleIpInInterfaces({
        lo0: [iface({ address: "100.95.124.51", internal: true })],
      });
      expect(result).toBeNull();
    });

    it("ignores undefined interface entries gracefully", () => {
      const result = findTailscaleIpInInterfaces({ ghost: undefined });
      expect(result).toBeNull();
    });
  });

  describe("middleware integration", () => {
    function appWithMiddleware(token: string | null): Hono {
      const app = new Hono();
      app.use("*", authBearerTokenMiddleware({ expectedToken: token }));
      app.get("/", (c) => c.json({ ok: true }));
      return app;
    }

    it("loopback-only mode (token=null) passes all requests", async () => {
      const app = appWithMiddleware(null);
      const res = await app.request("/");
      expect(res.status).toBe(200);
    });

    it("returns 401 with three-part body when Authorization missing", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/");
      expect(res.status).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe("unauthorized");
      expect(body.what_failed).toContain("missing Authorization header");
      expect(body.why_it_matters).toBeDefined();
      expect(body.what_to_do).toBeDefined();
    });

    it("returns 401 when Authorization is not Bearer scheme", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { what_failed: string };
      expect(body.what_failed).toContain("Bearer");
    });

    it("returns 401 when Bearer token does not match", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { what_failed: string };
      expect(body.what_failed).toContain("does not match");
    });

    it("returns 200 when Bearer token matches", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { Authorization: "Bearer secret" },
      });
      expect(res.status).toBe(200);
    });

    it("accepts case-insensitive 'authorization' header (HTTP standard)", async () => {
      const app = appWithMiddleware("secret");
      const res = await app.request("/", {
        headers: { authorization: "Bearer secret" },
      });
      expect(res.status).toBe(200);
    });
  });
});
