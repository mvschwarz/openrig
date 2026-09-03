// Rig Context / Composable Context Injection — `rig context` CLI verb family
// tests (Atom-7 renamed the retired `context-pack` grammar to `rig context`).
//
// Stands up a small in-memory daemon mock for the /api/context-packs/*
// surface and exercises each subcommand against it.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { contextCommand } from "../src/commands/context.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(overrides?: Partial<LifecycleDeps>): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
    ...overrides,
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const errLogs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { errLogs.push(args.map(String).join(" ")); };
    process.exitCode = undefined;
    try { await fn(); } catch { /* commander.exitOverride */ }
    const exitCode = process.exitCode;
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExitCode;
    resolve({ logs, errLogs, exitCode });
  });
}

function runningDeps(port: number): StatusDeps {
  return {
    lifecycleDeps: mockLifecycleDeps({
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-05-04T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    }),
    clientFactory: (baseUrl) => new DaemonClient(baseUrl),
  };
}

const FIXTURE_PACK = {
  id: "context-pack:packs/smoke",
  kind: "context-pack" as const,
  name: "smoke",
  version: "1",
  purpose: "Smoke test pack",
  taxonomy: "mission",
  sourceType: "user_file" as const,
  sourcePath: "/home/op/.openrig/context/smoke",
  relativePath: "packs/smoke",
  updatedAt: "2026-05-04T00:00:00Z",
  manifestEstimatedTokens: null,
  derivedEstimatedTokens: 100,
  files: [
    { path: "notes.md", role: "notes", summary: "Smoke notes", absolutePath: "/abs/notes.md", bytes: 50, estimatedTokens: 13 },
  ],
};

const FIXTURE_PREVIEW = {
  id: FIXTURE_PACK.id,
  name: FIXTURE_PACK.name,
  version: FIXTURE_PACK.version,
  bundleText: "# OpenRig Context Pack: smoke v1\n\nSmoke test pack\n\n## File: notes.md (role: notes) — Smoke notes\n\nSmoke body\n",
  bundleBytes: 110,
  estimatedTokens: 28,
  files: [{ path: "notes.md", role: "notes", bytes: 50, estimatedTokens: 13 }],
  missingFiles: [] as Array<{ path: string; role: string }>,
};

