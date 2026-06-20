import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { QueueDeps } from "../src/commands/queue.js";
import { resolveQueueBody } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";

/**
 * `rig queue` CLI tests — PL-004 Phase A revision (R1).
 *
 * Pattern mirrors compact-plan.test.ts: mock daemon-lifecycle to fake a
 * running daemon, inject a clientFactory that returns a stubbed HTTP client.
 * Tests assert: command parsing, HTTP request shape, non-2xx exit handling,
 * hot-potato error rendering. No real daemon, no DB, no network.
 */

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface StubResponse {
  status: number;
  data: unknown;
}

function makeDeps(opts?: {
  routes?: Record<string, StubResponse>;
}): { deps: QueueDeps; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const routes = opts?.routes ?? {};
  return {
    calls,
    deps: {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => {
          calls.push({ method: "GET", path });
          return routes[`GET ${path}`] ?? { status: 200, data: {} };
        }),
        getText: vi.fn(async (path: string) => {
          calls.push({ method: "GET", path });
          return { status: 200, data: "" };
        }),
        post: vi.fn(async (path: string, body: unknown) => {
          calls.push({ method: "POST", path, body });
          return routes[`POST ${path}`] ?? { status: 201, data: { qitemId: "qitem-test-1" } };
        }),
        delete: vi.fn(async (path: string) => {
          calls.push({ method: "DELETE", path });
          return { status: 204, data: null };
        }),
        postText: vi.fn(async (path: string) => {
          calls.push({ method: "POST", path });
          return { status: 200, data: "" };
        }),
        postExpectText: vi.fn(async (path: string) => {
          calls.push({ method: "POST", path });
          return { status: 200, data: "" };
        }),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

describe("rig queue CLI", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    process.exitCode = undefined;
  });

  it("queue is registered on createProgram with all R1 subcommands", async () => {
    const { deps } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    const queueCmd = program.commands.find((c) => c.name() === "queue");
    expect(queueCmd).toBeDefined();
    const subs = queueCmd!.commands.map((c) => c.name()).sort();
    // R1 ratified contract: handoff-and-complete + whoami present alongside the originals.
    expect(subs).toContain("create");
    expect(subs).toContain("handoff");
    expect(subs).toContain("handoff-and-complete");
    expect(subs).toContain("whoami");
    expect(subs).toContain("update");
    expect(subs).toContain("inbox-drop");
    expect(subs).toContain("inbox-absorb");
    expect(subs).toContain("inbox-deny");
    expect(subs).toContain("list");
    expect(subs).toContain("show");
  });

  it("create POSTs to /api/queue/create with sourceSession + destinationSession + body", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "qitem-x", state: "pending" } } },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@rig",
      "--destination", "bob@rig",
      "--body", "do thing",
      "--json",
    ]);
    const create = calls.find((c) => c.path === "/api/queue/create");
    expect(create).toBeDefined();
    const body = create!.body as Record<string, unknown>;
    expect(body.sourceSession).toBe("alice@rig");
    expect(body.destinationSession).toBe("bob@rig");
    expect(body.body).toBe("do thing");
    // R1: commander's --no-nudge sets opts.nudge to true by default.
    // The CLI sends nudge: true, and the daemon treats nudge !== false as nudging.
    expect(body.nudge).toBe(true);
  });

  it("create --no-nudge passes nudge: false to the daemon (cold-queue opt-out)", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@rig",
      "--destination", "bob@rig",
      "--body", "cold",
      "--no-nudge",
    ]);
    const create = calls.find((c) => c.path === "/api/queue/create");
    expect((create!.body as { nudge: boolean }).nudge).toBe(false);
  });

  // OPR.0.3.2.21.FR-4(a) — body input resolution kills the
  // backtick-corruption class. Three accepted shapes: --body inline,
  // --body-file <path>, --body / --body-file - for stdin. Exactly one
  // of --body / --body-file is required; mutual exclusion validates.
  describe("FR-4(a) — --body-file + stdin support", () => {
    it("resolveQueueBody returns inline body when --body is passed", async () => {
      const out = await resolveQueueBody({ body: "inline value" });
      expect(out).toBe("inline value");
    });

    it("resolveQueueBody reads from a file path when --body-file is passed", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-body-"));
      const bodyPath = path.join(tmp, "body.txt");
      const content = "Multi-line body with `raw backticks` and\nliteral newlines\n— this is the corruption class --body-file kills.";
      fs.writeFileSync(bodyPath, content, "utf8");
      try {
        const out = await resolveQueueBody({ bodyFile: bodyPath });
        expect(out).toBe(content);
        // Discriminator: the backtick-corruption shell class is bypassed
        // entirely because no shell substitution happens on file content.
        expect(out).toMatch(/`raw backticks`/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("resolveQueueBody throws 3-part error when both --body and --body-file are passed", async () => {
      await expect(resolveQueueBody({ body: "inline", bodyFile: "/tmp/x" })).rejects.toMatchObject({
        fact: expect.stringMatching(/mutually exclusive|ambiguous/i),
        consequence: expect.stringMatching(/did not run/),
        action: expect.stringMatching(/exactly one/),
      });
    });

    it("resolveQueueBody throws 3-part error when neither --body nor --body-file is passed", async () => {
      await expect(resolveQueueBody({})).rejects.toMatchObject({
        fact: expect.stringMatching(/Neither --body nor --body-file/),
        consequence: expect.stringMatching(/did not run/),
        action: expect.stringMatching(/--body|--body-file/),
      });
    });

    it("resolveQueueBody throws 3-part error when --body-file path does not exist", async () => {
      await expect(resolveQueueBody({ bodyFile: "/tmp/this-path-does-not-exist-fr4a-test.md" })).rejects.toMatchObject({
        fact: expect.stringMatching(/does not exist/),
        consequence: expect.stringMatching(/did not run/),
        action: expect.stringMatching(/Check the path/),
      });
    });

    // OPR.0.3.2.21.FR-4 cleanup (guard non-blocking note on FR-4a CLEAR): a
    // directory passed to --body-file used to fall through to fs.readFileSync
    // and surface a bare Error("EISDIR: illegal operation on a directory") with
    // blank consequence/action. The cleanup commit emits the 3-part shape
    // explicitly so the error reads consistently with the other body-resolve
    // failure modes.
    it("resolveQueueBody throws 3-part error when --body-file path is a directory (not a regular file)", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-body-isdir-"));
      try {
        await expect(resolveQueueBody({ bodyFile: tmp })).rejects.toMatchObject({
          fact: expect.stringMatching(/not a regular file/),
          consequence: expect.stringMatching(/did not run/),
          action: expect.stringMatching(/Pass a path to a readable file/),
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("resolveQueueBody calls the injected stdin reader when --body is -", async () => {
      const stdinReader = vi.fn(async () => "from stdin\n");
      const out = await resolveQueueBody({ body: "-" }, stdinReader);
      expect(out).toBe("from stdin\n");
      expect(stdinReader).toHaveBeenCalledTimes(1);
    });

    it("resolveQueueBody calls the injected stdin reader when --body-file is -", async () => {
      const stdinReader = vi.fn(async () => "from stdin file dash\n");
      const out = await resolveQueueBody({ bodyFile: "-" }, stdinReader);
      expect(out).toBe("from stdin file dash\n");
      expect(stdinReader).toHaveBeenCalledTimes(1);
    });

    it("create --body-file <file-with-backticks> POSTs the file content as body (operator-copy-paste-safe)", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-create-body-file-"));
      const bodyPath = path.join(tmp, "body.txt");
      const content = "Per-commit handoff for OPR.X.Y.Z\n\n```bash\nrig queue handoff qitem-1 --to next@rig\n```\n\nDone.";
      fs.writeFileSync(bodyPath, content, "utf8");
      try {
        const { deps, calls } = makeDeps({
          routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "qitem-fr4a-1", state: "pending" } } },
        });
        const program = createProgram({ queueDeps: deps });
        program.exitOverride();
        await program.parseAsync([
          "node", "rig", "queue", "create",
          "--source", "alice@rig",
          "--destination", "bob@rig",
          "--body-file", bodyPath,
          "--json",
        ]);
        const create = calls.find((c) => c.path === "/api/queue/create");
        expect(create, "expected POST /api/queue/create to fire").toBeDefined();
        const body = create!.body as Record<string, unknown>;
        expect(body.body).toBe(content);
        // Discriminator: the backtick fence survived intact, proving the
        // shell-substitution class never touched the content.
        expect((body.body as string)).toMatch(/```bash[\s\S]*?```/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("create with both --body and --body-file errors with exit 1 + 3-part error + does NOT contact the daemon", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-create-conflict-"));
      const bodyPath = path.join(tmp, "body.txt");
      fs.writeFileSync(bodyPath, "x", "utf8");
      try {
        const { deps, calls } = makeDeps();
        const program = createProgram({ queueDeps: deps });
        program.exitOverride();
        const prevExit = process.exitCode;
        process.exitCode = undefined;
        try {
          await program.parseAsync([
            "node", "rig", "queue", "create",
            "--source", "alice@rig",
            "--destination", "bob@rig",
            "--body", "inline",
            "--body-file", bodyPath,
            "--json",
          ]);
          expect(process.exitCode).toBe(1);
          expect(calls.find((c) => c.path === "/api/queue/create")).toBeUndefined();
        } finally {
          process.exitCode = prevExit;
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("create with neither --body nor --body-file errors with exit 1 + does NOT contact the daemon", async () => {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      const prevExit = process.exitCode;
      process.exitCode = undefined;
      try {
        await program.parseAsync([
          "node", "rig", "queue", "create",
          "--source", "alice@rig",
          "--destination", "bob@rig",
          "--json",
        ]);
        expect(process.exitCode).toBe(1);
        expect(calls.find((c) => c.path === "/api/queue/create")).toBeUndefined();
      } finally {
        process.exitCode = prevExit;
      }
    });
  });

  // OPR.0.3.2.21.FR-4(b) — --mission / --slice first-class flags
  // translate to mission:<id> / slice:<id> tags and compose with --tags.
  // This is tag-formalization only — no schema change; the qitem still
  // stores tags as a flat list.
  describe("FR-4(b) — --mission / --slice first-class flag-formalization", () => {
    it("--mission translates to a mission:<id> tag", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-fr4b-1" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "alice@rig",
        "--destination", "bob@rig",
        "--body", "x",
        "--mission", "release-0.3.2",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      expect((create!.body as { tags: string[] }).tags).toEqual(["mission:release-0.3.2"]);
    });

    it("--slice translates to a slice:<id> tag", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-fr4b-2" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "alice@rig",
        "--destination", "bob@rig",
        "--body", "x",
        "--slice", "21-fr-4-queue-ergonomics",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      expect((create!.body as { tags: string[] }).tags).toEqual(["slice:21-fr-4-queue-ergonomics"]);
    });

    it("--mission + --slice + --tags merges all three sets (mission/slice first, --tags appended) and de-duplicates", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-fr4b-3" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "alice@rig",
        "--destination", "bob@rig",
        "--body", "x",
        "--mission", "release-0.3.2",
        "--slice", "21-fr-4-queue-ergonomics",
        "--tags", "gate:guard,handoff:per-commit",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      expect((create!.body as { tags: string[] }).tags).toEqual([
        "mission:release-0.3.2",
        "slice:21-fr-4-queue-ergonomics",
        "gate:guard",
        "handoff:per-commit",
      ]);
    });

    it("--mission release-0.3.2 + --tags mission:release-0.3.2 de-duplicates the redundant tag (one mission:X kept)", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-fr4b-4" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "alice@rig",
        "--destination", "bob@rig",
        "--body", "x",
        "--mission", "release-0.3.2",
        "--tags", "mission:release-0.3.2,gate:guard",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      const tags = (create!.body as { tags: string[] }).tags;
      expect(tags.filter((t) => t === "mission:release-0.3.2")).toHaveLength(1);
      expect(tags).toContain("gate:guard");
    });

    it("no --mission/--slice/--tags → tags is undefined on the wire (legacy behavior preserved)", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-fr4b-5" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "alice@rig",
        "--destination", "bob@rig",
        "--body", "x",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      expect((create!.body as { tags?: string[] }).tags).toBeUndefined();
    });
  });

  it("update --state done WITHOUT --closure-reason renders structured hot-potato error and exits non-zero", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/queue/qitem-x/update": {
          status: 400,
          data: {
            error: "missing_closure_reason",
            message: "state=done requires closure_reason; valid values: handed_off_to, blocked_on, denied, canceled, no-follow-on, escalation",
            validReasons: ["handed_off_to", "blocked_on", "denied", "canceled", "no-follow-on", "escalation"],
          },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "update", "qitem-x",
      "--actor", "bob@rig",
      "--state", "done",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("missing_closure_reason");
    expect(out).toContain("validReasons");
  });

  it("handoff-and-complete POSTs to /api/queue/:id/handoff-and-complete with from + to", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/queue/qitem-src/handoff-and-complete": {
          status: 201,
          data: {
            closed: { state: "done", closureReason: "handed_off_to" },
            created: { state: "pending", qitemId: "qitem-new" },
          },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "handoff-and-complete", "qitem-src",
      "--from", "bob@rig",
      "--to", "carol@rig",
      "--body", "carol's piece",
      "--json",
    ]);
    const call = calls.find((c) => c.path === "/api/queue/qitem-src/handoff-and-complete");
    expect(call).toBeDefined();
    const body = call!.body as Record<string, unknown>;
    expect(body.fromSession).toBe("bob@rig");
    expect(body.toSession).toBe("carol@rig");
    expect(body.body).toBe("carol's piece");
  });

  it("whoami GETs /api/queue/whoami with session + recentLimit query params", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "GET /api/queue/whoami?session=bob%40rig&recentLimit=10": {
          status: 200,
          data: {
            session: "bob@rig",
            asDestination: { pending: 2, inProgress: 1, blocked: 0, recent: [] },
            asSource: { total: 5 },
          },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "whoami",
      "--session", "bob@rig",
      "--recent-limit", "10",
      "--json",
    ]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/whoami"));
    expect(call).toBeDefined();
    expect(call!.path).toContain("session=bob%40rig");
    expect(call!.path).toContain("recentLimit=10");
  });

  it("whoami defaults the session from OPENRIG_SESSION_NAME when --session is omitted", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "GET /api/queue/whoami?session=bob%40rig&recentLimit=25": {
            status: 200,
            data: {
              session: "bob@rig",
              asDestination: { pending: 1, inProgress: 0, blocked: 0, recent: [] },
              asSource: { total: 0 },
            },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "whoami", "--json"]);

      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/whoami"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("session=bob%40rig");
      expect(call!.path).toContain("recentLimit=25");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("claim defaults the destination from OPENRIG_SESSION_NAME when --destination is omitted", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "POST /api/queue/qitem-x/claim": {
            status: 200,
            data: { qitemId: "qitem-x", destinationSession: "bob@rig", state: "in-progress" },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "claim", "qitem-x", "--json"]);

      const call = calls.find((c) => c.path === "/api/queue/qitem-x/claim");
      expect(call).toBeDefined();
      expect((call!.body as { destinationSession: string }).destinationSession).toBe("bob@rig");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("update defaults the actor from OPENRIG_SESSION_NAME when --actor is omitted", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "POST /api/queue/qitem-x/update": {
            status: 200,
            data: { qitemId: "qitem-x", state: "done", closureReason: "no-follow-on" },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "update", "qitem-x",
        "--state", "done",
        "--closure-reason", "no-follow-on",
        "--json",
      ]);

      const call = calls.find((c) => c.path === "/api/queue/qitem-x/update");
      expect(call).toBeDefined();
      expect((call!.body as { actorSession: string }).actorSession).toBe("bob@rig");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("handoff defaults the source from OPENRIG_SESSION_NAME when --from is omitted", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "POST /api/queue/qitem-x/handoff": {
            status: 201,
            data: { closed: { state: "handed-off" }, created: { qitemId: "qitem-new" } },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "handoff", "qitem-x",
        "--to", "carol@rig",
        "--json",
      ]);

      const call = calls.find((c) => c.path === "/api/queue/qitem-x/handoff");
      expect(call).toBeDefined();
      expect((call!.body as { fromSession: string }).fromSession).toBe("bob@rig");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("create against unknown destination rig surfaces 400 error and exits non-zero", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/queue/create": {
          status: 400,
          data: {
            error: "unknown_destination_rig",
            message: "destination_session bob@phantom-rig references an unknown rig",
          },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@known-rig",
      "--destination", "bob@phantom-rig",
      "--body", "x",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("unknown_destination_rig");
  });

  it("handoff with --no-nudge passes nudge: false through to daemon", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/queue/qitem-x/handoff": {
          status: 201,
          data: { closed: {}, created: {} },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "handoff", "qitem-x",
      "--from", "bob@rig",
      "--to", "carol@rig",
      "--no-nudge",
    ]);
    const call = calls.find((c) => c.path === "/api/queue/qitem-x/handoff");
    expect((call!.body as { nudge: boolean }).nudge).toBe(false);
  });

  it("list constructs /api/queue/list with filter params", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "list",
      "--destination", "bob@rig",
      "--state", "pending",
      "--limit", "50",
      "--json",
    ]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
    expect(call).toBeDefined();
    expect(call!.path).toContain("destinationSession=bob%40rig");
    expect(call!.path).toContain("state=pending");
    expect(call!.path).toContain("limit=50");
    expect(call!.path).toContain("compact=1");
    expect(call!.path).not.toContain("as=");
    expect(call!.path).not.toContain("rig=");
  });

  it("list -a includes history (no activeOnly param)", async () => {
    const saved = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "dev1@my-rig";
    try {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "list", "-a", "--json"]);
      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
      expect(call).toBeDefined();
      expect(call!.path).not.toContain("activeOnly=");
      expect(call!.path).toContain("rig=my-rig");
      expect(call!.path).toContain("compact=1");
    } finally {
      if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved;
    }
  });

  it("list -A is cross-rig (no rig param)", async () => {
    const saved = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "dev1@my-rig";
    try {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "list", "-A", "--json"]);
      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
      expect(call).toBeDefined();
      expect(call!.path).not.toContain("rig=");
      expect(call!.path).toContain("activeOnly=1");
      expect(call!.path).toContain("compact=1");
    } finally {
      if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved;
    }
  });

  it("list --full --all --all-rigs = firehose (no compact, no active, no rig)", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "queue", "list", "--full", "--all", "--all-rigs", "--json"]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
    expect(call).toBeDefined();
    expect(call!.path).not.toContain("compact=");
    expect(call!.path).not.toContain("activeOnly=");
    expect(call!.path).not.toContain("rig=");
    expect(call!.path).not.toContain("as=");
  });

  it("list with --destination does not inject implicit rig scope", async () => {
    const saved = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "my-seat@my-rig";
    try {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "list", "--destination", "bob@rig", "--json"]);
      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("destinationSession=bob%40rig");
      expect(call!.path).toContain("compact=1");
      expect(call!.path).not.toContain("rig=");
      expect(call!.path).not.toContain("as=");
    } finally {
      if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved;
    }
  });

  it("list --mine scopes to caller session", async () => {
    const saved = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "dev1-driver@openrig-delivery";
    try {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "list", "--mine", "--json"]);
      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("as=dev1-driver%40openrig-delivery");
      expect(call!.path).not.toContain("rig=");
    } finally {
      if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved;
    }
  });

  it("list default injects rig=<rigName> + activeOnly=1 + compact=1", async () => {
    const saved = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "dev1-driver@openrig-delivery";
    try {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "list", "--json"]);
      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("rig=openrig-delivery");
      expect(call!.path).toContain("activeOnly=1");
      expect(call!.path).toContain("compact=1");
      expect(call!.path).not.toContain("as=");
    } finally {
      if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved;
    }
  });
});
