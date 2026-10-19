import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { LOGIN_FILES, author, existingArchive, expectLoginMessage, put } from "../../daemon/test/helpers/bundle-login-fixture.js";
import { bundleCommand } from "../src/commands/bundle.js";
import type { StatusDeps } from "../src/commands/status.js";

vi.mock("../src/daemon-lifecycle.js", async original => ({
  ...await original<typeof import("../src/daemon-lifecycle.js")>(),
  getDaemonStatus: async () => ({ state: "running", healthy: true }),
  getDaemonUrl: () => "http://fixture.invalid", daemonStatusGuard: () => true,
}));

// This policy test crosses the real archive/bootstrap boundary, with provider checks explicitly inert.
vi.mock("../../daemon/src/domain/rigspec-preflight.js", async original => ({
  ...await original<object>(), rigPreflight: async () => ({ ready: true, errors: [], warnings: [] }),
}));

describe("actionable harness-login bundle diagnostics", () => {
  let root: string, db: Database.Database, app: ReturnType<typeof createTestApp>["app"];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-login-cli-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS); app = createTestApp(db).app;
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  async function command(args: string[]) {
    const output: string[] = [];
    const spies = ["log", "error", "warn"].map(method => vi.spyOn(console, method as "log").mockImplementation((...parts) => { output.push(parts.join(" ")); }));
    const priorExit = process.exitCode; process.exitCode = undefined;
    const client = { post: async (route: string, body: unknown) => {
      const response = await app.request(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    } };
    try {
      const deps = { lifecycleDeps: {}, clientFactory: () => client } as unknown as StatusDeps;
      await new Command().exitOverride().addCommand(bundleCommand(deps)).parseAsync(["bundle", ...args], { from: "user" });
      return { output: output.join("\n"), exit: process.exitCode };
    } finally { process.exitCode = priorExit; for (const spy of spies) spy.mockRestore(); }
  }

  for (const json of [false, true]) {
    it(`author check explains each login finding (${json ? "JSON" : "human"})`, async () => {
      const folder = path.join(root, "author"); author(folder);
      for (const file of LOGIN_FILES) put(folder, `agents/worker/${file}`);
      const result = await command(["check", folder, ...(json ? ["--json"] : [])]);
      expect(result.exit).toBe(1);
      for (const file of LOGIN_FILES) expectLoginMessage(result.output, file);
    });

    it(`create explains the refusal (${json ? "JSON" : "human"})`, async () => {
      const folder = path.join(root, "author"); const spec = author(folder);
      for (const file of LOGIN_FILES) put(folder, `agents/worker/${file}`);
      const result = await command(["create", spec, "-o", path.join(root, "out.rigbundle"), ...(json ? ["--json"] : [])]);
      expect(result.exit).toBe(2);
      for (const file of LOGIN_FILES) expectLoginMessage(result.output, file);
    });

    for (const action of ["inspect", "install"] as const) {
      it(`${action} explains why the existing archive fails (${json ? "JSON" : "human"})`, async () => {
        const f = await existingArchive(root);
        const result = await command([action, f.archive, ...(action === "install" ? ["--plan"] : []), ...(json ? ["--json"] : [])]);
        expect(result.exit).toBe(2);
        for (const file of LOGIN_FILES) expectLoginMessage(result.output, file);
      });
    }

    it(`explicit create and its downstream notices remain visible (${json ? "JSON" : "human"})`, async () => {
      const folder = path.join(root, "author"); const spec = author(folder);
      for (const file of LOGIN_FILES) put(folder, `agents/worker/${file}`);
      const archive = path.join(root, "intentional.rigbundle");
      const created = await command(["create", spec, "-o", archive, "--include-login-files", ...(json ? ["--json"] : [])]);
      expect(created.exit).not.toBe(2); for (const file of LOGIN_FILES) expectLoginMessage(created.output, file);
      for (const action of ["inspect", "install"]) {
        const consumed = await command([action, archive, ...(action === "install" ? ["--plan"] : []), ...(json ? ["--json"] : [])]);
        expect(consumed.exit).toBeUndefined(); for (const file of LOGIN_FILES) expectLoginMessage(consumed.output, file);
        if (action === "install") expect(consumed.output).toMatch(/planned/);
      }
    });
  }
});
