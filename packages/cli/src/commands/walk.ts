// Slice-03 Atom 6 (rig walk) — the pacing primitive. "Walk the seat through it":
// deliver a sequence of context pieces into a seat's pane, spaced by --pace so
// the agent can absorb each before the next. Its OWN top-level verb (not an
// extension of `rig send`); push-direction, the walker leads and does not wait
// for replies — the spacing does the work (SPEC-rig-context-rig-walk-composition
// §3). --through takes a context ref (a pack → its ordered member pieces) OR a
// raw file list; each piece is one send into the pane.

import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl , statusGuardMessage} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface RefPiecesWire {
  ref: string;
  pieces: Array<{ path: string; content: string }>;
  missingFiles?: Array<{ path: string; role?: string }>;
  error?: string;
  message?: string;
}

export interface WalkDeps extends StatusDeps {
  /** Test seam for the inter-piece pacing delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seams for local-file resolution. */
  fileExists?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

const DEFAULT_PACE_MS = 10_000;

/** Parse a walk duration with an explicit unit: `10s` or `500ms`. Returns
 *  null on a malformed value; the default when undefined. */
export function parsePaceMs(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_PACE_MS;
  const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return m[2] === "ms" ? Math.round(n) : Math.round(n * 1000);
}

export interface WalkPiece {
  /** A human label for the piece (file path or pack member path). */
  label: string;
  content: string;
}

export function walkCommand(depsOverride?: WalkDeps): Command {
  const cmd = new Command("walk").description("Walk a seat through a paced sequence of context pieces");

  const getDeps = (): WalkDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<seat>", "Target session name (e.g. dev-impl@my-rig)")
    .option("--through <items...>", "A context ref (a pack) OR a list of files to walk the seat through")
    // Test-A (row 782b467a) — the walk/profile join: consume the AUTHORITATIVE
    // composed profile (never a hand-authored piece list) and report delivered
    // pieces BY IDENTITY so the profile set and the delivered set are
    // exact-comparable. NO-COPY: the bytes sent are the bytes the profile served.
    .option("--through-profile <ref>", "Walk the seat through a pack's COMPOSED PROFILE (requires --situation; the piece set comes from rig context profile, never hand-authored)")
    .option("--situation <situation>", "With --through-profile: fresh | handover | post-compaction")
    .option("--runtime <runtime>", "With --through-profile: claude | codex (default claude)")
    .option("--profile <profile>", "With --through-profile: named install profile declared by the pack")
    .option("--rig <rig>", "With --through-profile: the seat-tree grant (with --seat)")
    .option("--seat-grant <seat>", "With --through-profile: the seat whose tree seat: atoms may read (with --rig)")
    .option("--mission <mission>", "With --through-profile: the mission-tree grant")
    .option("--slice <slice>", "With --through-profile: the slice-tree grant (with --mission)")
    .option("--budget <tokens>", "With --through-profile: situation budget (reported, never truncated)")
    .option("--pace <duration>", "Delay between pieces (e.g. 10s or 500ms; unit suffix required); default 10s")
    // Mechanics-gate fix (desk ruling d9b3989a): send success means TYPED, not CONSUMED — every
    // piece is verified BY EFFECT against the seat's generation record before the next is sent.
    .option("--consume-timeout <duration>", "Per-piece consumption-verification window (e.g. 20s or 500ms; unit suffix required); default 20s")
    .option("--consume-poll <duration>", "Consumption-verification poll interval (e.g. 1500ms or 2s; unit suffix required); default 1500ms")
    // Turn-pacing (desk BLOCKING row 2ff16fa1): a piece sent into an OPEN turn is queued by the
    // runtime and never becomes a distinct user turn — walk waits for the prior turn's closure.
    .option("--turn-timeout <duration>", "Max wait for the seat's turn to CLOSE after a piece is consumed (e.g. 300s; unit suffix required); default 300s")
    .option("--json", "JSON output")
    .addHelpText("after", `
Examples:
  rig walk dev-impl@my-rig --through packs/tui-onboarding --pace 12s
  rig walk dev-impl@my-rig --through intro.md steps.md wrapup.md --pace 10s

Paced push-delivery: each piece is sent into the target pane, then --pace elapses
before the next. The walker leads; it does not wait for replies — the spacing lets
the agent process between sends. Small piece → 'rig send'; a real pack → walk.`)
    .action(async (seat: string, opts: { through?: string[]; throughProfile?: string; situation?: string; runtime?: string; profile?: string; rig?: string; seatGrant?: string; mission?: string; slice?: string; budget?: string; pace?: string; consumeTimeout?: string; consumePoll?: string; turnTimeout?: string; json?: boolean }) => {
      try {
        const deps = getDeps();
        const paceMs = parsePaceMs(opts.pace);
        if (paceMs === null) {
          console.error(`Invalid --pace '${opts.pace}': use an explicit unit suffix, e.g. 10s or 500ms.`);
          process.exitCode = 1;
          return;
        }
        const fileExists = deps.fileExists ?? existsSync;
        const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

        // Exactly ONE input form: --through (files or pack ref) or
        // --through-profile (the composed profile). A mix is rejected loud
        // before any send.
        if (opts.through && opts.throughProfile) {
          console.error("Use either --through OR --through-profile, not both — the profile's piece set is authoritative and never hand-mixed.");
          process.exitCode = 1;
          return;
        }
        let profileIdentity: Array<{ atomId: string; address: string }> | null = null;
        let pieces: WalkPiece[];
        if (opts.throughProfile) {
          if (!opts.situation) {
            console.error("--through-profile requires --situation (fresh | handover | post-compaction).");
            process.exitCode = 1;
            return;
          }
          const resolved = await resolveProfilePieces(deps, opts);
          pieces = resolved.pieces;
          profileIdentity = resolved.identity;
        } else if (!opts.through) {
          console.error("Provide --through <items...> or --through-profile <ref>.");
          process.exitCode = 1;
          return;
        } else {
        // --through is EITHER a raw file list (every item is an existing file) OR a
        // single context ref (a pack → its ordered member pieces). A mix is rejected.
        const items = opts.through;
        if (items.length > 0 && items.every((it) => fileExists(it))) {
          pieces = items.map((it) => ({ label: it, content: readFile(it) }));
        } else if (items.length === 1) {
          pieces = await resolveRefPieces(deps, items[0]!);
        } else {
          console.error("--through takes either a single context ref OR a list of existing files (not a mix).");
          process.exitCode = 1;
          return;
        }
        }
        if (pieces.length === 0) {
          console.error("Nothing to walk: --through resolved to zero pieces.");
          process.exitCode = 1;
          return;
        }

        const client = await getClient(deps);

        // --- Consumption verification BY EFFECT (mechanics-gate fix, desk ruling d9b3989a) ---
        // Send success means TYPED, not CONSUMED: the paste + Enter can succeed at the tmux layer
        // while the target TUI leaves the text STAGED at the prompt, and the next pieces coalesce.
        // The effect source is the seat's current-generation record (the append-only conversation
        // JSONL): a consumed piece appears as a user-role record containing the piece's head.
        // Same explicit-unit duration grammar as --pace (10s / 500ms); defaults 20s / 1.5s.
        const consumeTimeoutMs = opts.consumeTimeout !== undefined ? parsePaceMs(opts.consumeTimeout) : 20_000;
        const consumePollMs = opts.consumePoll !== undefined ? parsePaceMs(opts.consumePoll) : 1_500;
        const turnTimeoutMs = opts.turnTimeout !== undefined ? parsePaceMs(opts.turnTimeout) : 300_000;
        if (consumeTimeoutMs === null) {
          console.error(`Invalid --consume-timeout '${opts.consumeTimeout}': use an explicit unit suffix, e.g. 20s or 500ms.`);
          process.exitCode = 1;
          return;
        }
        if (consumePollMs === null) {
          console.error(`Invalid --consume-poll '${opts.consumePoll}': use an explicit unit suffix, e.g. 1500ms or 2s.`);
          process.exitCode = 1;
          return;
        }
        if (turnTimeoutMs === null) {
          console.error(`Invalid --turn-timeout '${opts.turnTimeout}': use an explicit unit suffix, e.g. 300s or 500ms.`);
          process.exitCode = 1;
          return;
        }
        const normalize = (s: string) => s.replace(/\s+/g, "");
        const pieceHead = (content: string) => normalize(content).slice(0, 64);
        const recordPath = `/api/sessions/${encodeURIComponent(seat)}/generation-record`;

        interface RecordRead { generationId?: string; totalBytes?: number; suffix?: string; error?: string; message?: string }
        const readRecord = async (sinceBytes?: number): Promise<{ status: number; data: RecordRead }> =>
          client.get<RecordRead>(sinceBytes === undefined ? recordPath : `${recordPath}?sinceBytes=${sinceBytes}`, { headers: terminalAuthHeaders() });

        /** Parse the record suffix: where (if anywhere) the piece's distinct user turn is, and
         *  whether a system/turn_duration CLOSURE record follows it (the capture atom's boundary —
         *  the turn-pacing gate's signal that the seat finished processing the piece). */
        const analyzeSuffix = (suffix: string, head: string): { consumed: boolean; turnClosed: boolean } => {
          let consumedAt = -1;
          const lines = suffix.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i]!.trim();
            if (!trimmed) continue;
            let rec: { type?: string; subtype?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> | string } };
            try { rec = JSON.parse(trimmed); } catch { continue; }
            if (consumedAt < 0 && rec.message?.role === "user") {
              const c = rec.message.content;
              const texts = typeof c === "string" ? [c] : Array.isArray(c) ? c.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text!) : [];
              if (texts.some((t) => normalize(t).includes(head))) consumedAt = i;
              continue;
            }
            if (consumedAt >= 0 && rec.type === "system" && rec.subtype === "turn_duration") {
              return { consumed: true, turnClosed: true };
            }
          }
          return { consumed: consumedAt >= 0, turnClosed: false };
        };
        const suffixShowsConsumed = (suffix: string, head: string): boolean => analyzeSuffix(suffix, head).consumed;

