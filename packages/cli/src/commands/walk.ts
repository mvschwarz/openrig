// Slice-03 Atom 6 (rig walk) — the pacing primitive. "Walk the seat through it":
// deliver a sequence of context pieces into a seat's pane, spaced by --pace so
// the agent can absorb each before the next. Its OWN top-level verb (not an
// extension of `rig send`); push-direction, the walker leads and does not wait
// for replies — the spacing does the work (SPEC-rig-context-rig-walk-composition
// §3). --through takes a context ref (a pack → its ordered member pieces) OR a
// raw file list; each piece is one send into the pane.

import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { DaemonClient } from "../client.js";
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

/** Parse a pace duration: `10s`, `500ms`, or a bare number (seconds). Returns
 *  null on a malformed value; the default when undefined. */
export function parsePaceMs(value: string | undefined): number | null {
  if (value === undefined) return DEFAULT_PACE_MS;
  const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(value.trim());
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
    .option("--rig <rig>", "With --through-profile: the seat-tree grant (with --seat)")
    .option("--seat-grant <seat>", "With --through-profile: the seat whose tree seat: atoms may read (with --rig)")
    .option("--mission <mission>", "With --through-profile: the mission-tree grant")
    .option("--budget <tokens>", "With --through-profile: situation budget (reported, never truncated)")
    .option("--pace <duration>", "Delay between pieces (e.g. 10s, 500ms, or a bare number of seconds); default 10s")
    .option("--json", "JSON output")
    .addHelpText("after", `
Examples:
  rig walk dev-impl@my-rig --through packs/tui-onboarding --pace 12s
  rig walk dev-impl@my-rig --through intro.md steps.md wrapup.md --pace 10s

Paced push-delivery: each piece is sent into the target pane, then --pace elapses
before the next. The walker leads; it does not wait for replies — the spacing lets
the agent process between sends. Small piece → 'rig send'; a real pack → walk.`)
    .action(async (seat: string, opts: { through?: string[]; throughProfile?: string; situation?: string; runtime?: string; rig?: string; seatGrant?: string; mission?: string; budget?: string; pace?: string; json?: boolean }) => {
      try {
        const deps = getDeps();
        const paceMs = parsePaceMs(opts.pace);
        if (paceMs === null) {
          console.error(`Invalid --pace '${opts.pace}'. Use e.g. 10s, 500ms, or a bare number of seconds.`);
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
        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i]!;
          const res = await client.post<Record<string, unknown>>("/api/transport/send", {
            session: seat,
            text: piece.content,
          });
          if (res.status >= 400) {
            const err = (res.data?.["error"] as string | undefined) ?? `HTTP ${res.status}`;
            console.error(`walk aborted at piece ${i + 1}/${pieces.length} (${piece.label}): ${err}`);
            // Profile mode: the MISMATCH is reported by identity — the
            // delivered PREFIX vs the expected set, exact-comparable.
            if (profileIdentity) {
              console.log(JSON.stringify({ seat, delivered: profileIdentity.slice(0, i), expected: profileIdentity, aborted: profileIdentity[i] }));
            }
            process.exitCode = 1;
            return;
          }
          if (!opts.json) console.log(`[${i + 1}/${pieces.length}] sent ${piece.label} → ${seat}`);
          // Pace BETWEEN pieces only — never a trailing pause after the last.
          if (i < pieces.length - 1) await sleep(paceMs);
        }
        if (opts.json) {
          console.log(JSON.stringify(profileIdentity
            ? { seat, delivered: profileIdentity, paceMs }
            : { seat, pieces: pieces.length, paceMs }));
        } else {
          console.log(`Walked ${seat} through ${pieces.length} piece(s).`);
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
    opts: { throughProfile?: string; situation?: string; runtime?: string; rig?: string; seatGrant?: string; mission?: string; budget?: string },
  ): Promise<{ pieces: WalkPiece[]; identity: Array<{ atomId: string; address: string }> }> {
    const client = await getClient(deps);
    const params = new URLSearchParams({ ref: opts.throughProfile!, situation: opts.situation!, runtime: opts.runtime ?? "claude" });
    if (opts.rig !== undefined) params.set("rig", opts.rig);
    if (opts.seatGrant !== undefined) params.set("seat", opts.seatGrant);
    if (opts.mission !== undefined) params.set("mission", opts.mission);
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
