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
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    it("keeps range bytes and metadata on one file during atomic replacement", async () => {
      const file = join(tempDir, "workspace", "changing.bin");
      const payload = (size: number) => Buffer.from(`${size}\n${"A".repeat(size - String(size).length - 1)}`);
      writeFileSync(file, payload(4096));
      const control = new Int32Array(new SharedArrayBuffer(4));
      const writer = new Worker(`
        const { workerData, parentPort } = require("node:worker_threads");
        const fs = require("node:fs");
        const control = new Int32Array(workerData.control);
        const payload = size => Buffer.from(size + "\\n" + "A".repeat(size - String(size).length - 1));
        const sizes = [payload(4096), payload(64)];
        parentPort.postMessage("ready");
        let count = 0;
        while (Atomics.load(control, 0) === 0) {
          fs.writeFileSync(workerData.file + ".tmp", sizes[count++ % 2]);
          fs.renameSync(workerData.file + ".tmp", workerData.file);
        }
      `, { eval: true, workerData: { file, control: control.buffer } });
      const exited = new Promise<void>((resolve, reject) => {
        writer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Writer exited ${code}`)));
        writer.once("error", reject);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          writer.once("message", () => resolve());
          writer.once("error", reject);
        });
        for (let i = 0; i < 2000; i++) {
          const response = await app.request("/api/files/asset?root=workspace&path=changing.bin", {
            headers: { Range: "bytes=0-4095" },
          });
          const bytes = Buffer.from(await response.arrayBuffer());
          const encodedSize = Number(bytes.subarray(0, 8).toString().split("\n")[0]);
          expect(response.status).toBe(206);
          expect(bytes.length).toBe(encodedSize);
          expect(response.headers.get("content-length")).toBe(String(bytes.length));
          expect(response.headers.get("content-range")).toBe(`bytes 0-${bytes.length - 1}/${bytes.length}`);
          expect(bytes.includes(0)).toBe(false);
        }
      } finally {
        Atomics.store(control, 0, 1);
        await exited;
      }
    });

    it.each([
      ["bytes=0-3", 206, "bytes 0-3/8", 4],
      ["bytes=-3", 206, "bytes 5-7/8", 3],
      ["bytes=4-", 206, "bytes 4-7/8", 4],
      ["bytes=8-", 416, "bytes */8", 0],
      ["bytes=3-2", 416, "bytes */8", 0],
      ["not-a-range", 416, "bytes */8", 0],
    ])("retains ordinary range behavior for %s", async (range, status, contentRange, length) => {
      const response = await app.request("/api/files/asset?root=workspace&path=image.png", { headers: { Range: String(range) } });
      expect(response.status).toBe(status);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect((await response.arrayBuffer()).byteLength).toBe(length);
    });

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
      // P21 I5 NAMED DEFERRAL: header-absent (the UI/browser path) records the body actor stamped
      // the DECLARED claimed-era variant `claimed:v1` (PM pin — never null; null now = pre-sweep-legacy
      // ONLY, so a legacy row and a founder UI tap today stay distinguishable). Never refused/broken.
      expect((row as { identity_provenance: string | null }).identity_provenance).toBe("claimed:v1");
    });

    it.skipIf(process.platform === "win32")("preserves executable permissions when replacing a workspace script", async () => {
      const target = join(tempDir, "workspace", "check.sh");
      writeFileSync(target, "#!/bin/sh\nprintf old\n");
      chmodSync(target, 0o755);
      const expectedMtime = statSync(target).mtime.toISOString();
      const expectedContentHash = sha256(readFileSync(target));
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: "workspace", path: "check.sh", content: "#!/bin/sh\nprintf updated\n",
          expectedMtime, expectedContentHash, actor: "test@r",
        }),
      });
      expect(res.status).toBe(200);
      expect(statSync(target).mode & 0o777).toBe(0o755);
      expect(execFileSync(target, { encoding: "utf8" })).toBe("updated");
    });

    // P21 I5 — files write is a founder-visible surface; resolveActorWithDeferral splits the two paths:
    // header present (CLI/DaemonClient) => derive + transport:v1 + 409-on-mismatch; header absent
    // (browser UI) => claimed-era (NULL provenance), never-break (the named deferral, owner=dev50).
    it("write — header present derives the actor + stamps the audit identity_provenance transport:v1", async () => {
      const target = join(tempDir, "workspace", "STEERING.md");
      const expectedMtime = statSync(target).mtime.toISOString();
      const expectedContentHash = sha256(readFileSync(target));
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "cli@r" },
        body: JSON.stringify({ root: "workspace", path: "STEERING.md", content: "# via cli\n", expectedMtime, expectedContentHash }),
      });
      expect(res.status).toBe(200);
      const audit = readFileSync(join(tempDir, "audit.jsonl"), "utf-8").trim().split("\n");
      const row = JSON.parse(audit[audit.length - 1]!) as { actor: string; identity_provenance: string | null };
      expect(row.actor).toBe("cli@r");
      expect(row.identity_provenance).toBe("transport:v1");
    });

    it("write — header present + differing body actor → wire supersedes (actor cli@r, transport:v1); 409 retired", async () => {
      const target = join(tempDir, "workspace", "STEERING.md");
      const expectedMtime = statSync(target).mtime.toISOString();
      const expectedContentHash = sha256(readFileSync(target));
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "cli@r" },
        body: JSON.stringify({ root: "workspace", path: "STEERING.md", content: "x", expectedMtime, expectedContentHash, actor: "mallory@r" }), // superseded
      });
      expect(res.status).toBe(200);
      const audit = readFileSync(join(tempDir, "audit.jsonl"), "utf-8").trim().split("\n");
      const row = JSON.parse(audit[audit.length - 1]!) as { actor: string; identity_provenance: string | null };
      expect(row.actor).toBe("cli@r"); // wire wins; mallory@r superseded
      expect(row.identity_provenance).toBe("transport:v1");
    });

    it("write — header absent + no body actor → 400 actor_required (the deferral still needs some actor)", async () => {
      const target = join(tempDir, "workspace", "STEERING.md");
      const expectedMtime = statSync(target).mtime.toISOString();
      const expectedContentHash = sha256(readFileSync(target));
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: "workspace", path: "STEERING.md", content: "x", expectedMtime, expectedContentHash }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("actor_required");
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