        // One pre-walk record probe decides the mode. No record (unsupported runtime / no sidecar /
        // a daemon without the route) → legacy delivery with a NAMED advisory: unverified is
        // disclosed, never silent.
        let preProbe: { status: number; data: RecordRead };
        try {
          preProbe = await readRecord();
        } catch (err) {
          preProbe = { status: 0, data: { message: `generation-record probe failed: ${(err as Error).message}` } };
        }
        const verifiable = preProbe.status === 200 && typeof preProbe.data.generationId === "string";
        if (!verifiable) {
          console.error(`walk: consumption unverified for ${seat} — ${preProbe.data.message ?? preProbe.data.error ?? `generation record unavailable (HTTP ${preProbe.status})`}. Pieces are delivered without per-piece effect verification.`);
        }

        const failPiece = (i: number, label: string, why: string): void => {
          console.error(`walk aborted at piece ${i + 1}/${pieces.length} (${label}): ${why}`);
          if (profileIdentity) {
            console.log(JSON.stringify({ seat, delivered: profileIdentity.slice(0, i), expected: profileIdentity, aborted: profileIdentity[i] }));
          }
          process.exitCode = 1;
        };

        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i]!;
          const head = pieceHead(piece.content);

          let preLen = 0;
          let preGen: string | undefined;
          if (verifiable) {
            const pre = await readRecord();
            if (pre.status !== 200 || typeof pre.data.generationId !== "string") {
              failPiece(i, piece.label, `the seat's generation record became unreadable before the send (${pre.data.message ?? pre.data.error ?? `HTTP ${pre.status}`}).`);
              return;
            }
            preGen = pre.data.generationId;
            preLen = pre.data.totalBytes ?? 0;
          }

          // THE SEND. A thrown client error (a timeout) is NOT a failure yet — the daemon may have
          // completed server-side; reconcile BY EFFECT below, never re-send (the fleet ledger's
          // rule, productized). A definitive 4xx/5xx still aborts — EXCEPT submit_failed, which is
          // exactly the staged-text state and takes the single-Enter retry path.
          let sendOutcome: "ok" | "staged-suspect" | { hardError: string } ;
          try {
            const res = await client.post<Record<string, unknown>>("/api/transport/send", {
              session: seat,
              text: piece.content,
            }, { headers: terminalAuthHeaders() });
            if (res.status >= 400) {
              if (res.data?.["reason"] === "submit_failed") sendOutcome = "staged-suspect";
              else {
                failPiece(i, piece.label, (res.data?.["error"] as string | undefined) ?? `HTTP ${res.status}`);
                return;
              }
            } else sendOutcome = "ok";
          } catch (err) {
            if (!verifiable) {
              failPiece(i, piece.label, `transport error with no way to reconcile by effect (no generation record): ${(err as Error).message}`);
              return;
            }
            console.error(`walk: piece ${i + 1}/${pieces.length} transport error (${(err as Error).message}) — reconciling by effect, not re-sending.`);
            sendOutcome = "staged-suspect";
          }

          if (verifiable) {
            const pollConsumed = async (): Promise<"consumed" | "generation-rolled" | "timeout"> => {
              const deadline = Date.now() + consumeTimeoutMs;
              for (;;) {
                const rec = await readRecord(preLen);
                if (rec.status === 200 && typeof rec.data.generationId === "string") {
                  if (rec.data.generationId !== preGen) return "generation-rolled";
                  if (suffixShowsConsumed(rec.data.suffix ?? "", head)) return "consumed";
                }
                if (Date.now() >= deadline) return "timeout";
                await sleep(consumePollMs);
              }
            };

            let verdict = await pollConsumed();
            if (verdict === "generation-rolled") {
              failPiece(i, piece.label, "the seat's generation rolled mid-walk (a re-prime); the walk cannot continue into a different generation.");
              return;
            }
            if (verdict === "timeout") {
              // Not consumed in the window. Staged? — one capture decides; staged takes EXACTLY ONE
              // submit retry (a guarded bare Enter), then one more verification window, then loud.
              const cap = await client.post<Record<string, unknown>>("/api/transport/capture", { session: seat, lines: 50 }, { headers: terminalAuthHeaders() });
              const pane = (cap.data?.["content"] as string | undefined) ?? "";
              // Staged evidence: the piece's own head (short pastes render inline, truncated) OR
              // the TUI's pasted-text placeholder (large pastes render as "[Pasted text #N +X
              // lines]", never their content — the real specimen's shape).
              const stagedEvidence = cap.status === 200 && (
                normalize(pane).includes(head.slice(0, 24)) ||
                /\[Pasted text #\d+ \+\d+ lines\]/.test(pane)
              );
              if (stagedEvidence) {
                const enter = await client.post<Record<string, unknown>>("/api/transport/send", {
                  session: seat,
                  submitOnly: true,
                  expectedStagedText: piece.content, // FULL bytes — the transport checks the rendered literal residual for contiguous containment
                  expectedStagedLineCount: piece.content.split("\n").length,
                }, { headers: terminalAuthHeaders() });
                if (enter.status >= 400) {
                  failPiece(i, piece.label, `typed but not consumed; the single submit retry was refused (${(enter.data?.["error"] as string | undefined) ?? `HTTP ${enter.status}`}).`);
                  return;
                }
                verdict = await pollConsumed();
                if (verdict !== "consumed") {
                  failPiece(i, piece.label, `typed and staged, but not consumed even after the single submit retry — the piece never entered the seat's conversation record. Not re-sending (one retry is the contract).`);
                  return;
                }
              } else {
                failPiece(i, piece.label, `send reported ${sendOutcome === "ok" ? "success" : "a transport error"} but the piece is neither consumed in the generation record nor staged in the pane — delivery lost; consumption verification fails this walk closed.`);
                return;
              }
            }
          }

          // TURN-PACING GATE (desk BLOCKING row 2ff16fa1): the piece is consumed, but sending the
          // next one into a still-OPEN turn gets it QUEUED by the runtime (never a distinct user
          // turn — the rerun's proven defect layer). Wait for the seat's turn to CLOSE — the
          // system/turn_duration record after the piece's user turn (the capture atom's boundary)
          // — before pacing to the next piece. N-of-N (r2 row b268b89b): the FINAL piece waits
          // too — whatever follows the walk (rerun 4's seat-issued GET) meets the same open-turn
          // queuing boundary. The wait is the install working as designed: a walk takes as long
          // as the seat needs to actually read the pieces.
          if (verifiable) {
            const turnDeadline = Date.now() + turnTimeoutMs;
            for (;;) {
              const rec = await readRecord(preLen);
              if (rec.status === 200 && typeof rec.data.generationId === "string") {
                if (rec.data.generationId !== preGen) {
                  failPiece(i, piece.label, "the seat's generation rolled while waiting for its turn to close.");
                  return;
                }
                if (analyzeSuffix(rec.data.suffix ?? "", head).turnClosed) break;
              }
              if (Date.now() >= turnDeadline) {
                failPiece(i, piece.label, `consumed, but the seat's turn did not CLOSE within ${turnTimeoutMs}ms — refusing to send the next piece into an open turn (it would be queued, never a distinct user turn).`);
                return;
              }
              await sleep(consumePollMs);
            }
          }

          if (!opts.json) console.log(`[${i + 1}/${pieces.length}] ${verifiable ? "consumed" : "sent"} ${piece.label} → ${seat}`);
          // Pace BETWEEN pieces only — never a trailing pause after the last.
          if (i < pieces.length - 1) await sleep(paceMs);
        }
        if (opts.json) {
          console.log(JSON.stringify(profileIdentity
            ? { seat, delivered: profileIdentity, paceMs, consumptionVerified: verifiable }
            : { seat, pieces: pieces.length, paceMs, consumptionVerified: verifiable }));
        } else {
          console.log(`Walked ${seat} through ${pieces.length} piece(s)${verifiable ? ", each consumption-verified by effect" : " (consumption unverified — no generation record)"}.`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;

  async function getClient(deps: WalkDeps): Promise<DaemonClient> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      // B8-1b: epistemic-matched language via the one helper (down ≠ busy).
      const gm = statusGuardMessage(status); throw new Error(`${gm.fact} ${gm.action}`);
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  async function resolveProfilePieces(
    deps: WalkDeps,
    opts: { throughProfile?: string; situation?: string; runtime?: string; profile?: string; rig?: string; seatGrant?: string; mission?: string; slice?: string; budget?: string },
  ): Promise<{ pieces: WalkPiece[]; identity: Array<{ atomId: string; address: string }> }> {
    const client = await getClient(deps);
    const params = new URLSearchParams({ ref: opts.throughProfile!, situation: opts.situation!, runtime: opts.runtime ?? "claude" });
    if (opts.profile !== undefined) params.set("profile", opts.profile);
    if (opts.rig !== undefined) params.set("rig", opts.rig);
    if (opts.seatGrant !== undefined) params.set("seat", opts.seatGrant);
    if (opts.mission !== undefined) params.set("mission", opts.mission);
    if (opts.slice !== undefined) params.set("slice", opts.slice);
    if (opts.budget !== undefined) params.set("budget", opts.budget);
    const res = await client.get<{
      pieces?: Array<{ atomId: string; address: string; text: string }>;
      message?: string; error?: string;
    }>(`/api/context-packs/library/by-ref/profile?${params.toString()}`);
    if (res.status !== 200) {
      throw new Error(res.data?.message ?? res.data?.error ?? `Daemon returned HTTP ${res.status} composing the profile.`);
    }
    const profilePieces = res.data.pieces ?? [];
    return {
      // NO-COPY: content is the SERVED text, byte-for-byte; the label carries
      // the identity so aborts name the atom.
      pieces: profilePieces.map((p) => ({ label: `${p.atomId} (${p.address})`, content: p.text })),
      identity: profilePieces.map((p) => ({ atomId: p.atomId, address: p.address })),
    };
  }

  async function resolveRefPieces(deps: WalkDeps, ref: string): Promise<WalkPiece[]> {
    const client = await getClient(deps);
    const res = await client.get<RefPiecesWire>(`/api/context-packs/library/by-ref/pieces?ref=${encodeURIComponent(ref)}`);
    if (res.status === 404) {
      throw new Error(`Context pack '${ref}' not found in library. Run 'rig context list' to see the available refs.`);
    }
    if (res.status === 400) {
      throw new Error(res.data?.message ?? `Unsafe context ref '${ref}'.`);
    }
    if (res.status !== 200) {
      throw new Error(`Daemon returned HTTP ${res.status} resolving ref '${ref}'.`);
    }
    // One abort contract for both input forms: a missing/unreadable member is
    // known up-front (reported here before the first send), so — exactly like a
    // missing local --through file — it aborts the walk BEFORE any send. No
    // partial walk; the operator fixes the pack and re-runs.
    const missing = res.data.missingFiles ?? [];
    if (missing.length > 0) {
      throw new Error(
        `Context pack '${ref}' has ${missing.length} missing/unreadable member(s): ${missing.map((m) => m.path).join(", ")}. ` +
          `A walk delivers every member or none — fix the pack (or its files) and re-run. Nothing was sent.`,
      );
    }
    return (res.data.pieces ?? []).map((p) => ({ label: `${ref}:${p.path}`, content: p.content }));
  }
}
