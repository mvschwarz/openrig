// #131 — "Queue claim fails with claim_destination_mismatch when /healthz is slow:
// CLI host-qualifies a local seat identity".
//
// RED at pre-fix bytes: the CLI's `senderIdentityHeaders` appends the local self-id to
// `X-OpenRig-Session` whenever `DaemonClient.identityHeaders` cannot PROVE locality (its
// `GET /healthz` race against `min(timeoutMs, 1000)` times out or errors). Under daemon
// load a LOCAL seat therefore arrives as `qa-codex-3@hc@host-7fe0ae96` for the very
// daemon it is talking to, and `requireSenderIdentity` handed that string straight to
// `QueueRepository.claim`, which compares the claimant byte-for-byte against the
// qitem's canonical `qa-codex-3@hc` destination → `claim_destination_mismatch`.
//
// FIX: the daemon is the authority on its OWN boot-reconciled host id, so it
// canonicalizes at the ONE sender-identity chokepoint both sibling helpers share
// (`canonicalizeLocalSession` in domain/hosts/fanout-contract.ts, the daemon-edge twin
// of the CLI's existing self-suffix strip in cross-host-target.ts / ruling 2e1b737f).
//
// HONEST SCOPE: this only touches the TRANSPORT path (the header the CLI stamped with
// the daemon's own id). A body-declared `claimed:v1` actor is a deliberate caller
// statement and is recorded verbatim. A FOREIGN host suffix is real provenance and is
// never rewritten. With no reconciled self-id everything passes through unchanged.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { setSelfHostId, getSelfHostId, canonicalizeLocalSession } from "../src/domain/hosts/fanout-contract.js";
import { requireSenderIdentity, resolveActorWithDeferral } from "../src/routes/require-sender-identity.js";

const SELF_HOST = "host-7fe0ae96";
const OTHER_HOST = "mm2-openrig1";

