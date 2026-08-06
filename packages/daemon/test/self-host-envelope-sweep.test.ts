import { describe, it, expect } from "vitest";
import { parseSessionName } from "../src/domain/session-name.js";

/**
 * 51-09 increment 5 — envelope-consumer sweep (risk-2 obligation).
 *
 * ENUMERATION (verified at source @ the 51-09 tip): every consumer of the
 * `From:` / `↩ Reply:` sender form, and whether a 3-part `member@rig@host`
 * signature can break it. NONE assume exactly two `@`-segments — so the
 * always-suffix triple is safe across the fleet. This suite is an
 * ENUMERATION + CONTROL (the parsers were already 3-part-safe by design +
 * the incr-1..4 guards), NOT a behavior change.
 *
 * PARSERS (consume a sender/target string):
 *  - domain/session-name.ts parseSessionName — the FR-8 archetype: GREEDY fold
 *    (member = up to the FIRST '@', rig = the rest). `a@b@c` -> member 'a',
 *    rig 'b@c'. Never throws, never assumes 2 segments. (daemon/cli/ui copies
 *    are byte-identical — the C3 fence; unchanged by 51-09.)
 *  - cli/commands/queue.ts resolveQueueHostDestination — atCount>=2 branch uses
 *    lastIndexOf('@') to split member@rig | host. 3-part-AWARE (MH-3 addressing).
 *  - cli/cross-host-target.ts resolveCrossHostTarget — self-id strip + registry
 *    strip on a 3-part target (incr-3); the reply-hint round-trips through it.
 *
 * GUARDS (detect an already-triple, added by 51-09; all 3-part-aware):
 *  - cli/send.ts:49,509 + lib/pane-envelope.ts:45 — `split('@').length < 3`
 *    (render/relay guard: an existing triple is preserved verbatim, never
 *    re-stamped — origin not forged).
 *  - domain/queue-repository.ts stampSelfHostSuffix — `split('@').length !== 2`
 *    (only a BARE member@rig is stamped; a triple is left untouched).
 *
 * RENDER-ONLY (emit the sender form, no parse — nothing to break):
 *  - cli/send.ts + lib/pane-envelope.ts `From:`/`↩ Reply:` render the triple.
 *  - queue sender surfaces render the stored source_session (already the triple).
 *
 * VENDORED EXAMPLES updated to the new form: skills cross-host-rig-commands
 * (canonical + specs-materialized) — the "Sender identity is ASYMMETRIC" block
 * that taught "the sender carries NO @host suffix" is superseded by the
 * always-suffix rule. (openrig-user's `--from` line already names the origin.)
 *
 * C5 HONEST SCOPE: the 3-part shape is safe + teaches; the D10 2-part same-name
 * silent-mint is closed by the envelope + sender-side stripping (incr 3) + the
 * teaching refusal (incr 4b), NOT by any in-string parse change here.
 */
describe("51-09 envelope-consumer sweep — no consumer assumes two @-segments", () => {
  it("parseSessionName greedy-folds a 3-part sender signature without choking", () => {
    // The always-suffix From: is member@rig@originHost. parseSessionName is the
    // archetype consumer (BR-1: rig lookup misses -> honest refuse, never throw).
    const p = parseSessionName("orch@rig-a@host-origin");
    expect(p.kind).toBe("canonical");
    expect(p.member).toBe("orch");
    expect(p.rig).toBe("rig-a@host-origin"); // greedy fold — 2-segment NOT assumed
  });

  it("a bare 2-part sender still parses as today (no regression)", () => {
    const p = parseSessionName("orch@rig-a");
    expect(p).toMatchObject({ kind: "canonical", member: "orch", rig: "rig-a" });
  });

  it("a self-suffixed triple is a distinct, non-throwing parse (rig carries the host)", () => {
    // The daemon does NOT strip (incr 4b C4): it parses greedily then refuses+teaches.
    const p = parseSessionName("orch@rig-a@self-host");
    expect(p.kind).toBe("canonical");
    expect(p.rig).toBe("rig-a@self-host");
  });
});