describe("rig context CLI (PL-014)", () => {
  let server: http.Server;
  let port: number;
  let composeLog: Array<{ outRef?: string; sources?: Array<{ path: string; label: string }> }>;
  let deleteLog: string[];

  beforeAll(async () => {
    composeLog = [];
    deleteLog = [];
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const url = req.url ?? "";
        if (url === "/api/context-packs/library" && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([FIXTURE_PACK]));
          return;
        }
        if (url === "/api/context-packs/library/sync" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ count: 1, errors: [], entries: [FIXTURE_PACK] }));
          return;
        }
        if (url === "/api/context-packs/library/compose" && req.method === "POST") {
          const parsed = JSON.parse(body || "{}") as { outRef?: string; sources?: Array<{ path: string; label: string }> };
          composeLog.push(parsed);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ref: parsed.outRef, bytes: 4, estimatedTokens: 1, files: parsed.sources ?? [] }));
          return;
        }
        if (url.startsWith("/api/context-packs/library/by-ref")) {
          const parsedUrl = new URL(url, "http://x");
          const ref = parsedUrl.searchParams.get("ref");
          const json = (status: number, payload: unknown) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(payload));
          };
          if (!ref) return json(400, { error: "ref_required" });
          const unsafe = ref.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..");
          if (unsafe) return json(400, { error: "unsafe_ref", message: `unsafe pack ref '${ref}'` });
          if (ref !== FIXTURE_PACK.relativePath) return json(404, { error: "pack_not_found", message: `Context pack '${ref}' not found in library` });
          if (parsedUrl.pathname === "/api/context-packs/library/by-ref/preview" && req.method === "GET") {
            return json(200, FIXTURE_PREVIEW);
          }
          if (parsedUrl.pathname === "/api/context-packs/library/by-ref" && req.method === "GET") return json(200, FIXTURE_PACK);
          if (req.method === "DELETE") {
            deleteLog.push(ref);
            return json(200, { removed: true, ref, removedPath: FIXTURE_PACK.sourcePath, count: 0 });
          }
          return json(405, { error: "method_not_allowed" });
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => server.close());

  it("compose posts caller-resolved files to the delivery-free compose route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "context-compose-cli-"));
    const a = join(dir, "a.md");
    const b = join(dir, "b.md");
    writeFileSync(a, "A");
    writeFileSync(b, "B");
    try {
      composeLog.length = 0;
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "context", "compose", "--out", "packs/qitem-brief", "--from", a, b]);
      });
      expect(composeLog).toEqual([{
          outRef: "packs/qitem-brief",
          sources: [{ path: a, label: a }, { path: b, label: b }],
      }]);
      expect(logs.join("\n")).toContain("packs/qitem-brief");
      expect(exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeCmd(): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(contextCommand(runningDeps(port)));
    return prog;
  }

  function writePack(manifest: string): string {
    const dir = mkdtempSync(join(tmpdir(), "openrig-context-pack-test-"));
    writeFileSync(join(dir, "manifest.yaml"), manifest);
    return dir;
  }

  it("trace rejects explicitly blank --seat values while omission stays rig-level", async () => {
    const topologyRoot = mkdtempSync(join(tmpdir(), "openrig-context-trace-"));
    const savedTopologyRoot = process.env["OPENRIG_TOPOLOGY_ROOT"];
    process.env["OPENRIG_TOPOLOGY_ROOT"] = topologyRoot;
    try {
      for (const seat of ["", " \t "]) {
        const rejected = await captureLogs(async () => {
          await makeCmd().parseAsync([
            "node", "rig", "context", "trace",
            "--rig", "product-team", "--seat", seat, "--name", "CRAFT.md", "--json",
          ]);
        });
        expect(rejected.exitCode, JSON.stringify(seat)).toBe(1);
        expect(rejected.errLogs.join("\n"), JSON.stringify(seat)).toMatch(/invalid seat/i);
      }

      const omitted = await captureLogs(async () => {
        await makeCmd().parseAsync([
          "node", "rig", "context", "trace",
          "--rig", "product-team", "--name", "CRAFT.md", "--json",
        ]);
      });
      expect(omitted.exitCode).toBeUndefined();
      const result = JSON.parse(omitted.logs.join("")) as { levels: Array<{ altitude: string }> };
      expect(result.levels.map((level) => level.altitude)).toEqual(["instance", "rig"]);
    } finally {
      if (savedTopologyRoot === undefined) delete process.env["OPENRIG_TOPOLOGY_ROOT"];
      else process.env["OPENRIG_TOPOLOGY_ROOT"] = savedTopologyRoot;
      rmSync(topologyRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "path traversal",
      `name: invalid-pack
version: 1.0.0
taxonomy: world
files:
  - path: ../secret.md
    role: notes
`,
      "must be a relative path inside the pack",
    ],
    [
      "absolute path",
      `name: invalid-pack
version: 1.0.0
taxonomy: world
files:
  - path: /etc/passwd
    role: notes
`,
      "must be a relative path inside the pack",
    ],
    [
      "leading backslash",
      `name: invalid-pack
version: 1.0.0
taxonomy: world
files:
  - path: '\\evil.md'
    role: notes
`,
      "must be a relative path inside the pack",
    ],
    [
      "unknown suffix",
      `name: invalid-pack
version: 1.0.0
taxonomy: world
files:
  - path: secret.bin
    role: notes
`,
      "has an unsupported suffix",
    ],
    [
      "missing name",
      `version: 1.0.0
files:
  - path: notes.md
    role: notes
`,
      "missing required field 'name'",
    ],
    [
      "missing version",
      `name: invalid-pack
files:
  - path: notes.md
    role: notes
`,
      "missing required field 'version'",
    ],
    [
      "missing files",
      `name: invalid-pack
version: 1.0.0
taxonomy: world
`,
      "must declare 'files: [...]'",
    ],
    [
      "missing path",
      `name: invalid-pack
version: 1.0.0
taxonomy: world
files:
  - role: notes
`,
      "missing 'path'",
    ],
    [
      "missing role",
      `name: invalid-pack
version: 1.0.0
taxonomy: world
files:
  - path: notes.md
`,
      "missing 'role'",
    ],
    [
      "missing taxonomy (OPR.0.5.6.10 — teach at add time)",
      `name: invalid-pack
version: 1.0.0
files:
  - path: notes.md
    role: notes
`,
      "missing required field 'taxonomy'",
    ],
    [
      "non-enum taxonomy (OPR.0.5.6.10)",
      `name: invalid-pack
version: 1.0.0
taxonomy: doctrine
files:
  - path: notes.md
    role: notes
`,
      "invalid taxonomy",
    ],
  ])("rejects invalid context add manifest: %s", async (_name, manifest, expectedError) => {
    const dir = writePack(manifest);
    try {
      const { errLogs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "context", "add", dir]);
      });
      expect(exitCode).toBe(1);
      expect(errLogs.join("\n")).toContain(expectedError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list shows discovered packs", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "list"]);
    });
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("smoke");
    expect(logs.join("\n")).toContain("1 files");
  });

  it("list --json emits JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "list", "--json"]);
    });
    const parsed = JSON.parse(logs.join("")) as Array<{ name: string }>;
    expect(parsed[0]!.name).toBe("smoke");
  });

  it("show resolves by name", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "show", "smoke"]);
    });
    expect(logs.join("\n")).toContain("Name:        smoke");
    expect(logs.join("\n")).toContain("Smoke test pack");
  });

  it("show and preview resolve the exact path-like ref", async () => {
    const shown = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "show", "packs/smoke"]);
    });
    expect(shown.exitCode).toBeUndefined();
    expect(shown.logs.join("\n")).toContain("Name:        smoke");
    const previewed = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "preview", "packs/smoke"]);
    });
    expect(previewed.exitCode).toBeUndefined();
    expect(previewed.logs.join("\n")).toContain("Smoke body");
  });

  it("rejects legacy colon-id addressing with an actionable ref migration", async () => {
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "show", "context-pack:smoke:1"]);
    });
    expect(exitCode).toBe(1);
    expect(errLogs.join("\n")).toMatch(/colon-id addressing.*removed/);
    expect(errLogs.join("\n")).toMatch(/path-like ref/);
  });

  it("show fails with helpful error on unknown name", async () => {
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "show", "missing-pack"]);
    });
    expect(exitCode).toBe(1);
    expect(errLogs.join("\n")).toContain("not found in library");
  });

  it("preview prints the assembled bundle text", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "preview", "smoke"]);
    });
    expect(logs.join("\n")).toContain("# OpenRig Context Pack: smoke v1");
    expect(logs.join("\n")).toContain("Smoke body");
  });

  // OPR.0.5.3.7 R1 — the pull verb: `get` serves the assembled bundle for an agent, over the same
  // assembler path as preview, but WITHOUT the operator preview framing.
  it("get serves the assembled bundle bytes for agent pull (no operator preview framing)", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "get", "smoke"]);
    });
    const out = logs.join("\n");
    expect(out).toContain("# OpenRig Context Pack: smoke v1"); // the bundle content itself
    expect(out).toContain("Smoke body");
    expect(out).not.toContain("# Preview:"); // no operator framing on the pull verb
    expect(out).not.toContain("# Bundle:");
    expect(exitCode).toBeUndefined();
  });

  it("get --json returns the structured bundle wire", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "get", "smoke", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.name).toBe("smoke");
    expect(parsed.bundleText).toContain("Smoke body");
  });

  it("is a delivery-free noun: no send subcommand or send help", () => {
    const command = contextCommand(runningDeps(port));
    expect(command.commands.map((sub) => sub.name())).not.toContain("send");
    expect(command.helpInformation()).not.toMatch(/rig context send|\bsend\b/i);
  });

  it("sync reports indexed count", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "sync"]);
    });
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("Indexed 1 context pack");
  });

  it("rm removes a pack by its path-like ref and reports success", async () => {
    deleteLog.length = 0;
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "rm", "packs/smoke"]);
    });
    expect(exitCode).toBeUndefined();
    expect(deleteLog).toEqual(["packs/smoke"]);
    expect(logs.join("\n")).toMatch(/Removed .*packs\/smoke/);
  });

  it("rm --json emits the structured removal result", async () => {
    deleteLog.length = 0;
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "rm", "packs/smoke", "--json"]);
    });
    expect(exitCode).toBeUndefined();
    expect(JSON.parse(logs.join(""))).toMatchObject({ removed: true, ref: "packs/smoke" });
  });

  it("rm surfaces unsafe and absent ref errors without a delete", async () => {
    deleteLog.length = 0;
    const unsafe = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "rm", "../escape"]);
    });
    expect(unsafe.exitCode).toBe(1);
    expect(unsafe.errLogs.join("\n")).toMatch(/unsafe/);
    const absent = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "context", "rm", "packs/absent"]);
    });
    expect(absent.exitCode).toBe(1);
    expect(absent.errLogs.join("\n")).toContain("not found");
    expect(deleteLog).toEqual([]);
  });

  // ── OPR.0.5.3.7 R4 — `rig context add <url>` (external load) ──────────────
  async function startPackServer(
    files: Record<string, string>,
    redirects: Record<string, string> = {},
  ): Promise<{ baseUrl: string; close: () => void }> {
    const srv = http.createServer((req, res) => {
      const p = (req.url ?? "/").replace(/^\//, "");
      if (Object.prototype.hasOwnProperty.call(redirects, p)) {
        res.writeHead(302, { location: redirects[p] });
        res.end();
        return;
      }
      if (Object.prototype.hasOwnProperty.call(files, p)) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(files[p]);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port2 = (srv.address() as { port: number }).port;
    return { baseUrl: `http://127.0.0.1:${port2}/`, close: () => srv.close() };
  }

  async function withContextRoot(fn: (root: string) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "openrig-r4-context-root-"));
    const saved = process.env["OPENRIG_CONTEXT_ROOT"];
    process.env["OPENRIG_CONTEXT_ROOT"] = root;
    try {
      await fn(root);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_CONTEXT_ROOT"];
      else process.env["OPENRIG_CONTEXT_ROOT"] = saved;
      rmSync(root, { recursive: true, force: true });
    }
  }

  const R4_MANIFEST = "name: url-pack\nversion: 1.0.0\ntaxonomy: world\nfiles:\n  - path: SKILL.md\n    role: instruction\n";

  it("add <url>: installs into the OPENRIG_CONTEXT_ROOT landing zone (config-resolved, no hardcoded path)", async () => {
    const pack = await startPackServer({ "manifest.yaml": R4_MANIFEST, "SKILL.md": "# hello\nbody\n" });
    try {
      await withContextRoot(async (root) => {
        const { exitCode } = await captureLogs(async () => {
          await makeCmd().parseAsync(["node", "rig", "context", "add", `${pack.baseUrl}manifest.yaml`]);
        });
        expect(exitCode).toBeUndefined();
        expect(existsSync(join(root, "url-pack", "manifest.yaml"))).toBe(true);
        expect(readFileSync(join(root, "url-pack", "SKILL.md"), "utf-8")).toContain("body");
      });
    } finally {
      pack.close();
    }
  });

  it("add <url>: follows a redirected manifest and resolves files from the FINAL url (r2 MEDIUM-1)", async () => {
    // /redirect-manifest -> 302 -> /pack/manifest.yaml; SKILL.md must resolve
    // against the FINAL manifest dir (/pack/), not the caller's original root.
    const pack = await startPackServer(
      { "pack/manifest.yaml": R4_MANIFEST, "pack/SKILL.md": "# hi\nredirected body\n" },
      { "redirect-manifest": "/pack/manifest.yaml" },
    );
    try {
      await withContextRoot(async (root) => {
        const { exitCode } = await captureLogs(async () => {
          await makeCmd().parseAsync(["node", "rig", "context", "add", `${pack.baseUrl}redirect-manifest`, "--name", "redirected-pack"]);
        });
        expect(exitCode).toBeUndefined();
        expect(readFileSync(join(root, "redirected-pack", "SKILL.md"), "utf-8")).toContain("redirected body");
      });
    } finally {
      pack.close();
    }
  });

  it("add <url>: refuses an absolute-URL file that would escape the pack origin, leaves NO partial (r2 HIGH-1)", async () => {
    // The validator accepts a URL-shaped .md path; new URL() would honor it and
    // fetch cross-origin. The boundary guard must refuse before any fetch.
    const absManifest = "name: evil-pack\nversion: 1.0.0\ntaxonomy: world\nfiles:\n  - path: http://127.0.0.1:1/secret.md\n    role: instruction\n";
    const pack = await startPackServer({ "manifest.yaml": absManifest });
    try {
      await withContextRoot(async (root) => {
        const { errLogs, exitCode } = await captureLogs(async () => {
          await makeCmd().parseAsync(["node", "rig", "context", "add", `${pack.baseUrl}manifest.yaml`]);
        });
        expect(exitCode).toBe(1);
        expect(errLogs.join("\n")).toMatch(/outside the pack directory/i);
        expect(readdirSync(root)).toEqual([]); // no partial pack AND no leaked staging temp
      });
    } finally {
      pack.close();
    }
  });

  it("add <url>: unreachable URL fails loud with the reason and leaves NO partial pack", async () => {
    await withContextRoot(async (root) => {
      const { errLogs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "context", "add", "http://127.0.0.1:1/manifest.yaml"]);
      });
      expect(exitCode).toBe(1);
      expect(errLogs.join("\n")).toMatch(/could not (reach|fetch) manifest/i);
      expect(readdirSync(root)).toEqual([]); // no partial pack AND no leaked staging temp
    });
  });

  it("add <url>: malformed manifest fails loud with the reason and leaves NO partial pack", async () => {
    const pack = await startPackServer({ "manifest.yaml": "name: bad\nversion: 1.0.0\ntaxonomy: world\nfiles:\n  - path: ../escape.md\n    role: x\n" });
    try {
      await withContextRoot(async (root) => {
        const { errLogs, exitCode } = await captureLogs(async () => {
          await makeCmd().parseAsync(["node", "rig", "context", "add", `${pack.baseUrl}manifest.yaml`]);
        });
        expect(exitCode).toBe(1);
        expect(errLogs.join("\n")).toContain("must be a relative path inside the pack");
        expect(readdirSync(root)).toEqual([]); // no partial pack AND no leaked staging temp
      });
    } finally {
      pack.close();
    }
  });

  it("add <url>: a declared file that 404s fails loud and leaves NO partial pack", async () => {
    // manifest declares SKILL.md but the server does not serve it
    const pack = await startPackServer({ "manifest.yaml": R4_MANIFEST });
    try {
      await withContextRoot(async (root) => {
        const { errLogs, exitCode } = await captureLogs(async () => {
          await makeCmd().parseAsync(["node", "rig", "context", "add", `${pack.baseUrl}manifest.yaml`]);
        });
        expect(exitCode).toBe(1);
        expect(errLogs.join("\n")).toMatch(/could not fetch file 'SKILL\.md'/i);
        expect(existsSync(join(root, "url-pack"))).toBe(false);
        expect(readdirSync(root)).toEqual([]); // no partial pack AND no leaked staging temp
      });
    } finally {
      pack.close();
    }
  });
});
