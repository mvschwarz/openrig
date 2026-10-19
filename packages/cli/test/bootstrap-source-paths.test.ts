import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { bootstrapCommand } from "../src/commands/bootstrap.js";
import { requirementsCommand } from "../src/commands/requirements.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

describe("bootstrap source paths respect the daemon target", () => {
  let root: string;
  let callerDir: string;
  let daemonDir: string;
  let server: http.Server;
  let deps: StatusDeps;
  let priorExitCode: typeof process.exitCode;
  let catalog: Array<Record<string, string>>;
  let requests: Array<{ url: string; sourceRef: string; content: string }>;
  let catalogReads: number;
  let daemonUrl: string;
  let bundleRequests: Array<Record<string, unknown>>;

  beforeEach(async () => {
    vi.stubEnv("OPENRIG_URL", undefined);
    vi.stubEnv("RIGGED_URL", undefined);
    vi.stubEnv("OPENRIG_HOST", undefined);
    vi.stubEnv("RIGGED_HOST", undefined);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap source paths-"));
    callerDir = path.join(root, "caller project");
    daemonDir = path.join(root, "daemon project");
    for (const directory of [callerDir, daemonDir]) {
      fs.mkdirSync(path.join(directory, "nested folder"), { recursive: true });
      for (const file of ["rig.yaml", "nested folder/team spec.yml", "unlisted"]) {
        fs.writeFileSync(path.join(directory, file), `name: ${directory === callerDir ? "caller" : "daemon"}\n`);
      }
    }
    catalog = [{ id: "catalog-id", name: "catalog-rig", kind: "rig", sourcePath: path.join(daemonDir, "rig.yaml") }];
    fs.writeFileSync(path.join(daemonDir, "remote-only.yaml"), "name: remote-only\n");
    requests = [];
    bundleRequests = [];
    catalogReads = 0;
    // The responder reads relative paths from a different root, like an already-running daemon.
    server = http.createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/specs/library") {
        catalogReads++;
        res.end(JSON.stringify(catalog));
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url === "/api/bundles/install") {
        bundleRequests.push(body);
      } else {
        const { sourceRef } = body as { sourceRef: string };
        const file = path.resolve(daemonDir, sourceRef);
        const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "missing";
        requests.push({ url: req.url!, sourceRef, content });
      }
      res.end(JSON.stringify({ status: req.url!.endsWith("plan") ? "planned" : "completed", stages: [], errors: [], warnings: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    daemonUrl = `http://127.0.0.1:${port}`;
    deps = {
      lifecycleDeps: {
        spawn: vi.fn(), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(),
        readFile: (p) => p === STATE_FILE ? JSON.stringify({ pid: 1, port, db: "test.sqlite", startedAt: "2026-10-13T00:00:00Z" }) : null,
        writeFile: vi.fn(), removeFile: vi.fn(), exists: (p) => p === STATE_FILE,
        mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true),
      },
      clientFactory: (url) => new DaemonClient(url),
    };
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process, "cwd").mockReturnValue(callerDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = priorExitCode;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run(command: string, source: string, args: string[] = []): Promise<void> {
    const program = new Command().exitOverride();
    program.addCommand(command === "bootstrap" ? bootstrapCommand(deps) : requirementsCommand(deps));
    await program.parseAsync(["node", "rig", command, source, ...args]);
  }

  const modes = [
    { command: "bootstrap", args: ["--plan"], route: "/api/bootstrap/plan" },
    { command: "bootstrap", args: ["--yes"], route: "/api/bootstrap/apply" },
    { command: "requirements", args: [], route: "/api/bootstrap/plan" },
  ];
  for (const mode of modes) {
    it.each(["rig.yaml", "./rig.yaml", "nested folder/team spec.yml"])
      (`${mode.command} ${mode.args.join(" ")} resolves %s before HTTP`, async (source) => {
        await run(mode.command, source, mode.args);
        expect(requests).toEqual([{ url: mode.route, sourceRef: path.join(callerDir, source), content: "name: caller\n" }]);
        expect(catalogReads).toBe(0);
        expect(process.exitCode).toBeUndefined();
      });

    it(`${mode.command} ${mode.args.join(" ")} preserves an absolute source`, async () => {
      const source = path.join(daemonDir, "nested folder/team spec.yml");
      await run(mode.command, source, mode.args);
      expect(requests).toEqual([{ url: mode.route, sourceRef: source, content: "name: daemon\n" }]);
      expect(catalogReads).toBe(0);
    });

    for (const envName of ["OPENRIG_URL", "RIGGED_URL"]) {
      it.each(["rig.yaml", "remote-only.yaml", "nested folder/team spec.yml"])
        (`${mode.command} ${mode.args.join(" ")} preserves %s with ${envName}, even on loopback`, async (source) => {
          vi.stubEnv(envName, daemonUrl); // A loopback URL may be a remote tunnel.
          if (envName === "RIGGED_URL") vi.stubEnv("OPENRIG_URL", "");
          await run(mode.command, source, mode.args);
          expect(requests).toEqual([{
            url: mode.route, sourceRef: source,
            content: source === "remote-only.yaml" ? "name: remote-only\n" : "name: daemon\n",
          }]);
          expect(catalogReads).toBe(0);
          expect(process.exitCode).toBeUndefined();
        });
    }

    it(`${mode.command} ${mode.args.join(" ")} preserves a remote POSIX path on a Windows-style caller`, async () => {
      vi.stubEnv("OPENRIG_URL", daemonUrl);
      const source = path.join(daemonDir, "rig.yaml");
      vi.spyOn(process, "cwd").mockReturnValue("C:\\caller project");
      const resolve = path.resolve;
      const windowsResolve = vi.fn(() => path.win32.resolve("C:\\caller project", source));
      vi.spyOn(path, "resolve").mockImplementation((...parts) =>
        parts.length === 1 && parts[0] === source ? windowsResolve() : resolve(...parts));
      await run(mode.command, source, mode.args);
      expect(requests).toEqual([{ url: mode.route, sourceRef: source, content: "name: daemon\n" }]);
      expect(windowsResolve).not.toHaveBeenCalled();
    });

    it.each(["OPENRIG_HOST", "RIGGED_HOST", "config-file", "default"])
      (`${mode.command} ${mode.args.join(" ")} preserves daemon-relative paths without local state (%s)`, async (selection) => {
        const host = selection === "default" ? "127.0.0.1" : "remote.example.invalid";
        vi.stubEnv("OPENRIG_HOME", path.join(root, "state"));
        if (selection === "config-file") {
          fs.mkdirSync(path.join(root, "state"));
          fs.writeFileSync(path.join(root, "state/config.json"), JSON.stringify({ daemon: { host } }));
        } else if (selection !== "default") vi.stubEnv(selection, host);
        deps.lifecycleDeps.readFile = () => null;
        deps.lifecycleDeps.exists = () => false;
        deps.clientFactory = vi.fn(() => new DaemonClient(daemonUrl));
        await run(mode.command, "remote-only.yaml", mode.args);
        const selectedUrl = vi.mocked(deps.clientFactory).mock.calls[0]![0];
        expect(new URL(selectedUrl).hostname).toBe(host);
        expect(requests).toEqual([{ url: mode.route, sourceRef: "remote-only.yaml", content: "name: remote-only\n" }]);
      });

    it(`${mode.command} ${mode.args.join(" ")} uses recorded local state over configured host`, async () => {
      vi.stubEnv("OPENRIG_HOST", "remote.example.invalid");
      await run(mode.command, "rig.yaml", mode.args);
      expect(requests).toEqual([{ url: mode.route, sourceRef: path.join(callerDir, "rig.yaml"), content: "name: caller\n" }]);
    });

    it.each([false, true])(`${mode.command} keeps stale state distinct from an explicit URL (%s)`, async (explicitUrl) => {
      deps.lifecycleDeps.isProcessAlive = () => false;
      vi.stubEnv("OPENRIG_HOST", "remote.example.invalid");
      if (explicitUrl) vi.stubEnv("OPENRIG_URL", daemonUrl);
      await run(mode.command, "rig.yaml", mode.args);
      expect(requests).toEqual(explicitUrl ? [{ url: mode.route, sourceRef: "rig.yaml", content: "name: daemon\n" }] : []);
      expect(process.exitCode).toBe(explicitUrl ? undefined : 1);
    });
  }

  it.each([[false, false], [false, true], [true, false], [true, true]])
    ("preserves catalog source paths (explicit URL=%s, plan=%s)", async (explicitUrl, plan) => {
      if (explicitUrl) vi.stubEnv("OPENRIG_URL", daemonUrl);
      await run("bootstrap", "catalog-rig", [plan ? "--plan" : "--yes"]);
      expect(catalogReads).toBe(1);
      expect(requests[0]?.sourceRef).toBe(catalog[0]!.sourcePath);
      expect(requests[0]?.content).toBe("name: daemon\n");
    });

  it.each([false, true])("preserves unresolved bare-name fallback (explicit URL=%s)", async (explicitUrl) => {
    if (explicitUrl) vi.stubEnv("OPENRIG_URL", daemonUrl);
    await run("bootstrap", "unlisted", ["--plan"]);
    expect(catalogReads).toBe(1);
    expect(requests[0]?.sourceRef).toBe("unlisted");
  });

  it.each([false, true])("does not rebase a daemon-supplied catalog source (explicit URL=%s)", async (explicitUrl) => {
    if (explicitUrl) vi.stubEnv("OPENRIG_URL", daemonUrl);
    catalog[0]!.sourcePath = "rig.yaml";
    await run("bootstrap", "catalog-rig", ["--plan"]);
    expect(requests[0]?.sourceRef).toBe("rig.yaml");
    expect(requests[0]?.content).toBe("name: daemon\n");
  });

  it.each([false, true])("still refuses ambiguous catalog names before posting (explicit URL=%s)", async (explicitUrl) => {
    if (explicitUrl) vi.stubEnv("OPENRIG_URL", daemonUrl);
    catalog.push({ ...catalog[0]!, id: "other-id", sourcePath: path.join(callerDir, "rig.yaml") });
    await run("bootstrap", "catalog-rig", ["--plan"]);
    expect(catalogReads).toBe(1);
    expect(requests).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])
    ("retains bundle addressing (explicit URL=%s, plan=%s)", async (explicitUrl, plan) => {
      if (explicitUrl) vi.stubEnv("OPENRIG_URL", daemonUrl);
      await run("bootstrap", "nested folder/team.rigbundle", [plan ? "--plan" : "--yes", "--target", "installed", "--cwd", "project"]);
      expect(bundleRequests).toEqual([expect.objectContaining({
        bundlePath: path.join(callerDir, "nested folder/team.rigbundle"),
        targetRoot: path.join(callerDir, "installed"), cwdOverride: path.join(callerDir, "project"),
        plan, autoApprove: !plan,
      })]);
      expect(requests).toEqual([]);
    });
});
