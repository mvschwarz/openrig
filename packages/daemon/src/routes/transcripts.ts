import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../domain/rig-repository.js";
import type { TranscriptStore } from "../domain/transcript-store.js";

interface SessionRow {
  node_id: string;
}

interface NodeRow {
  rig_id: string;
}

function resolveSessionToRig(
  db: Database.Database,
  rigRepo: RigRepository,
  sessionName: string,
): { rigName: string } | { error: string; status: number } {
  // Find ALL sessions with this name to detect ambiguity
  const sessionRows = db
    .prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC")
    .all(sessionName) as SessionRow[];

  if (sessionRows.length === 0) {
    return {
      error: `Session '${sessionName}' not found. Check session names with: rig ps --nodes`,
      status: 404,
    };
  }

  // Collect distinct rig names for all matching sessions
  const rigNames = new Set<string>();
  for (const row of sessionRows) {
    const nodeRow = db
      .prepare("SELECT rig_id FROM nodes WHERE id = ?")
      .get(row.node_id) as NodeRow | undefined;
    if (nodeRow) {
      const rig = rigRepo.getRig(nodeRow.rig_id);
      if (rig) rigNames.add(rig.rig.name);
    }
  }

  if (rigNames.size === 0) {
    return {
      error: `Session '${sessionName}' not found. Check session names with: rig ps --nodes`,
      status: 404,
    };
  }

  if (rigNames.size > 1) {
    const names = Array.from(rigNames).join(", ");
    return {
      error: `Session '${sessionName}' is ambiguous — found in rigs: ${names}. Use a unique session name or specify the rig.`,
      status: 409,
    };
  }

  return { rigName: rigNames.values().next().value! };
}

export function transcriptRoutes(): Hono {
  const router = new Hono();

  router.get("/:session/tail", (c) => {
    const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore;
    const db = c.get("db" as never) as Database.Database;
    const rigRepo = c.get("rigRepo" as never) as RigRepository;
    const sessionName = c.req.param("session");
    const rawLines = parseInt(c.req.query("lines") ?? "50", 10);
    const lines = isNaN(rawLines) || rawLines < 1 ? 50 : rawLines;

    if (!transcriptStore?.enabled) {
      return c.json(
        { error: "Transcripts are disabled. Enable with: rig config set transcripts.enabled true" },
        404,
      );
    }

    const resolution = resolveSessionToRig(db, rigRepo, sessionName);
    if ("error" in resolution) {
      return c.json({ error: resolution.error }, resolution.status as 404);
    }

    const content = transcriptStore.readTail(resolution.rigName, sessionName, lines);
    if (content === null) {
      return c.json(
        { error: `No transcript for '${sessionName}'. Transcripts start automatically on next rig up.` },
        404,
      );
    }

    return c.json({ session: sessionName, lines, content });
  });

  router.get("/:session/grep", (c) => {
    const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore;
    const db = c.get("db" as never) as Database.Database;
    const rigRepo = c.get("rigRepo" as never) as RigRepository;
    const sessionName = c.req.param("session");
    const pattern = c.req.query("pattern");

    if (!pattern) {
      return c.json({ error: "Missing required query parameter: pattern" }, 400);
    }

    // Pre-validate regex
    try {
      new RegExp(pattern);
    } catch (err) {
      return c.json(
        { error: `Invalid grep pattern: ${(err as Error).message}` },
        400,
      );
    }

    if (!transcriptStore?.enabled) {
      return c.json(
        { error: "Transcripts are disabled. Enable with: rig config set transcripts.enabled true" },
        404,
      );
    }

    const resolution = resolveSessionToRig(db, rigRepo, sessionName);
    if ("error" in resolution) {
      return c.json({ error: resolution.error }, resolution.status as 404);
    }

    const matches = transcriptStore.grep(resolution.rigName, sessionName, pattern);
    if (matches === null) {
      return c.json(
        { error: `No transcript for '${sessionName}'. Transcripts start automatically on next rig up.` },
        404,
      );
    }

    return c.json({ session: sessionName, pattern, matches });
  });

  return router;
}
