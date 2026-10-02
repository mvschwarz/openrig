import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseEnvFile, resolveSecret } from "../src/domain/gateway/slack/secrets.js";
import { callWebApi, type FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

it("authenticates with unquoted, single-quoted and double-quoted file secrets", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "openrig-slack-secret-"));
  const token = "synthetic-fixture-token";
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.headers.authorization === `Bearer ${token}`
      ? { ok: true } : { ok: false, error: "invalid_auth" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    // Only the transport destination is redirected: native fetch still carries
    // the production client's actual Authorization header to a local server.
    const fetchImpl: FetchImpl = (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init);
    const envFile = join(scratch, "secret.env");
    for (const quote of ["", "'", '"']) {
      writeFileSync(envFile, `SLACK_BOT_TOKEN=${quote}${token}${quote}\n`, { mode: 0o600 });
      const resolved = resolveSecret("SLACK_BOT_TOKEN", { env: {}, envFile });
      expect(resolved).toBe(token);
      expect((await callWebApi("auth.test", resolved!, {}, fetchImpl, 1000)).ok).toBe(true);
      expect(resolveSecret("SLACK_BOT_TOKEN", { env: { SLACK_BOT_TOKEN: "env-wins" }, envFile })).toBe("env-wins");
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("preserves unmatched quotes and quote characters within unquoted values", () => {
  const values = ['"prefix', 'suffix"', "'prefix", "suffix'", "a'b", 'a"b', "'mixed\"", '"mixed\''];
  for (const value of values) {
    expect(parseEnvFile(`TOKEN=${value}\n`).TOKEN).toBe(value);
  }
});
