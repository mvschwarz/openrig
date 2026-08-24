// OPR.0.5.3.5 Atom 3 — the composition algebra (locked SPEC, founder refinement):
//
//   FRESH           = the base walk (atoms tagged fresh)
//   HANDOVER        = FRESH + the handover material (atoms tagged handover)
//   POST-COMPACTION = the tagged subset of fresh + the handover material
//
// Every profile is CLOSED over requires (a subset profile must close — intake rule);
// the runtime filter runs per mini-req 3 (claude and codex are never assumed to have
// lost the same dimensions, so they compose different profiles from the SAME graph);
// each piece resolves through the Atom-1 address machinery and carries a per-piece
// SOURCE LABEL (Q2-Amendment 1: composition is multi-source by contract — library /
// seat tree / mission tree — and every assembled piece names its source; the caller's
// resolver decides the kind, this module labels). Budgets are evaluated AT COMPOSE
// and on overage REPORT the amount and the priority-ordered drop candidates —
// composition never silently truncates (mini-req 9; D2: budgets flag for review,
// never silently govern).
//
// PURE by contract, like the manifest parser: file text arrives through the caller's
// readFile so the same algebra serves library packs today and configured tree roots
// (seat/mission sources) when the wiring atom lands. Every failure is LOUD and names
// the atom — a compose stops rather than thinning the walk (the Q1 rationale).

import type { ContextPackAtom } from "./context-pack-types.js";
import { estimateTokensFromBytes } from "./token-estimate.js";
import { AddressResolutionError, parseAddress, resolveAddress } from "../markdown-address.js";

export class ProfileComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileComposeError";
  }
}

export type ComposeSituation = "fresh" | "handover" | "post-compaction";
export type ComposeRuntime = "claude" | "codex";
export type SourceKind = "library" | "seat" | "mission";

export interface ComposeInput {
  /** The one atom graph (possibly gathered across sources by the caller). */
  atoms: ContextPackAtom[];
  situation: ComposeSituation;
  runtime: ComposeRuntime;
  /** Fail-loud file reader keyed by the address's pre-`#` ref. */
  readFile: (ref: string) => string;
  /** The situation's token budget (D2 targets); omitted = no budget check. */
  budgetTokens?: number;
  /** Source labelling per atom (Q2-Amendment 1); defaults to "library". */
  sourceKindFor?: (atom: ContextPackAtom) => SourceKind;
}

export interface ComposedPiece {
  atomId: string;
  address: string;
  sourceKind: SourceKind;
  order: number;
  priority: ContextPackAtom["priority"];
  /** The resolved bytes: the addressed span (Q1 full-span rule) or the whole file. */
  text: string;
  estimatedTokens: number;
}

export interface ComposedProfile {
  situation: ComposeSituation;
  runtime: ComposeRuntime;
  pieces: ComposedPiece[];
  totalEstimatedTokens: number;
  /** Present ONLY when the budget binds: the report, never a truncation. */
  budget?: {
    limitTokens: number;
    overageTokens: number;
    /** What to drop FIRST, in drop order: optional, then recommended, then core;
     *  larger pieces first within a tier (the biggest cheap win leads). */
    dropCandidates: Array<{ atomId: string; priority: ContextPackAtom["priority"]; estimatedTokens: number }>;
  };
}

/** Which situation tags select atoms for a profile, per the locked algebra. */
function selectionTags(situation: ComposeSituation): ComposeSituation[] {
  switch (situation) {
    case "fresh":
      return ["fresh"];
    case "handover":
      return ["fresh", "handover"];
    case "post-compaction":
      return ["post-compaction", "handover"];
  }
}

const DROP_ORDER: Record<ContextPackAtom["priority"], number> = { optional: 0, recommended: 1, core: 2 };

export function composeProfile(input: ComposeInput): ComposedProfile {
  const { atoms, situation, runtime, readFile, budgetTokens, sourceKindFor } = input;
  const byId = new Map(atoms.map((a) => [a.id, a]));

  // 1. SELECT by situation tag, then filter by runtime (an "any" atom serves both).
  const tags = selectionTags(situation);
  const runtimeFits = (a: ContextPackAtom): boolean => a.runtime === "any" || a.runtime === runtime;
  const selected = new Map<string, ContextPackAtom>();
  for (const a of atoms) {
    if (a.situations.some((s) => tags.includes(s)) && runtimeFits(a)) selected.set(a.id, a);
  }

  // 2. CLOSE over requires: a required atom joins the profile even when untagged.
  //    A dependency that exists but is excluded by the RUNTIME filter is a broken
  //    graph for this runtime — fail loud, never a quietly thinner walk.
  const queue = [...selected.keys()];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const req of selected.get(id)?.requires ?? byId.get(id)?.requires ?? []) {
      if (selected.has(req)) continue;
      const dep = byId.get(req);
      if (!dep) {
        throw new ProfileComposeError(`atom '${id}' requires '${req}', which is not in the graph — the ${situation} profile cannot close.`);
      }
      if (!runtimeFits(dep)) {
        throw new ProfileComposeError(
          `atom '${id}' requires '${req}', but '${req}' is declared runtime=${dep.runtime} and this compose targets runtime=${runtime} — ` +
            `the closure would silently thin the ${situation} walk; fix the graph (retag '${req}' or drop the edge).`,
        );
      }
      selected.set(req, dep);
      queue.push(req);
    }
  }

  // 3. ORDER the walk (stable: order, then id — absorption depends on sequence).
  const walk = [...selected.values()].sort((x, y) => x.order - y.order || x.id.localeCompare(y.id));

  // 4. RESOLVE every piece through the one address machinery; label its source.
  const pieces: ComposedPiece[] = walk.map((a) => {
    const { ref, headerPath } = parseAddress(a.address);
    let fileText: string;
    try {
      fileText = readFile(ref);
    } catch (err) {
      throw new ProfileComposeError(`atom '${a.id}' (${a.address}): source file '${ref}' is unreadable — ${(err as Error).message}`);
    }
    let text: string;
    if (headerPath.length === 0) {
      text = fileText;
    } else {
      try {
        text = resolveAddress(fileText, headerPath).text;
      } catch (err) {
        if (err instanceof AddressResolutionError) {
          throw new ProfileComposeError(`atom '${a.id}' (${a.address}): ${err.message}`);
        }
        throw err;
      }
    }
    return {
      atomId: a.id,
      address: a.address,
      sourceKind: sourceKindFor?.(a) ?? "library",
      order: a.order,
      priority: a.priority,
      text,
      estimatedTokens: estimateTokensFromBytes(Buffer.byteLength(text, "utf-8")),
    };
  });

  const totalEstimatedTokens = pieces.reduce((sum, p) => sum + p.estimatedTokens, 0);

  // 5. BUDGET report (mini-req 9): flag, never govern — all pieces stay.
  let budget: ComposedProfile["budget"];
  if (budgetTokens !== undefined && totalEstimatedTokens > budgetTokens) {
    budget = {
      limitTokens: budgetTokens,
      overageTokens: totalEstimatedTokens - budgetTokens,
      dropCandidates: [...pieces]
        .sort((x, y) => DROP_ORDER[x.priority] - DROP_ORDER[y.priority] || y.estimatedTokens - x.estimatedTokens || x.atomId.localeCompare(y.atomId))
        .map((p) => ({ atomId: p.atomId, priority: p.priority, estimatedTokens: p.estimatedTokens })),
    };
  }

  return { situation, runtime, pieces, totalEstimatedTokens, ...(budget !== undefined ? { budget } : {}) };
}
