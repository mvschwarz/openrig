import { describe, it, expect } from "vitest";
import { formatDaemonHostForUrl } from "../src/domain/daemon-url.js";
import { formatDaemonHostForUrl as formatAdapterHost } from "../src/adapters/daemon-url.js";

describe("formatDaemonHostForUrl (Issue #493)", () => {
  it("brackets bare IPv6 literals", () => {
    expect(formatDaemonHostForUrl("::1")).toBe("[::1]");
    expect(formatDaemonHostForUrl("2001:db8::1")).toBe("[2001:db8::1]");
    expect(formatDaemonHostForUrl("fe80::1%eth0")).toBe("[fe80::1%eth0]");
  });

  it("leaves already-bracketed IPv6 addresses unchanged", () => {
    expect(formatDaemonHostForUrl("[::1]")).toBe("[::1]");
    expect(formatDaemonHostForUrl("[2001:db8::1]")).toBe("[2001:db8::1]");
  });

  it("leaves IPv4 addresses and hostnames unchanged", () => {
    expect(formatDaemonHostForUrl("127.0.0.1")).toBe("127.0.0.1");
    expect(formatDaemonHostForUrl("localhost")).toBe("localhost");
    expect(formatDaemonHostForUrl("my-host.tailnet.ts.net")).toBe("my-host.tailnet.ts.net");
  });

  it("produces valid URLs that parse cleanly in new URL", () => {
    const rawIpv6 = "::1";
    expect(() => new URL(`http://${rawIpv6}:7433/healthz`)).toThrow();
    const formatted = formatDaemonHostForUrl(rawIpv6);
    const parsed = new URL(`http://${formatted}:7433/healthz`);
    expect(parsed.hostname).toBe("[::1]");
    expect(parsed.port).toBe("7433");
  });

  it("adapters/daemon-url behaves identically to domain/daemon-url", () => {
    expect(formatAdapterHost("::1")).toBe("[::1]");
    expect(formatAdapterHost("127.0.0.1")).toBe("127.0.0.1");
    expect(formatAdapterHost("[::1]")).toBe("[::1]");
  });
});
