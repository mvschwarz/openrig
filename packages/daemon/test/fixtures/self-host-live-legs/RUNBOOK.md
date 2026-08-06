# 51-09 LIVE-LEG RUNBOOKS + FIXTURES (increment 5 — ship, run at QA stage)

These are QA-executable runbooks for the two 51-09 LIVE proofs. The build ships the
fixtures + steps; a QA seat on a genuinely unexposed seat runs them at the live stage
(do NOT run them from the build lane / against live seats during the build).

Unit-tier proofs already landed (incr 1–4b): durable self-id, self-resolution + E1,
registry alignment, the always-suffix envelope twin + relay guard, sender-triple
stamp-at-write + stamp-at-forward, the destination-host teaching refusal. These legs
prove the SAME behaviors END-TO-END across two real daemons.

---

## LEG A — CROSS-HOST STAMPED-TRIPLE ROUND-TRIP (deferred from 4a/2a)

**Claim:** a cross-host send stores a sender identity that names the ORIGIN host, and
the `↩ Reply:` hint round-trips verbatim back to the origin.

**Fixture:** origin host `H_A` (self-id `A`), destination host `H_B` (self-id `B`),
seat `orch@rig-a` on `H_A`, seat `dev@rig-b` on `H_B`; `H_B` registered in `H_A`'s
`hosts.yaml` under id `B`.

**Steps (on H_A):**
1. `rig whoami --json` on each host → record self-ids `A`, `B` (both non-'local',
   registry-valid — incr 1/2b). EXPECT: stable across a daemon restart (incr 1).
2. From `orch@rig-a` on `H_A`: `rig send dev@rig-b "ping" --host B`.
3. On `H_B`, capture `dev@rig-b`'s pane. EXPECT the received signature:
   `From: orch@rig-a@A` (the ORIGIN host `A`, never `@B`). The forwarded qitem's
   stored `source_session` == `orch@rig-a@A` (stamp-at-forward, incr 4a).
4. Copy the `↩ Reply: rig send orch@rig-a@A "..."` hint VERBATIM and run it on `H_B`.
   EXPECT it routes to `H_A` (the origin), delivering to `orch@rig-a` — NOT a local
   `H_B` lookalike. (`@A` is a cross-host target; if a same-named `rig-a` exists on
   `H_B`, the triple still routes to `A`.)

**Pass:** signature names `A`; stored source_session == `orch@rig-a@A`; the verbatim
reply lands on `H_A`. **Fail-open control:** stop `H_A`'s daemon, repeat step 2 → the
From: degrades to today's 2-part, no crash (C1, incr 3).

---

## LEG B — FOUNDER-COLLISION (proof item 5, the E2-class killer)

**Claim:** with a SAME-NAMED rig on both hosts, a received signature names the origin
and the reply lands on the origin host, not the local lookalike.

**Fixture:** a rig named `shared` on BOTH `H_A` (self-id `A`) and `H_B` (self-id `B`);
seat `lead@shared` on each; `H_B` registered on `H_A` as `B`.

**Steps:**
1. From `lead@shared` on `H_A`: `rig send lead@shared "collision test" --host B`.
2. On `H_B`, capture `lead@shared`. EXPECT `From: lead@shared@A` — the origin host
   disambiguates the two same-named rigs (this is the collision the founder narrated,
   now honest-observable).
3. Run the verbatim `↩ Reply: rig send lead@shared@A "..."` on `H_B`. EXPECT it lands
   on `H_A`'s `lead@shared` (the successor/reply follows the host the triple names),
   NOT `H_B`'s same-named `lead@shared`.
4. NEGATIVE (D10 honest scope): from `H_B`, `rig send lead@shared "x"` (BARE, no
   `--host`) → mints LOCALLY on `H_B`'s `shared`. This is EXPECTED and NOT fixed by
   this slice — the 2-part same-name ambiguity closes ONLY via `--host` / the
   sender-side triple, and the daemon's teaching refusal fires only for the 3-part
   `lead@shared@X` form (`unknown_destination_rig` + "use --host"). State this in the
   proof: **51-09 makes the 3-part honest and teaches; it does not magically kill the
   2-part silent mint.**

**Pass:** cross-host signatures name the origin; verbatim replies round-trip to the
origin host; the D10 negative is documented, not claimed-killed.

---

## C5 HONEST SCOPE (carried from ruling c9964404)

The origin-host-in-sender-identity slice makes host-blind addressing IMPOSSIBLE to
write silently for the 3-part shape (always-suffix From: + reply round-trip + teaching
refusal). The 2-part same-name silent mint (D10) is closed by the `--host` envelope +
sender-side stripping (incr 3), NOT by an in-string daemon interpreter. The proofs
above SAY SO (Leg B step 4).
