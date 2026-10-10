// Explicit previews retain their content type and scripts; ordinary HTML reads stay text.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesRoutes } from "../src/routes/files.js";

const html = '<!doctype html><p id="preview">waiting</p><script>document.getElementById("preview").textContent="ready";</script>';
const script = 'document.getElementById("preview").textContent="ready";';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="red"/></svg>';

describe("GET /api/files/asset — previews and retained boundaries", () => {
  let root: string;
  let outside: string;
  let app: Hono;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "asset-preview-"));
    outside = mkdtempSync(join(tmpdir(), "asset-outside-"));
    writeFileSync(join(root, "mock.html"), html);
    writeFileSync(join(root, "preview.js"), script);
    writeFileSync(join(root, "diagram.svg"), svg);
    writeFileSync(join(root, "图表.svg"), svg);
    writeFileSync(join(root, "sample.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(outside, "other.html"), "outside");
    symlinkSync(join(outside, "other.html"), join(root, "link.html"));
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("filesAllowlist" as never, [{ name: "ws", canonicalPath: realpathSync(root) }]);
      c.set("fileWriteService" as never, null);
      await next();
    });
    app.route("/api/files", filesRoutes());
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const url = (p: string, extra = "") => `/api/files/asset?root=ws&path=${encodeURIComponent(p)}${extra}`;

  it("restores explicit HTML preview without a script or frame restriction", async () => {
    const res = await app.request(url("mock.html", "&render=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(await res.text()).toBe(html);
  });

  it.each(["diagram.svg", "图表.svg"])("restores direct inline SVG preview for %s", async (file) => {
    const res = await app.request(url(file));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(await res.text()).toBe(svg);
  });

  it.each(["", "&render=0"])("keeps default HTML as text/plain (%s)", async (extra) => {
    const res = await app.request(url("mock.html", extra));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(await res.text()).toBe(html);
  });

  it.each([false, true])("serves a script asset without nosniff (partial=%s)", async (partial) => {
    const res = await app.request(url("preview.js"), partial ? { headers: { Range: "bytes=0-7" } } : {});
    expect(res.status).toBe(partial ? 206 : 200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(await res.text()).toBe(partial ? script.slice(0, 8) : script);
    if (partial) {
      expect(res.headers.get("Content-Range")).toBe(`bytes 0-7/${Buffer.byteLength(script)}`);
      expect(res.headers.get("Content-Length")).toBe("8");
    }
  });

  it("retains the exact byte range for explicit previews without nosniff", async () => {
    const res = await app.request(url("mock.html", "&render=1"), { headers: { Range: "bytes=0-14" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-14/${Buffer.byteLength(html)}`);
    expect(res.headers.get("Content-Length")).toBe("15");
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(await res.text()).toBe(html.slice(0, 15));
  });

  it("retains content type for other assets without nosniff", async () => {
    const res = await app.request(url("sample.png", "&render=1"));
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it.each(["../other.html", "/etc/passwd", "link.html"])("retains path containment for %s", async (file) => {
    const res = await app.request(url(file, "&render=1"));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toBe("outside");
  });

  it("retains the root allowlist", async () => {
    const res = await app.request("/api/files/asset?root=unknown&path=mock.html&render=1");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("root_unknown");
  });
});
