// UI Enhancement Pack v0 — files routes end-to-end tests.
//
// Drives the routes against a hand-mounted Hono app with a temp
// allowlist. Pins:
//   - GET /api/files/roots: empty roots → hint; populated → list
//   - GET /api/files/list: directory listing + path-safety negatives
//   - GET /api/files/read: content + mtime + contentHash + size
//   - GET /api/files/asset: image bytes with right Content-Type
//   - POST /api/files/write: success → audit row appended; mtime
//     mismatch → 409 with current{Mtime,ContentHash}
//   - 503 graceful path when filesAllowlist context unset

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesRoutes } from "../src/routes/files.js";
import { FileWriteService } from "../src/domain/files/file-write-service.js";
import type { AllowlistRoot } from "../src/domain/files/path-safety.js";

function buildApp(opts: { allowlist: AllowlistRoot[]; writeService: FileWriteService | null } | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (opts) {
      c.set("filesAllowlist" as never, opts.allowlist);
      c.set("fileWriteService" as never, opts.writeService);
    }
    await next();
  });
  app.route("/api/files", filesRoutes());
  return app;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("UI Enhancement Pack v0 — /api/files routes", () => {
  let tempDir: string;
  let allowlist: AllowlistRoot[];
  let writeService: FileWriteService;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "files-routes-"));
    mkdirSync(join(tempDir, "workspace", "subdir"), { recursive: true });
    writeFileSync(join(tempDir, "workspace", "STEERING.md"), "# steering content\n");
    writeFileSync(join(tempDir, "workspace", "subdir", "nested.md"), "# nested\n");
    // Tiny PNG signature for asset-type detection.
    writeFileSync(join(tempDir, "workspace", "image.png"), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    allowlist = [{ name: "workspace", canonicalPath: realpathSync(join(tempDir, "workspace")) }];
    writeService = new FileWriteService({
      allowlist,
      auditFilePath: join(tempDir, "audit.jsonl"),
    });
    app = buildApp({ allowlist, writeService });
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  describe("GET /roots", () => {
    it("returns 503 when filesAllowlist context is unset", async () => {
      const res = await buildApp(null).request("/api/files/roots");
      expect(res.status).toBe(503);
    });

    it("returns empty roots + setup hint when allowlist is empty", async () => {
      const res = await buildApp({ allowlist: [], writeService: null }).request("/api/files/roots");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { roots: AllowlistRoot[]; hint?: string };
      expect(body.roots).toEqual([]);
      expect(body.hint).toContain("OPENRIG_FILES_ALLOWLIST");
    });

    it("returns the configured roots", async () => {
      const res = await app.request("/api/files/roots");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { roots: Array<{ name: string; path: string }> };
      expect(body.roots).toEqual([{ name: "workspace", path: realpathSync(join(tempDir, "workspace")) }]);
    });
  });

  describe("GET /list", () => {
    it("lists root directory entries with type + size + mtime", async () => {
      const res = await app.request("/api/files/list?root=workspace&path=");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: Array<{ name: string; type: string }> };
      const names = body.entries.map((e) => e.name).sort();
      expect(names).toContain("STEERING.md");
      expect(names).toContain("subdir");
      expect(names).toContain("image.png");
    });

    it("sorts directories before files", async () => {
      const res = await app.request("/api/files/list?root=workspace&path=");
      const body = (await res.json()) as { entries: Array<{ name: string; type: string }> };
      const types = body.entries.map((e) => e.type);
      // First N entries are dirs.
      const dirCount = types.findIndex((t) => t !== "dir");
      const allDirsFirst = types.slice(0, dirCount === -1 ? types.length : dirCount).every((t) => t === "dir");
      expect(allDirsFirst).toBe(true);
    });

    it("rejects '..' escape with 400", async () => {
      const res = await app.request("/api/files/list?root=workspace&path=..%2F..%2F");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("path_escape");
    });

    it("rejects unknown root with 400", async () => {
      const res = await app.request("/api/files/list?root=does-not-exist&path=");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("root_unknown");
    });
  });

  describe("GET /read", () => {
    it("returns content + mtime + contentHash + size", async () => {
      const res = await app.request("/api/files/read?root=workspace&path=STEERING.md");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { content: string; mtime: string; contentHash: string; size: number };
      expect(body.content).toBe("# steering content\n");
      expect(body.contentHash).toBe(sha256("# steering content\n"));
      expect(body.size).toBeGreaterThan(0);
      expect(body.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("rejects path-traversal with 400", async () => {
      const res = await app.request("/api/files/read?root=workspace&path=..%2Fescape.md");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /asset", () => {
    it("serves a .png file with image/png Content-Type", async () => {
      const res = await app.request("/api/files/asset?root=workspace&path=image.png");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toContain("max-age");
    });
  });

  describe("POST /write", () => {
    it("returns 503 with hint when no writeService is wired", async () => {
      const res = await buildApp({ allowlist, writeService: null }).request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: "workspace", path: "STEERING.md", content: "x", expectedMtime: "x", expectedContentHash: "x", actor: "y" }),
      });
      expect(res.status).toBe(503);
    });

    it("rejects when expectedMtime mismatches with 409 + current values", async () => {
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: "workspace",
          path: "STEERING.md",
          content: "rewritten",
          expectedMtime: "2099-01-01T00:00:00.000Z",
          expectedContentHash: "deadbeef",
          actor: "test@r",
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; currentMtime: string; currentContentHash: string };
      expect(body.error).toBe("write_conflict");
      expect(body.currentContentHash).toBe(sha256("# steering content\n"));
    });

    it("succeeds when expectedMtime + expectedContentHash match; appends audit row", async () => {
      const target = join(tempDir, "workspace", "STEERING.md");
      const stat = statSync(target);
      const expectedMtime = stat.mtime.toISOString();
      const expectedContentHash = sha256(readFileSync(target));
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: "workspace",
          path: "STEERING.md",
          content: "# new steering\n",
          expectedMtime,
          expectedContentHash,
          actor: "test@r",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { newContentHash: string; byteCountDelta: number };
      expect(body.newContentHash).toBe(sha256("# new steering\n"));
      // File on disk has the new content.
      expect(readFileSync(target, "utf-8")).toBe("# new steering\n");
      // Audit row appended.
      const auditPath = join(tempDir, "audit.jsonl");
      const audit = readFileSync(auditPath, "utf-8").trim().split("\n");
      expect(audit).toHaveLength(1);
      const row = JSON.parse(audit[0]!) as { actor: string; root: string; path: string };
      expect(row.actor).toBe("test@r");
      expect(row.root).toBe("workspace");
      expect(row.path).toBe("STEERING.md");
    });

    it("rejects missing required fields with 400", async () => {
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: "workspace" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects path-traversal with 400 (path-safety beats stat)", async () => {
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: "workspace",
          path: "../escape.md",
          content: "x",
          expectedMtime: "x",
          expectedContentHash: "x",
          actor: "y",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("path_escape");
    });
  });
});
