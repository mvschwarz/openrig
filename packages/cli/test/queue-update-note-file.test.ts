import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { DaemonClient } from "../src/client.js";
import { queueCommand, resolveQueueNote } from "../src/commands/queue.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

const EXACT_NOTE =
  "Reviewed transition note with `raw backticks`, $HOME, 'single' & \"double\" quotes\nLine 2 ünïcode ☑\n\n";

let db: Database.Database;
let repo: QueueRepository;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let server: any;
let port = 0;
const seenRequests: Array<{ method: string; path: string }> = [];

const AMBIENT_KEYS = ["OPENRIG_URL", "RIGGED_URL", "OPENRIG_PORT"] as const;
const savedEnv: Record<string, string | undefined> = {};
function neutralizeAmbient(): void {
  for (const k of AMBIENT_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
}
function restoreAmbient(): void {
  for (const k of AMBIENT_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

beforeAll(async () => {
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  repo = new QueueRepository(db, bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => {
    seenRequests.push({ method: c.req.method, path: c.req.path });
    c.set("eventBus" as never, bus);
    c.set("queueRepo" as never, repo);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: { port: number }) => {
      port = info.port;
      resolve();
    });
  });
});

afterAll(async () => {
  restoreAmbient();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  db?.close();
});

function loopbackUrl(): string {
  return `http://127.0.0.1:${port}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deps(): any {
  return {
    lifecycleDeps: {
      spawn: () => ({ pid: 1, unref() {} }),
      fetch: async () => ({ ok: true }),
      kill: () => true,
      readFile: (p: string) =>
        p === STATE_FILE ? JSON.stringify({ pid: 1, port, host: "127.0.0.1", db: "x", startedAt: "x" }) : null,
      writeFile() {},
      removeFile() {},
      exists: (p: string) => p === STATE_FILE,
      mkdirp() {},
      openForAppend: () => 3,
      isProcessAlive: () => true,
    },
    clientFactory: (url: string) => {
      if (url !== loopbackUrl()) {
        throw new Error(`test-isolation guard: clientFactory url '${url}' !== loopback '${loopbackUrl()}'`);
      }
      return new DaemonClient(url);
    },
  };
}

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exit: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ol = console.log;
  const oe = console.error;
  const ow = process.stderr.write;
  console.log = (...a: unknown[]) => { stdout.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { stderr.push(a.join(" ")); };
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.exitCode = undefined;
  neutralizeAmbient();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await queueCommand(deps() as any).parseAsync(["node", "rig", ...args]);
  } finally {
    restoreAmbient();
    console.log = ol;
    console.error = oe;
    process.stderr.write = ow;
  }
  const exit = process.exitCode;
  process.exitCode = 0;
  return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), exit };
}

async function withStdin(bytes: string, fn: () => Promise<void>): Promise<void> {
  const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  const fake = new PassThrough();
  fake.end(bytes);
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  try {
    await fn();
  } finally {
    if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
    else delete (process as unknown as Record<string, unknown>).stdin;
    fake.destroy();
  }
}

type TransitionRow = { actor_session: string; state: string; transition_note: string | null; identity_provenance: string | null };
const transitions = (id: string) =>
  db.prepare(
    "SELECT actor_session, state, transition_note, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid",
  ).all(id) as TransitionRow[];

describe("resolveQueueNote unit tests", () => {
  it("returns undefined when neither --note nor --note-file is provided", async () => {
    expect(await resolveQueueNote({})).toBeUndefined();
  });

  it("returns inline --note verbatim including literal dash and trailing newlines", async () => {
    expect(await resolveQueueNote({ note: "inline note\n" })).toBe("inline note\n");
    expect(await resolveQueueNote({ note: "-" })).toBe("-");
  });

  it("reads exact UTF-8 bytes from --note-file without stripping trailing newlines", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-note-file-"));
    const notePath = path.join(tmp, "transition.md");
    fs.writeFileSync(notePath, EXACT_NOTE, "utf8");
    try {
      expect(await resolveQueueNote({ noteFile: notePath })).toBe(EXACT_NOTE);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads exact bytes from injected stdinReader when --note-file is -", async () => {
    const stdinReader = vi.fn(async () => EXACT_NOTE);
    expect(await resolveQueueNote({ noteFile: "-" }, stdinReader)).toBe(EXACT_NOTE);
    expect(stdinReader).toHaveBeenCalledTimes(1);
  });

  it("rejects when both --note and --note-file are passed without reading file or stdin", async () => {
    const stdinReader = vi.fn(async () => "ignored");
    await expect(resolveQueueNote({ note: "inline", noteFile: "-" }, stdinReader)).rejects.toMatchObject({
      fact: expect.stringMatching(/Both --note and --note-file/i),
      consequence: expect.stringMatching(/did not run/),
      action: expect.stringMatching(/--note or --note-file/),
    });
    expect(stdinReader).not.toHaveBeenCalled();

    await expect(resolveQueueNote({ note: "", noteFile: "/tmp/nonexistent.md" })).rejects.toMatchObject({
      fact: expect.stringMatching(/Both --note and --note-file/i),
    });
  });

  it("rejects missing --note-file and names the path", async () => {
    const missingPath = path.join(os.tmpdir(), "does-not-exist-queue-note-3903.md");
    await expect(resolveQueueNote({ noteFile: missingPath })).rejects.toMatchObject({
      fact: expect.stringContaining(missingPath),
      consequence: expect.stringMatching(/did not run/),
      action: expect.stringMatching(/--note-file -/),
    });
  });

  it("rejects directory passed to --note-file and names the path", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-note-dir-"));
    try {
      await expect(resolveQueueNote({ noteFile: tmp })).rejects.toMatchObject({
        fact: expect.stringContaining(tmp),
        consequence: expect.stringMatching(/did not run/),
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects empty --note-file path string", async () => {
    await expect(resolveQueueNote({ noteFile: "" })).rejects.toMatchObject({
      fact: expect.stringMatching(/--note-file path is empty/i),
      consequence: expect.stringMatching(/did not run/),
    });
  });

  it("rejects 0-byte --note-file and names the file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-note-empty-"));
    const notePath = path.join(tmp, "empty.md");
    fs.writeFileSync(notePath, "", "utf8");
    try {
      await expect(resolveQueueNote({ noteFile: notePath })).rejects.toMatchObject({
        fact: expect.stringContaining(notePath),
        consequence: expect.stringMatching(/did not run/),
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects 0-byte stdin on --note-file -", async () => {
    await expect(resolveQueueNote({ noteFile: "-" }, async () => "")).rejects.toMatchObject({
      fact: expect.stringMatching(/stdin \(--note-file -\) resolved to 0 bytes/i),
      consequence: expect.stringMatching(/did not run/),
    });
  });

  it("wraps stdin reader error on --note-file -", async () => {
    await expect(
      resolveQueueNote({ noteFile: "-" }, async () => { throw new Error("EIO: stdin broken"); }),
    ).rejects.toMatchObject({
      fact: expect.stringContaining("EIO: stdin broken"),
      consequence: expect.stringMatching(/did not run/),
    });
  });

  it.skipIf(process.getuid?.() === 0)("rejects unreadable --note-file and names the file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-note-unreadable-"));
    const notePath = path.join(tmp, "secret.md");
    fs.writeFileSync(notePath, "cannot read\n", "utf8");
    fs.chmodSync(notePath, 0o000);
    try {
      await expect(resolveQueueNote({ noteFile: notePath })).rejects.toMatchObject({
        fact: expect.stringContaining(notePath),
        consequence: expect.stringMatching(/did not run/),
      });
    } finally {
      fs.chmodSync(notePath, 0o600);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("rig queue update --note-file CLI integration", () => {
  let id: string;

  beforeEach(async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "dev-x@rig");
    seenRequests.length = 0;
    id = (await repo.create({ sourceSession: "orch@rig", destinationSession: "dev-x@rig", body: "work" })).qitemId;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("documents --note-file and stdin '-' in rig queue update --help", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cmd = queueCommand(deps() as any).commands.find((c) => c.name() === "update")!;
    const help = cmd.helpInformation();
    expect(help).toContain("--note-file <path>");
    expect(help).toMatch(/use - for stdin/i);
  });

  it("appends the exact file contents as transitionNote while leaving row state untouched", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-update-note-"));
    const notePath = path.join(tmp, "transition.md");
    fs.writeFileSync(notePath, EXACT_NOTE, "utf8");
    try {
      const before = repo.getByIdOrThrow(id);
      const { stderr, exit } = await runCli(["update", id, "--note-file", notePath, "--json"]);
      expect(exit, stderr).toBeFalsy();
      expect(repo.getByIdOrThrow(id).state).toBe(before.state);
      const last = transitions(id).at(-1)!;
      expect(last.transition_note).toBe(EXACT_NOTE);
      expect(last.actor_session).toBe("dev-x@rig");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes --note-file through on a state-changing close and verifies exact readback", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-update-close-note-"));
    const notePath = path.join(tmp, "close-note.md");
    fs.writeFileSync(notePath, EXACT_NOTE, "utf8");
    try {
      const { stderr, exit } = await runCli([
        "update", id, "--state", "done", "--closure-reason", "no-follow-on", "--note-file", notePath, "--json",
      ]);
      expect(exit, stderr).toBeFalsy();
      expect(repo.getByIdOrThrow(id)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
      expect(transitions(id).at(-1)?.transition_note).toBe(EXACT_NOTE);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads exact bytes from stdin when --note-file - is passed", async () => {
    await withStdin(EXACT_NOTE, async () => {
      const { stderr, exit } = await runCli(["update", id, "--note-file", "-", "--json"]);
      expect(exit, stderr).toBeFalsy();
    });
    expect(transitions(id).at(-1)?.transition_note).toBe(EXACT_NOTE);
  });

  it("works with --source <name>@external outside a managed seat", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-update-ext-note-"));
    const notePath = path.join(tmp, "routine-note.md");
    fs.writeFileSync(notePath, EXACT_NOTE, "utf8");
    try {
      const { stderr, exit } = await runCli([
        "update", id, "--source", "routine-nightly@external", "--note-file", notePath, "--json",
      ]);
      expect(exit, stderr).toBeFalsy();
      expect(transitions(id).at(-1)).toMatchObject({
        actor_session: "routine-nightly@external",
        transition_note: EXACT_NOTE,
        identity_provenance: "claimed:v1",
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([false, true])("rejects using --note and --note-file together without contacting daemon (json=%s)", async (json) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-update-both-"));
    const notePath = path.join(tmp, "note.md");
    fs.writeFileSync(notePath, "from file\n", "utf8");
    try {
      const before = repo.getByIdOrThrow(id);
      const beforeTxns = transitions(id).length;
      const { stdout, stderr, exit } = await runCli([
        "update", id, "--state", "in-progress", "--note", "inline", "--note-file", notePath,
        ...(json ? ["--json"] : []),
      ]);
      expect(exit).toBe(1);
      expect(seenRequests).toEqual([]);
      expect(repo.getByIdOrThrow(id)).toEqual(before);
      expect(transitions(id).length).toBe(beforeTxns);
      if (json) {
        const parsed = JSON.parse(stdout);
        expect(parsed.ok).toBe(false);
        expect(parsed.error.fact).toMatch(/--note and --note-file/);
      } else {
        expect(stderr).toMatch(/--note and --note-file/);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.each([false, true])("rejects missing --note-file, names the path, and leaves row untouched (json=%s)", async (json) => {
    const missingPath = path.join(os.tmpdir(), "missing-transition-note-3903.md");
    const before = repo.getByIdOrThrow(id);
    const beforeTxns = transitions(id).length;
    const { stdout, stderr, exit } = await runCli([
      "update", id, "--state", "done", "--closure-reason", "no-follow-on", "--note-file", missingPath,
      ...(json ? ["--json"] : []),
    ]);
    expect(exit).toBe(1);
    expect(seenRequests).toEqual([]);
    expect(repo.getByIdOrThrow(id)).toEqual(before);
    expect(transitions(id).length).toBe(beforeTxns);
    if (json) {
      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.fact).toContain(missingPath);
    } else {
      expect(stderr).toContain(missingPath);
    }
  });

  it.skipIf(process.getuid?.() === 0)("rejects unreadable --note-file, names the path, and leaves row untouched", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-update-unreadable-"));
    const notePath = path.join(tmp, "unreadable.md");
    fs.writeFileSync(notePath, "secret note\n", "utf8");
    fs.chmodSync(notePath, 0o000);
    try {
      const before = repo.getByIdOrThrow(id);
      const beforeTxns = transitions(id).length;
      const { stderr, exit } = await runCli([
        "update", id, "--state", "done", "--closure-reason", "no-follow-on", "--note-file", notePath,
      ]);
      expect(exit).toBe(1);
      expect(seenRequests).toEqual([]);
      expect(repo.getByIdOrThrow(id)).toEqual(before);
      expect(transitions(id).length).toBe(beforeTxns);
      expect(stderr).toContain(notePath);
    } finally {
      fs.chmodSync(notePath, 0o600);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects 0-byte --note-file even with --state and leaves row untouched", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-update-empty-"));
    const notePath = path.join(tmp, "empty.md");
    fs.writeFileSync(notePath, "", "utf8");
    try {
      const before = repo.getByIdOrThrow(id);
      const beforeTxns = transitions(id).length;
      const { stderr, exit } = await runCli([
        "update", id, "--state", "done", "--closure-reason", "no-follow-on", "--note-file", notePath,
      ]);
      expect(exit).toBe(1);
      expect(seenRequests).toEqual([]);
      expect(repo.getByIdOrThrow(id)).toEqual(before);
      expect(transitions(id).length).toBe(beforeTxns);
      expect(stderr).toContain(notePath);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
