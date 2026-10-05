import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { ConfigStore } from "../../cli/src/config-store.js";
import { DaemonClient } from "../../cli/src/client.js";

describe("test instance environment", () => {
  // scripts/test-instance-isolation.test.mjs supplies only a disposable outer
  // home/database/HTTP server. Never run this discriminator against a real seat.
  it.skipIf(!process.env.OPENRIG_TEST_OUTER_INSTANCE)("exercises default database and endpoint routing", async () => {
    const file = new ConfigStore().resolve().db.path;
    mkdirSync(dirname(file), { recursive: true });
    const db = createDb(file);
    try { db.exec("CREATE TABLE IF NOT EXISTS isolation_probe (value TEXT)"); }
    finally { db.close(); }
    try {
      const response = await new DaemonClient().get("/api/test-isolation");
      expect(response.status).toBe(200);
    } catch (error) {
      // The isolated default is not a fixture server; the existing fetch guard
      // must reject it before any network request. The parent reaches the outer server.
      expect(String(error)).toContain("FETCH GUARD");
    }
  });

  it("preserves explicit fixture overrides made after setup", async () => {
    const root = mkdtempSync(join(tmpdir(), "instance-override-"));
    try {
      vi.stubEnv("OPENRIG_HOME", root);
      vi.stubEnv("OPENRIG_DB", join(root, "chosen.sqlite"));
      vi.stubEnv("OPENRIG_URL", "http://fixture.invalid:12345");
      expect(new ConfigStore().resolve().db.path).toBe(join(root, "chosen.sqlite"));
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
      const client = new DaemonClient(undefined, { fetchImpl });
      expect(client.baseUrl).toBe("http://fixture.invalid:12345");
      await client.get("/api/test-isolation");
      expect(fetchImpl).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
