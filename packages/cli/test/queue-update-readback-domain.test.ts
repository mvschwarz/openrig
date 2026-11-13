import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import type Database from "better-sqlite3";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { runProgram } from "../src/cli-error.js";
import { queueCommand } from "../src/commands/queue.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";

type UpdateTransform = (body: Record<string, unknown>) => Record<string, unknown> | null;
/** The nth read of the row's transitions (0 is the cursor read before the write): a response, or a throw for no answer. */
type TransitionsRead = (call: number) => { status: number; data: unknown } | undefined;

let database: Database.Database;
let repo: QueueRepository;

async function runUpdate(qitemId: string, args: string[], transform: UpdateTransform = (body) => body, transitionsRead?: TransitionsRead) {
  let transitionReads = 0;
  let posts = 0;
  let exits = 0;
  const output: string[] = [];
  const errors: string[] = [];
  const program = new Command();
  program.addCommand(queueCommand({
    lifecycleDeps: {
      spawn: () => ({ pid: 1, unref() {} }),
      fetch: async () => ({ ok: true }),
      kill: () => true,
      readFile: (file: string) => file === STATE_FILE
        ? JSON.stringify({ pid: 1, port: 7433, host: "127.0.0.1", db: "test", startedAt: "test" })
        : null,
      writeFile() {},
      removeFile() {},
      exists: (file: string) => file === STATE_FILE,
      mkdirp() {},
      openForAppend: () => 3,
      isProcessAlive: () => true,
    },
    clientFactory: () => ({
      senderIdentity: async () => ({ session: "reviewer@fixture", originUnknown: false }),
      get: async (route: string) => route.endsWith("/transitions")
        ? transitionsRead?.(transitionReads++) ?? { status: 200, data: repo.listTransitions(qitemId) }
        : { status: 200, data: repo.getById(qitemId) },
      post: async (_route: string, rawBody: unknown) => {
        posts += 1;
        const body = transform(structuredClone(rawBody as Record<string, unknown>));
        return {
          status: 200,
          data: body === null
            ? repo.getById(qitemId)
            : repo.update({ ...body, qitemId, actorSession: "reviewer@fixture" }),
        };
      },
    }) as never,
  }));
  // No exit status is reset here: each run's status is runProgram's to start clean.
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  console.error = (...values: unknown[]) => errors.push(values.join(" "));
  try {
    const code = await runProgram(program, ["node", "rig", "queue", "update", qitemId, ...args, "--json"], {
      out: (value) => output.push(value),
      err: (value) => errors.push(value),
      exit: () => { exits += 1; },
    });
    return { code, output, errors, row: repo.getByIdOrThrow(qitemId), transitions: repo.listTransitions(qitemId), posts, exits };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function claimedRow(): Promise<string> {
  const row = await repo.create({
    sourceSession: "reviewer@fixture",
    destinationSession: "reviewer@fixture",
    body: "work",
    nudge: false,
  });
  repo.claim({ qitemId: row.qitemId, destinationSession: "reviewer@fixture" });
  return row.qitemId;
}

describe("queue update canonical read-back against daemon domain semantics", () => {
  beforeAll(() => {
    database = createDb();
    migrate(database, ALL_MIGRATIONS);
    const bus = new EventBus(database);
    repo = new QueueRepository(database, bus, {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
    });
    repo.attachOutbox(new OutboxHandler(database));
  });

  beforeEach(() => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "reviewer@fixture");
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  afterAll(() => database.close());

  it("accepts a closing resolution appended after an existing fallback resolution", async () => {
    const row = await repo.create({
      sourceSession: "reviewer@fixture",
      destinationSession: "worker@fixture",
      body: "work",
      nudge: false,
    });
    repo.routeToFallback(row.qitemId, "reviewer@fixture", "worker unavailable");
    repo.claim({ qitemId: row.qitemId, destinationSession: "reviewer@fixture" });

    const result = await runUpdate(row.qitemId, [
      "--state", "done", "--closure-reason", "no-follow-on", "--resolution", "Handled by reviewer",
    ]);

    expect(result.code, [...result.errors, ...result.output].join("\n")).toBe(0);
    expect(result.row.resolution).toBe("fallback: worker unavailable\nHandled by reviewer");
  });

  it("accepts close, reopen, and reclose while preserving each resolution line", async () => {
    const qitemId = await claimedRow();
    const first = await runUpdate(qitemId, [
      "--state", "done", "--closure-reason", "no-follow-on", "--resolution", "first outcome",
    ]);
    const reopened = await runUpdate(qitemId, ["--state", "pending", "--reopen", "--note", "repair requested"]);
    const second = await runUpdate(qitemId, [
      "--state", "done", "--closure-reason", "no-follow-on", "--resolution", "second outcome",
    ]);

    expect([first.code, reopened.code, second.code], [first.errors, reopened.errors, second.errors].flat().join("\n"))
      .toEqual([0, 0, 0]);
    expect(second.row.resolution).toBe("first outcome\nsecond outcome");
  });

  it.each([
    "2026-11-14T10:00:00Z",
    "2026-11-14T12:00:00+02:00",
  ])("accepts equivalent deadline spelling %s after daemon normalization", async (deadline) => {
    const qitemId = await claimedRow();
    const result = await runUpdate(qitemId, [
      "--closure-required-at", deadline, "--note", "Accepted revised deadline",
    ]);

    expect(result.code, result.errors.join("\n")).toBe(0);
    expect(result.row.closureRequiredAt).toBe("2026-11-14T10:00:00.000Z");
  });

  it("rejects a genuinely different stored deadline", async () => {
    const qitemId = await claimedRow();
    repo.update({
      qitemId,
      actorSession: "reviewer@fixture",
      closureRequiredAt: "2026-11-14T09:00:00Z",
      transitionNote: "initial deadline",
    });
    const result = await runUpdate(qitemId, [
      "--closure-required-at", "2026-11-14T10:00:00Z", "--note", "Accepted revised deadline",
    ], () => null);

    expect(result.code).toBe(1);
    expect(result.errors.join("\n")).toContain("closureRequiredAt");
  });

  it("rejects a close whose requested resolution was dropped", async () => {
    const qitemId = await claimedRow();
    const result = await runUpdate(qitemId, [
      "--state", "done", "--closure-reason", "no-follow-on", "--resolution", "must persist",
    ], (body) => {
      delete body.resolution;
      return body;
    });

    expect(result.code).toBe(1);
    expect(result.row.state).toBe("done");
    expect(result.row.resolution).toBeNull();
    expect(result.errors.join("\n")).toContain("resolution");
  });

  it("requires a newer canonical transition carrying the requested note", async () => {
    const qitemId = await claimedRow();
    const before = repo.listTransitions(qitemId).length;
    const result = await runUpdate(qitemId, ["--note", "must persist"], () => null);

    expect(result.code).toBe(1);
    expect(result.transitions).toHaveLength(before);
    expect(result.errors.join("\n")).toContain("no newer canonical transition carried requested note");
  });

  // The cursor read before the write only proves a note is new afterwards. When it fails, the write is still sent and
  // persists; the receipt says the note can't be shown to be new and exits non-zero, even with an older transition
  // already carrying the same note.
  it.each([
    ["doesn't answer", () => { throw new Error("socket hang up (fixture)"); }],
    ["answers HTTP 503", () => ({ status: 503, data: { error: "busy" } })],
    ["returns a malformed list", () => ({ status: 200, data: [{ transitionId: "seven" }] })],
  ] as const)("sends a note-bearing update when the cursor read %s, and says the note is unproven", async (_label, fail) => {
    const qitemId = await claimedRow();
    repo.update({ qitemId, actorSession: "reviewer@fixture", transitionNote: "must persist" }); // an older matching note
    const before = repo.listTransitions(qitemId).length;
    const result = await runUpdate(qitemId, ["--note", "must persist", "--summary", "kept summary"], undefined,
      (call) => call === 0 ? fail() : undefined);

    expect(result.posts).toBe(1);
    expect(result.transitions).toHaveLength(before + 1);
    expect(result.transitions.at(-1)?.transitionNote).toMatch(/^must persist/);
    expect(result.row.summary).toBe("kept summary");
    expect(result.code).toBe(1);
    const said = result.errors.join("\n");
    expect(said).toContain("queue_update_readback_failed");
    expect(said).toContain("can't be shown to be new");
    expect(said).not.toContain("queue_update_preflight_failed");
  });

  it("gives each run its own exit status: a failed update, then a successful one in the same process", async () => {
    const qitemId = await claimedRow();
    const failed = await runUpdate(qitemId, ["--note", "dropped"], () => null);
    const succeeded = await runUpdate(qitemId, ["--note", "kept"]);

    expect(failed.code).toBe(1);
    expect(succeeded.code, succeeded.errors.join("\n")).toBe(0);
    // The action's failure is returned, never passed to process.exit(), which can cut off piped output.
    expect([failed.exits, succeeded.exits]).toEqual([0, 0]);
  });

  // A note is this write's only when this write's actor recorded it, as written or with what the daemon adds for it.
  it.each([
    ["another writer's identical note", "other@fixture", "must persist"],
    ["a lookalike note that starts the same way", "reviewer@fixture", "must persist (correction: still blocked)"],
    ["a lookalike note on a new line", "reviewer@fixture", "must persist\nbut still blocked"],
  ] as const)("doesn't take %s for a dropped note", async (_label, actor, note) => {
    const qitemId = await claimedRow();
    const result = await runUpdate(qitemId, ["--note", "must persist"], () => {
      repo.update({ qitemId, actorSession: actor, transitionNote: note });
      return null;
    });

    expect(result.transitions.at(-1)?.transitionNote).toBe(note);
    expect(result.code).toBe(1);
    const said = JSON.parse(result.errors.join("\n")) as { error: string; message: string };
    expect(said.error).toBe("queue_update_readback_failed");
    expect(said.message).toContain('no newer canonical transition carried requested note "must persist" from "reviewer@fixture"');
  });

  it("accepts the summary suffix the daemon adds to a note", async () => {
    const qitemId = await claimedRow();
    const result = await runUpdate(qitemId, ["--note", "must persist", "--summary", "new subject"]);

    expect(result.code, result.errors.join("\n")).toBe(0);
    expect(result.transitions.at(-1)?.transitionNote).toBe("must persist (summary updated)");
  });

  it("accepts a note only after its canonical transition appears", async () => {
    const qitemId = await claimedRow();
    const result = await runUpdate(qitemId, ["--note", "must persist"]);

    expect(result.code, result.errors.join("\n")).toBe(0);
    expect(result.transitions.at(-1)?.transitionNote).toBe("must persist");
  });
});
