import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { PackageRepository } from "../../daemon/src/domain/package-repository.js";
import { InstallRepository } from "../../daemon/src/domain/install-repository.js";
import { InstallEngine } from "../../daemon/src/domain/install-engine.js";
import { InstallVerifier } from "../../daemon/src/domain/install-verifier.js";
import { packagesRoutes } from "../../daemon/src/routes/packages.js";

const execute = promisify(execFile);
const entry = pathToFileURL(join(import.meta.dirname, "../src/commands/package.ts")).href;
const clientEntry = pathToFileURL(join(import.meta.dirname, "../src/client.ts")).href;
const tsx = pathToFileURL(join(import.meta.dirname, "../../../node_modules/tsx/dist/loader.mjs")).href;

describe("package commands from a directory different from the daemon", () => {
  const owned = mkdtempSync(join(tmpdir(), "openrig-package-cwd-"));
  const caller = join(owned, "caller");
  const packageDir = join(caller, "pkg");
  const db = createDb();
  let server: ReturnType<typeof serve>;
  let url: string;

  beforeAll(async () => {
    migrate(db, ALL_MIGRATIONS);
    mkdirSync(join(packageDir, "skills/helper"), { recursive: true });
    writeFileSync(join(packageDir, "package.yaml"), `schema_version: 1
name: caller-package
version: "1.0.0"
summary: Owned directory regression fixture
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/helper
      name: helper
      supported_scopes: [project_shared]
      default_scope: project_shared
`);
    writeFileSync(join(packageDir, "skills/helper/SKILL.md"), "# Owned helper\n");
    const packageRepo = new PackageRepository(db);
    const installRepo = new InstallRepository(db);
    const fsOps = {
      readFile: (path: string) => readFileSync(path, "utf8"),
      writeFile: (path: string, content: string) => writeFileSync(path, content),
      exists: (path: string) => { try { readFileSync(path); return true; } catch { return false; } },
      mkdirp: (path: string) => { mkdirSync(path, { recursive: true }); },
      copyFile: (from: string, to: string) => writeFileSync(to, readFileSync(from)),
      deleteFile: (path: string) => rmSync(path),
    };
    const deps: Record<string, unknown> = {
      packageRepo, installRepo,
      installEngine: new InstallEngine(installRepo, fsOps),
      installVerifier: new InstallVerifier(installRepo, packageRepo, fsOps),
      eventBus: new EventBus(db),
    };
    const app = new Hono();
    app.use("*", async (c, next) => {
      for (const [key, value] of Object.entries(deps)) c.set(key as never, value as never);
      await next();
    });
    app.route("/api/packages", packagesRoutes);
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
    rmSync(owned, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<string> {
    // A real child has its own cwd: changing the parent's cwd would also change
    // the daemon resolver and hide precisely this regression.
    const script = `
      import { packageCommand } from ${JSON.stringify(entry)};
      import { DaemonClient } from ${JSON.stringify(clientEntry)};
      const command = packageCommand({
        lifecycleDeps: {
          exists: () => true,
          readFile: () => JSON.stringify({pid: process.pid, port: ${new URL(url).port}, host: "127.0.0.1", db: "owned", startedAt: new Date().toISOString()}),
          isProcessAlive: () => true,
          fetch: async () => ({ok: true}),
        },
        clientFactory: () => new DaemonClient(${JSON.stringify(url)}),
      });
      await command.parseAsync(${JSON.stringify(args)}, {from: "user"});
    `;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      SystemRoot: process.env.SystemRoot,
      OPENRIG_HOME: join(owned, "home"),
    };
    return (await execute(process.execPath, ["--import", tsx, "--input-type=module", "-e", script], {
      cwd: caller, env, timeout: 10_000,
    })).stdout;
  }

  it("validates a relative package in the caller's directory", async () => {
    expect(await run(["validate", "./pkg"])).toContain("Valid: caller-package");
  });

  it("plans the default target in the caller's directory with an absolute source", async () => {
    const output = await run(["plan", packageDir]);
    expect(output).toContain(join(caller, ".claude/skills/helper/SKILL.md"));
  });

  it("installs a relative package into a relative caller-owned target", async () => {
    const output = await run(["install", "./pkg", "--target", "./destination"]);
    expect(output).toContain("Installed: caller-package");
    expect(readFileSync(join(caller, "destination/.claude/skills/helper/SKILL.md"), "utf8")).toBe("# Owned helper\n");
  });
});