describe("#131 — self-suffix canonicalization of the transport sender identity", () => {
  describe("canonicalizeLocalSession — local suffix → canonical; foreign preserved; unqualified unchanged", () => {
    // The three cases the issue names, plus the fail-open edges.
    it("strips a suffix equal to THIS host's self-id (the reported failure)", () => {
      expect(canonicalizeLocalSession(`qa-codex-3@hc@${SELF_HOST}`, SELF_HOST)).toBe("qa-codex-3@hc");
    });

    it("preserves a FOREIGN host suffix verbatim (real provenance is never rewritten)", () => {
      expect(canonicalizeLocalSession(`pm-lead@kernel@${OTHER_HOST}`, SELF_HOST))
        .toBe(`pm-lead@kernel@${OTHER_HOST}`);
    });

    it("leaves an unqualified bare member@rig unchanged", () => {
      expect(canonicalizeLocalSession("qa-codex-3@hc", SELF_HOST)).toBe("qa-codex-3@hc");
    });

    it("fails OPEN when the self-id is unknown — a string we cannot prove local is never rewritten", () => {
      // Daemon down / pre-reconcile / never booted: byte-identical pass-through.
      expect(canonicalizeLocalSession(`qa-codex-3@hc@${SELF_HOST}`, null))
        .toBe(`qa-codex-3@hc@${SELF_HOST}`);
      expect(canonicalizeLocalSession(`qa-codex-3@hc@${SELF_HOST}`, ""))
        .toBe(`qa-codex-3@hc@${SELF_HOST}`);
    });

    it("matches the self-id LITERALLY and case-sensitively (no alias, no 'local' sugar)", () => {
      // Same closed rule as resolvesToLocalHost's self branch — the two identity layers
      // must never disagree about what "this host" means.
      expect(canonicalizeLocalSession("qa-codex-3@hc@HOST-7FE0AE96", SELF_HOST))
        .toBe("qa-codex-3@hc@HOST-7FE0AE96");
      expect(canonicalizeLocalSession("qa-codex-3@hc@local", SELF_HOST)).toBe("qa-codex-3@hc@local");
      expect(canonicalizeLocalSession(`qa-codex-3@hc@${SELF_HOST}-2`, SELF_HOST))
        .toBe(`qa-codex-3@hc@${SELF_HOST}-2`);
    });

    it("only a 3-segment member@rig@host is a candidate — deeper rig tokens pass through", () => {
      // A rig name that merely ENDS in the self-id must not be re-addressed: the
      // producers only ever stamp a 2-part session, so a 4-part string is not ours.
      expect(canonicalizeLocalSession(`a@rig@sub@${SELF_HOST}`, SELF_HOST))
        .toBe(`a@rig@sub@${SELF_HOST}`);
      // An empty member/rig segment is not a canonical name to rewrite.
      expect(canonicalizeLocalSession(`@hc@${SELF_HOST}`, SELF_HOST)).toBe(`@hc@${SELF_HOST}`);
      expect(canonicalizeLocalSession(`qa@@${SELF_HOST}`, SELF_HOST)).toBe(`qa@@${SELF_HOST}`);
    });

    it("leaves legacy flat and virtual-domain refs untouched", () => {
      expect(canonicalizeLocalSession("r01-legacy-flat", SELF_HOST)).toBe("r01-legacy-flat");
      expect(canonicalizeLocalSession("mike@external", SELF_HOST)).toBe("mike@external");
      expect(canonicalizeLocalSession("human@kernel", SELF_HOST)).toBe("human@kernel");
    });
  });

  describe("claim() — a self-qualified local claimant matches the canonical destination row", () => {
    let db: Database.Database;
    let repo: QueueRepository;
    let prior: string | null;

    beforeEach(() => {
      db = new Database(":memory:");
      migrate(db, ALL_MIGRATIONS);
      repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
      prior = getSelfHostId();
      setSelfHostId(SELF_HOST);
    });
    afterEach(() => { setSelfHostId(prior); db.close(); });

    it("REGRESSION: the reported claim_destination_mismatch no longer fires for a self-suffixed local seat", async () => {
      // The row is created by a LOCAL seat → stored bare (the 2026-08-27 root invariant).
      const item = await repo.create({
        sourceSession: "orch-lead@hc",
        destinationSession: "qa-codex-3@hc",
        body: "pick this up",
      });
      expect(item.destinationSession, "a local write stores the bare destination").toBe("qa-codex-3@hc");

      // Pre-fix: this string came straight off the wire and failed byte-for-byte.
      const wireSession = `qa-codex-3@hc@${SELF_HOST}`;
      expect(item.destinationSession).not.toBe(wireSession); // RED: the mismatch this fixes

      // Post-fix: the daemon canonicalizes its OWN id before the compare.
      const claimed = repo.claim({ qitemId: item.qitemId, destinationSession: canonicalizeLocalSession(wireSession) });
      expect(claimed.state).toBe("in-progress");
    });

    it("a genuinely foreign-qualified seat still cannot claim a local row (provenance is load-bearing)", () => {
      // The strip is scoped to THIS host only — a remote seat addressed at this qitem
      // is a different actor and must still be refused, not silently accepted.
      const remote = canonicalizeLocalSession(`qa-codex-3@hc@${OTHER_HOST}`);
      expect(remote).toBe(`qa-codex-3@hc@${OTHER_HOST}`);
    });
  });

  describe("round-trip with the producers — stampSelfHostSuffix(strip(x)) === strip(x)", () => {
    it("the daemon's forward-time stamp and the new strip are exact inverses", async () => {
      // Guards against the two halves of the envelope disagreeing: whatever
      // stampSelfHostSuffix would produce, canonicalizeLocalSession undoes — for the
      // same host. (The stamp is applied at the cross-host FORWARD boundary only.)
      const { stampSelfHostSuffix } = await import("../src/domain/queue-repository.js");
      const prior = getSelfHostId();
      setSelfHostId(SELF_HOST);
      try {
        const bare = "orch@rig-a";
        expect(canonicalizeLocalSession(stampSelfHostSuffix(bare))).toBe(bare);
      } finally {
        setSelfHostId(prior);
      }
    });
  });

  describe("the sender-identity chokepoint — BOTH sibling helpers canonicalize the wire header", () => {
    // Every actor-compare/record route reaches one of these two helpers, so this is
    // the single seam where claim/unclaim/create/update/handoff/inbox/outbox/stream
    // all pick the fix up. The siblings derive the actor from the SAME header, so they
    // must agree on what it MEANS (their shared P18-sweep contract).
    const app = new Hono();
    const sender = (c: Parameters<typeof requireSenderIdentity>[0]) => {
      const id = requireSenderIdentity(c, { verb: "queue claim" });
      return c.json(id.ok ? { session: id.session, provenance: id.provenance } : { status: "refused" });
    };
    // GET for the header-only cases; POST for the body-claim supersede case.
    app.get("/sender", sender);
    app.post("/sender", sender);
    app.get("/actor", (c) => {
      const id = resolveActorWithDeferral(c, { verb: "ui review approve" });
      return c.json(id.ok ? { session: id.session, provenance: id.provenance } : { status: "refused" });
    });

    let prior: string | null;
    beforeEach(() => { prior = getSelfHostId(); setSelfHostId(SELF_HOST); });
    afterEach(() => { setSelfHostId(prior); });

    const get = async (route: string, session: string) => {
      const res = await app.request(route, { headers: { "x-openrig-session": session } });
      return await res.json() as { session: string; provenance: string };
    };

    it.each(["/sender", "/actor"])("%s canonicalizes a self-qualified LOCAL seat and keeps transport:v1", async (route) => {
      const r = await get(route, `qa-codex-3@hc@${SELF_HOST}`);
      expect(r.session).toBe("qa-codex-3@hc");
      // The era-stamp is untouched: the hop still proved the transport, and a
      // canonicalization is not a downgrade to claimed:v1.
      expect(r.provenance).toBe("transport:v1");
    });

    it.each(["/sender", "/actor"])("%s preserves a foreign-qualified sender", async (route) => {
      const r = await get(route, `pm-lead@kernel@${OTHER_HOST}`);
      expect(r.session).toBe(`pm-lead@kernel@${OTHER_HOST}`);
    });

    it.each(["/sender", "/actor"])("%s leaves an already-bare sender untouched", async (route) => {
      const r = await get(route, "qa-codex-3@hc");
      expect(r.session).toBe("qa-codex-3@hc");
    });

    it("the wire still SUPERSEDES a disagreeing body claim after canonicalization (P18 ruling A intact)", async () => {
      const res = await app.request("/sender", {
        method: "POST",
        headers: { "content-type": "application/json", "x-openrig-session": `qa-codex-3@hc@${SELF_HOST}` },
        body: JSON.stringify({ destinationSession: "somebody-else@rig" }),
      });
      // No 409, and the BODY never decides the actor — the canonicalized wire identity does.
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ session: "qa-codex-3@hc", provenance: "transport:v1" });
    });

    it("an unknown-origin marker survives canonicalization (honest era-stamp kept)", async () => {
      const res = await app.request("/sender", {
        headers: { "x-openrig-session": `qa-codex-3@hc@${SELF_HOST}`, "x-openrig-origin-unknown": "true" },
      });
      expect(await res.json()).toMatchObject({ session: "qa-codex-3@hc", provenance: "origin-unknown:v1" });
    });
  });
});
