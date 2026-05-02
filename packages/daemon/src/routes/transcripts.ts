import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../domain/rig-repository.js";
import type { TranscriptStore } from "../domain/transcript-store.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { startTmuxTranscriptCapture } from "../domain/transcript-capture.js";
import { redactTranscriptContent } from "../domain/transcript-redaction.js";

interface SessionRow {
  node_id: string;
}

interface NodeRow {
  rig_id: string;
}

interface BindingRow {
  attachment_type: string | null;
  tmux_session: string | null;
}

const CAPTURE_WARMUP_MS = 150;

function resolveSessionToRig(
  db: Database.Database,
  rigRepo: RigRepository,
  sessionName: string,
): { rigName: string; nodeId: string } | { error: string; status: number } {
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

  return { rigName: rigNames.values().next().value!, nodeId: sessionRows[0]!.node_id };
}

async function tryStartCaptureForSession(
  db: Database.Database,
  transcriptStore: TranscriptStore,
  tmuxAdapter: TmuxAdapter | undefined,
  rigName: string,
  nodeId: string,
  sessionName: string,
): Promise<boolean> {
  const binding = db
    .prepare("SELECT attachment_type, tmux_session FROM bindings WHERE node_id = ?")
    .get(nodeId) as BindingRow | undefined;
  if (!binding) return false;
  if ((binding.attachment_type ?? "tmux") !== "tmux") return false;
  if (!binding.tmux_session || binding.tmux_session !== sessionName) return false;
  const result = await startTmuxTranscriptCapture(tmuxAdapter, transcriptStore, rigName, sessionName);
  return result.started;
}

async function warmTranscriptTail(
  transcriptStore: TranscriptStore,
  rigName: string,
  sessionName: string,
  lines: number,
): Promise<string | null> {
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_WARMUP_MS));
  return transcriptStore.readTail(rigName, sessionName, lines);
}

export function transcriptRoutes(): Hono {
  const router = new Hono();

  router.get("/:session/tail", async (c) => {
    const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore;
    const db = c.get("db" as never) as Database.Database;
    const rigRepo = c.get("rigRepo" as never) as RigRepository;
    const tmuxAdapter = c.get("tmuxAdapter" as never) as TmuxAdapter | undefined;
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
      const startedNow = await tryStartCaptureForSession(
        db,
        transcriptStore,
        tmuxAdapter,
        resolution.rigName,
        resolution.nodeId,
        sessionName,
      );
      if (startedNow) {
        const warmedContent = await warmTranscriptTail(transcriptStore, resolution.rigName, sessionName, lines);
        if (warmedContent !== null && warmedContent !== "") {
          return c.json({ session: sessionName, lines, content: warmedContent });
        }
      }
      return c.json(
        {
          error: startedNow
            ? `No transcript for '${sessionName}' yet. Transcript capture was missing and has been started now. Retry after the session emits new output.`
            : `No transcript for '${sessionName}'. Transcripts start automatically on next rig up.`,
        },
        404,
      );
    }

    return c.json({ session: sessionName, lines, content });
  });

  router.get("/:session/grep", async (c) => {
    const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore;
    const db = c.get("db" as never) as Database.Database;
    const rigRepo = c.get("rigRepo" as never) as RigRepository;
    const tmuxAdapter = c.get("tmuxAdapter" as never) as TmuxAdapter | undefined;
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
      const startedNow = await tryStartCaptureForSession(
        db,
        transcriptStore,
        tmuxAdapter,
        resolution.rigName,
        resolution.nodeId,
        sessionName,
      );
      return c.json(
        {
          error: startedNow
            ? `No transcript for '${sessionName}' yet. Transcript capture was missing and has been started now. Retry after the session emits new output.`
            : `No transcript for '${sessionName}'. Transcripts start automatically on next rig up.`,
        },
        404,
      );
    }

    return c.json({ session: sessionName, pattern, matches });
  });

  // GET /:session/full — return the full transcript content for a session.
  //
  // Per orch decision approved-option-a (escalation
  // qitem-20260502020833-68e4eca3): this route adopts the existing
  // tail/grep posture (open route, daemon-local trust boundary). No
  // session-scoped auth is enforced because no caller-identity primitive
  // exists in the daemon today. Route-level redaction (M1 contract § 4 /
  // openrig-v0 policy) is the protective primitive — credential-shaped
  // patterns are scrubbed from the wire payload BEFORE serialization.
  //
  // A future slice may layer a coherent transcript-read auth policy
  // across tail/grep/full; that work is out of scope for M2c-Daemon and
  // tracked as a Product Lab follow-up signal.
  router.get("/:session/full", async (c) => {
    const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore;
    const db = c.get("db" as never) as Database.Database;
    const rigRepo = c.get("rigRepo" as never) as RigRepository;
    const sessionName = c.req.param("session");

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

    const raw = transcriptStore.readFull(resolution.rigName, sessionName);
    if (raw === null) {
      return c.json(
        {
          error: `No transcript for '${sessionName}'. Transcripts start automatically on next rig up.`,
        },
        404,
      );
    }

    // Apply route-level redaction BEFORE serialization. Per Quality Lesson
    // v9 + orch decision approved-option-a: the wire payload MUST be
    // already redacted; do NOT rely on client-side redaction.
    const content = redactTranscriptContent(raw);
    return c.json({ session: sessionName, content });
  });

  return router;
}
