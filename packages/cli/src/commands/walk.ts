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
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
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
    .requiredOption("--through <items...>", "A context ref (a pack) OR a list of files to walk the seat through")
    .option("--pace <duration>", "Delay between pieces (e.g. 10s, 500ms, or a bare number of seconds); default 10s")
    .option("--json", "JSON output")
    .addHelpText("after", `
Examples:
  rig walk dev-impl@my-rig --through packs/tui-onboarding --pace 12s
  rig walk dev-impl@my-rig --through intro.md steps.md wrapup.md --pace 10s

Paced push-delivery: each piece is sent into the target pane, then --pace elapses
before the next. The walker leads; it does not wait for replies — the spacing lets
the agent process between sends. Small piece → 'rig send'; a real pack → walk.`)
    .action(async (seat: string, opts: { through: string[]; pace?: string; json?: boolean }) => {
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

        // --through is EITHER a raw file list (every item is an existing file) OR a
        // single context ref (a pack → its ordered member pieces). A mix is rejected.
        const items = opts.through;
        let pieces: WalkPiece[];
        if (items.length > 0 && items.every((it) => fileExists(it))) {
          pieces = items.map((it) => ({ label: it, content: readFile(it) }));
        } else if (items.length === 1) {
          pieces = await resolveRefPieces(deps, items[0]!);
        } else {
          console.error("--through takes either a single context ref OR a list of existing files (not a mix).");
          process.exitCode = 1;
          return;
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
            process.exitCode = 1;
            return;
          }
          if (!opts.json) console.log(`[${i + 1}/${pieces.length}] sent ${piece.label} → ${seat}`);
          // Pace BETWEEN pieces only — never a trailing pause after the last.
          if (i < pieces.length - 1) await sleep(paceMs);
        }
        if (opts.json) console.log(JSON.stringify({ seat, pieces: pieces.length, paceMs }));
        else console.log(`Walked ${seat} through ${pieces.length} piece(s).`);
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });

  return cmd;

  async function getClient(deps: WalkDeps): Promise<DaemonClient> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      throw new Error("Daemon not running. Start it with: rig daemon start");
    }
    return deps.clientFactory(getDaemonUrl(status));
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
