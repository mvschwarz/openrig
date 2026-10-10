// Operator Surface Reconciliation v0 — files /read truncation tests.
//
// Pins item 5: GET /api/files/read caps returned content at
// FILE_READ_TRUNCATION_BYTES (1 MB) and surfaces truncation marker
// fields in the response. Hash is computed over the FULL file so
// edit-mode conflict detection stays honest even when the read is
// truncated.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_READ_TRUNCATION_BYTES, filesRoutes } from "../src/routes/files.js";
import { readAllowedFile } from "../src/local-reading-surface.js";
import type { AllowlistRoot } from "../src/domain/files/path-safety.js";

function buildApp(allowlist: AllowlistRoot[]): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("filesAllowlist" as never, allowlist);
    c.set("fileWriteService" as never, null);
    await next();
  });
  app.route("/api/files", filesRoutes());
  return app;
}

describe("Operator Surface Reconciliation v0 — /api/files/read truncation", () => {
  let tempDir: string;
  let allowlist: AllowlistRoot[];
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "files-trunc-"));
    mkdirSync(join(tempDir, "ws"), { recursive: true });
    allowlist = [{ name: "ws", canonicalPath: realpathSync(join(tempDir, "ws")) }];
    app = buildApp(allowlist);
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it("file <= 1 MB returns truncated=false + truncatedAtBytes=null + full content", async () => {
    const content = "small file content\n";
    writeFileSync(join(tempDir, "ws", "small.md"), content);
    const res = await app.request("/api/files/read?root=ws&path=small.md");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      content: string; truncated: boolean; truncatedAtBytes: number | null; totalBytes: number;
    };
    expect(body.truncated).toBe(false);
    expect(body.truncatedAtBytes).toBeNull();
    expect(body.totalBytes).toBe(content.length);
    expect(body.content).toBe(content);
  });

  it("file > 1 MB returns truncated=true + truncatedAtBytes=1048576 + capped content", async () => {
    // 1.5 MB synthetic file — first byte is 'H', rest is 'x' filler.
    const totalBytes = 1_572_864; // 1.5 MB
    const content = "H" + "x".repeat(totalBytes - 1);
    writeFileSync(join(tempDir, "ws", "large.md"), content);
    const res = await app.request("/api/files/read?root=ws&path=large.md");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      content: string;
      truncated: boolean;
      truncatedAtBytes: number | null;
      totalBytes: number;
      contentHash: string;
    };
    expect(body.truncated).toBe(true);
    expect(body.truncatedAtBytes).toBe(FILE_READ_TRUNCATION_BYTES);
    expect(body.totalBytes).toBe(totalBytes);
    // Content is capped at FILE_READ_TRUNCATION_BYTES (1 MB).
    expect(body.content.length).toBe(FILE_READ_TRUNCATION_BYTES);
    expect(body.content[0]).toBe("H");
    // Hash is computed over the FULL file, not the truncated slice —
    // edit-mode conflict detection stays honest even when a >1 MB file
    // is read truncated. (Editing such a file is operator-error
    // territory; the UI surfaces the truncation marker so the
    // operator knows to use an external editor.)
    const fullHash = createHash("sha256").update(content).digest("hex");
    expect(body.contentHash).toBe(fullHash);
  });

  it.each([["é", 1], ["界", 1], ["界", 2], ["😀", 1], ["😀", 2], ["😀", 3]] as const)(
    "keeps %s intact at a cap cutting after %s bytes in HTTP and the local reader", async (character, partialBytes) => {
      const prefix = "a".repeat(FILE_READ_TRUNCATION_BYTES - partialBytes);
      const content = prefix + character + " tail";
      writeFileSync(join(tempDir, "ws", "unicode.md"), content);
      const response = await app.request("/api/files/read?root=ws&path=unicode.md");
      expect(response.status).toBe(200);
      const http = await response.json();
      const local = readAllowedFile(allowlist, "ws", "unicode.md");
      for (const result of [http, local]) {
        expect(Buffer.byteLength(result.content)).toBe(Buffer.byteLength(prefix));
        expect(createHash("sha256").update(result.content).digest("hex")).toBe(createHash("sha256").update(prefix).digest("hex"));
        expect(result.binary).toBe(false);
        expect(result.truncated).toBe(true);
        expect(result.truncatedAtBytes).toBe(Buffer.byteLength(prefix));
        expect(result.totalBytes).toBe(Buffer.byteLength(content));
        expect(result.contentHash).toBe(createHash("sha256").update(content).digest("hex"));
        expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(FILE_READ_TRUNCATION_BYTES);
      }
    });

  it("keeps the byte cap and binary classification for an invalid UTF-8 file", () => {
    const bytes = Buffer.alloc(FILE_READ_TRUNCATION_BYTES + 2, 0x61);
    bytes[FILE_READ_TRUNCATION_BYTES - 1] = 0xff;
    writeFileSync(join(tempDir, "ws", "binary.dat"), bytes);
    const result = readAllowedFile(allowlist, "ws", "binary.dat");
    expect(result.binary).toBe(true);
    expect(result.truncatedAtBytes).toBe(FILE_READ_TRUNCATION_BYTES);
    expect(result.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("FILE_READ_TRUNCATION_BYTES is exactly 1 MB per PRD § Item 5", () => {
    expect(FILE_READ_TRUNCATION_BYTES).toBe(1_048_576);
  });
});
