import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexHome, authSeatsList, authSeatsReport } from "../src/domain/codex-auth.js";
import { readCodexAuthMetadata } from "../src/domain/provider/codex-auth-reader.js";
import { configuredSeatAccounts } from "../src/domain/provider/provider-seat-accounts.js";

it("reads owned CRLF seat registries consistently without phantom malformed rows", () => {
  const root = mkdtempSync(join(tmpdir(), "registry-crlf-"));
  const paths = resolveCodexHome({ CODEX_HOME: root });
  mkdirSync(paths.profileDir, { recursive: true });
  const stamp = "2026-10-30T00:00:00.000Z";
  const cwd = join(root, "owned workspace");
  writeFileSync(paths.registryPath, ["seat\trig\truntime\tcwd\tauth_profile\tupdated_ts", "", ["owned", "fixture", "codex", cwd, "alpha", stamp].join("\t"), "", ""].join("\r\n"));
  try {
    const metadata = readCodexAuthMetadata({ CODEX_HOME: root });
    expect(metadata.registry).toEqual({ status: "read", malformedRows: 0 });
    expect(metadata.seats).toEqual([{ seat: "owned", rig: "fixture", runtime: "codex", cwd, authProfile: "alpha", updatedTs: stamp }]);
    const rows = authSeatsList(paths);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seat: "owned", updatedTs: stamp });
    expect(authSeatsReport(paths).malformed).toBe(0);
    const accounts = configuredSeatAccounts({ seats: [{ seatSession: "owned", rigName: "fixture", runtime: "codex", lifecycleState: "active" }],
      auth: metadata, usage: [], claudeSamples: null, codexHome: root, home: root, claudeConfigDir: undefined });
    expect(accounts[0]?.configured).toMatchObject({ source: "registry", profileRef: "alpha", recordedAt: stamp });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
