import { describe, it, expect } from "vitest";
import { createDaemon } from "../src/startup.js";
import type { RexRun } from "../src/domain/terminal/rex-transport.js";

describe("the daemon serves the Rex terminal provider", () => {
  it("answers `rig terminal status --provider rex` through the rex CLI and lists rex in the full status", async () => {
    const calls: string[][] = [];
    const rexRun: RexRun = async (argv) => {
      calls.push(argv);
      return argv.includes("server.version") ? '{"rex_version":"0.0.1792787366-g623b2d"}' : '{"instance_id":"inst-1"}';
    };
    const { app, db } = await createDaemon({ dbPath: ":memory:", rexRun });
    try {
      const one = await (await app.request("/api/terminal/status?provider=rex")).json() as { providers: Array<{ name: string; status: unknown; liveness: unknown }> };
      expect(one.providers).toEqual([{
        name: "rex",
        status: { provider: "rex", available: true, version: "0.0.1792787366-g623b2d", capabilities: { cli: true, "session.create": true, "session.new_window": true }, server: { instanceId: "inst-1" } },
        liveness: { alive: true },
      }]);
      expect(calls.every((argv) => argv[0] === "rex" && argv[1] === "--autostart=false")).toBe(true);
      const all = await (await app.request("/api/terminal/status")).json() as { providers: Array<{ name: string }> };
      expect(all.providers.map((p) => p.name)).toEqual(["herdr", "cmux", "rex"]);
    } finally {
      db.close();
    }
  });
});
