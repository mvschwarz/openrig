// OPR.0.4.4.20 FR-5 + FR-11 — /api/files/asset Range support + .html ?render=1.
//
// FR-5: iOS Safari requires byte-range support (206 + Accept-Ranges) for
// media playback; the curl-probe AC is "a 100-byte range request returns
// 100 bytes, not the whole file". Range lands on THIS route only.
// FR-11: .html serves text/html ONLY under the explicit ?render=1 opt-in.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesRoutes } from "../src/routes/files.js";

describe("GET /api/files/asset — Range + render opt-in", () => {
  let root: string;
  let app: Hono;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "asset-range-"));
    mkdirSync(join(root, "media"), { recursive: true });
    // 1000 deterministic bytes standing in for a video file.
    writeFileSync(join(root, "media", "clip.mp4"), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251)));
    writeFileSync(join(root, "media", "mock.html"), "<h1>mock</h1>");
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

  it("serves 206 + Accept-Ranges + exactly the requested 100 bytes (the curl-probe AC)", async () => {
    const res = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=0-99" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Range")).toBe("bytes 0-99/1000");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(100); // 100 bytes, not the whole file
    expect(body[0]).toBe(0);
    expect(body[99]).toBe(99);
  });

  it("serves interior and open-ended ranges with the correct byte slice", async () => {
    const mid = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=500-509" } });
    expect(mid.headers.get("Content-Range")).toBe("bytes 500-509/1000");
    const midBody = new Uint8Array(await mid.arrayBuffer());
    expect(midBody[0]).toBe(500 % 251);

    const tail = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=990-" } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get("Content-Range")).toBe("bytes 990-999/1000");
    expect((await tail.arrayBuffer()).byteLength).toBe(10);

    const suffix = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=-50" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("Content-Range")).toBe("bytes 950-999/1000");
  });

  it.each(["bytes=-1000", "bytes=-2000"])("serves the whole representation for a satisfiable long suffix %s", async (range) => {
    const res = await app.request(url("media/clip.mp4"), { headers: { Range: range } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-999/1000");
    expect(res.headers.get("Content-Length")).toBe("1000");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(Uint8Array.from({ length: 1000 }, (_, i) => i % 251));
  });

  it("clamps an over-long end and rejects unsatisfiable ranges with 416", async () => {
    const clamped = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=900-5000" } });
    expect(clamped.status).toBe(206);
    expect(clamped.headers.get("Content-Range")).toBe("bytes 900-999/1000");

    const past = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=1000-" } });
    expect(past.status).toBe(416);
    expect(past.headers.get("Content-Range")).toBe("bytes */1000");

    const zeroSuffix = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=-0" } });
    expect(zeroSuffix.status).toBe(416);
    expect(zeroSuffix.headers.get("Content-Range")).toBe("bytes */1000");

    const garbage = await app.request(url("media/clip.mp4"), { headers: { Range: "bytes=zz" } });
    expect(garbage.status).toBe(416);
  });

  it("no-Range requests keep the 200 whole-file shape and now advertise Accept-Ranges", async () => {
    const res = await app.request(url("media/clip.mp4"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
  });

  it(".html stays text/plain by default and renders text/html ONLY under ?render=1", async () => {
    const plain = await app.request(url("media/mock.html"));
    expect(plain.headers.get("Content-Type")).toContain("text/plain");

    const rendered = await app.request(url("media/mock.html", "&render=1"));
    expect(rendered.headers.get("Content-Type")).toContain("text/html");
    expect(await rendered.text()).toBe("<h1>mock</h1>");

    // The opt-in is .html-scoped: render=1 on a non-html asset changes nothing.
    const video = await app.request(url("media/clip.mp4", "&render=1"));
    expect(video.headers.get("Content-Type")).toBe("video/mp4");
  });
});
