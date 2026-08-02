import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { clearAllTranscriptRotationsForTest } from "../src/domain/transcript-rotation.js";

describe("transcript capture boot recovery", () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      snapshotsSchema,
      checkpointsSchema,
      resumeMetadataSchema,
      nodeSpecFieldsSchema,
      agentspecRebootSchema,
      externalCliAttachmentSchema,
    ]);
    tmpDir = mkdtempSync(join(tmpdir(), "transcript-capture-boot-"));
  });

  afterEach(() => {
    clearAllTranscriptRotationsForTest();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reattaches capture for running tmux sessions after a daemon restart", async () => {
    const rigRepo = new RigRepository(db);
    const sessions = new SessionRegistry(db);
    const rig = rigRepo.createRig("restart-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessions.registerSession(node.id, "dev-impl@restart-rig");
    sessions.updateStatus(session.id, "running");
    sessions.updateBinding(node.id, { tmuxSession: "dev-impl@restart-rig" });

    const capturePaneContent = vi.fn(async () => "recent claude work\n");
    const module = await import("../src/domain/transcript-capture.js") as Record<string, unknown>;
    expect(typeof module["resumeRunningTranscriptCaptures"]).toBe("function");
    const resume = module["resumeRunningTranscriptCaptures"] as (
      db: Database.Database,
      tmux: TmuxAdapter,
      store: TranscriptStore,
    ) => Promise<number>;

    const resumed = await resume(
      db,
      { capturePaneContent } as unknown as TmuxAdapter,
      new TranscriptStore({ transcriptsRoot: tmpDir }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(resumed).toBe(1);
    expect(capturePaneContent).toHaveBeenCalledWith("dev-impl@restart-rig", 1000);
  });
});
