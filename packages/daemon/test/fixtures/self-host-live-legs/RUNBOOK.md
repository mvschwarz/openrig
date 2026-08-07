# 51-09 LIVE-LEG RUNBOOKS + FIXTURES (increment 5 — ship, run at QA stage)

These are QA-executable runbooks for the two 51-09 LIVE proofs. The build ships the
fixtures + steps; a QA seat on a genuinely unexposed seat runs them at the live stage
(do NOT run them from the build lane / against live seats during the build).

Unit-tier proofs already landed (incr 1–4b): durable self-id, self-resolution + E1,
registry alignment, the always-suffix envelope twin + relay guard, sender-triple
stamp-at-write + stamp-at-forward, the destination-host teaching refusal. These legs
prove the SAME behaviors END-TO-END across two real daemons.

---

## PROVISIONING (ships with these legs — `topologies/`)

The legs need three real rigs. They are COMMITTED beside this runbook (they did not
exist before 2026-08-07; the legs previously named rigs nothing provided, so both died
at provisioning on a bare container):

| file | rig | CANONICAL seat (`<pod>-<member>@<rig>`) | host |
|---|---|---|---|
| `topologies/rig-a.yaml` | `rig-a` | `orch-main@rig-a` | H_A |
| `topologies/rig-b.yaml` | `rig-b` | `dev-main@rig-b` | H_B |
| `topologies/shared.yaml` | `shared` | `lead-main@shared` | **BOTH** |

**SEAT NAMES ARE THE DERIVED ONES.** Session names are always
`deriveCanonicalSessionName(pod, member, rig)` = `<pod>-<member>@<rig>` — a single-token
form like `orch@rig-a` (as these legs were originally written) is NOT derivable, so the
steps below use the real derived names.

**BYTE-IDENTITY IS THE COLLISION PREMISE — assert it, never assume it.** `shared.yaml` is
ONE file copied to both hosts; the runbook VERIFIES equality by hash before the legs run.

```bash
# copy the SAME file to both containers (never author a second copy)
for h in H_A H_B; do docker cp packages/daemon/test/fixtures/self-host-live-legs/topologies "$h":/root/topologies; done
# ASSERT byte-identity of the collision spec across hosts, BEFORE any leg runs
SA="$(docker exec H_A sha256sum /root/topologies/shared.yaml | cut -d" " -f1)"
SB="$(docker exec H_B sha256sum /root/topologies/shared.yaml | cut -d" " -f1)"
[ "$SA" = "$SB" ] || { echo "ABORT: shared.yaml differs across hosts ($SA vs $SB) — the collision premise is void"; exit 1; }
docker exec H_A bash -lc 'cd /root/topologies && rig up rig-a.yaml && rig up shared.yaml'
docker exec H_B bash -lc 'cd /root/topologies && rig up rig-b.yaml && rig up shared.yaml'
```

## SELF-HOST IDS — ADOPT-BY-READ (the one shared procedure)

Use the SAME identity resolution as L3/L5 — capture from the daemon's own surface, never
predict, and never `rig whoami` (it reports a SEAT identity; a host has none, so it cannot
answer "which host am I"):

```bash
ID_A="$(docker exec H_A bash -lc 'curl -fsS http://127.0.0.1:7433/healthz' | python3 -c "import json,sys; print(json.load(sys.stdin).get('selfHostId',''))")"
ID_B="$(docker exec H_B bash -lc 'curl -fsS http://127.0.0.1:7433/healthz' | python3 -c "import json,sys; print(json.load(sys.stdin).get('selfHostId',''))")"
```

Every `A`/`B` below means the CAPTURED `${ID_A}`/`${ID_B}` — the ids are random per boot.

## REGISTRATION IS BIDIRECTIONAL (both legs reply ACROSS the link)

L5.2 registers H_B on H_A so the outbound send resolves. BOTH legs then require the
VERBATIM REPLY to run FROM H_B back to H_A — which needs H_A resolvable from H_B. Register
the reverse direction with the SAME adopt-by-read procedure, opposite direction; a leg that
only registers one way dies at the reply step, not at the send.

```bash
# forward (H_B known to H_A) — as L5.2 does:
docker exec H_A bash -lc "rig host add --id '${ID_B}' --transport http --url http://H_B:7433 --bearer-env OPENRIG_AUTH_BEARER_TOKEN && rig host ls --json"
# REVERSE (H_A known to H_B) — required by the reply half of both legs:
docker exec H_B bash -lc "rig host add --id '${ID_A}' --transport http --url http://H_A:7433 --bearer-env OPENRIG_AUTH_BEARER_TOKEN && rig host ls --json"
```

## LEG A — CROSS-HOST STAMPED-TRIPLE ROUND-TRIP (deferred from 4a/2a)

**Claim:** a cross-host send stores a sender identity that names the ORIGIN host, and
the `↩ Reply:` hint round-trips verbatim back to the origin.

**Fixture:** origin host `H_A` (self-id `A`), destination host `H_B` (self-id `B`),
seat `orch-main@rig-a` on `H_A`, seat `dev-main@rig-b` on `H_B`; `H_B` registered in `H_A`'s
`hosts.yaml` under id `B`.

**Steps (on H_A):**
1. Self-ids come from the ADOPT-BY-READ capture above (`${ID_A}`/`${ID_B}` off each
   daemon's own `/healthz`) — NOT `rig whoami`, which answers for a seat, not a host.
   EXPECT: both non-'local', registry-valid (incr 1/2b), stable across a daemon
   restart in the same container (incr 1).
2. From `orch-main@rig-a` on `H_A`: `rig send dev-main@rig-b "ping" --host B`.
3. On `H_B`, capture `dev-main@rig-b`'s pane. EXPECT the received signature:
   `From: orch-main@rig-a@${ID_A}` (the ORIGIN host `A`, never `@B`). The forwarded qitem's
   stored `source_session` == `orch-main@rig-a@${ID_A}` (stamp-at-forward, incr 4a).
4. Copy the `↩ Reply: rig send orch-main@rig-a@${ID_A} "..."` hint VERBATIM and run it on `H_B`.
   EXPECT it routes to `H_A` (the origin), delivering to `orch-main@rig-a` — NOT a local
   `H_B` lookalike. (`@A` is a cross-host target; if a same-named `rig-a` exists on
   `H_B`, the triple still routes to `A`.)

**Pass:** signature names `A`; stored source_session == `orch-main@rig-a@${ID_A}`; the verbatim
reply lands on `H_A`. **Fail-open control:** stop `H_A`'s daemon, repeat step 2 → the
From: degrades to today's 2-part, no crash (C1, incr 3).

---

## LEG B — FOUNDER-COLLISION (proof item 5, the E2-class killer)

**Claim:** with a SAME-NAMED rig on both hosts, a received signature names the origin
and the reply lands on the origin host, not the local lookalike.

**Fixture:** a rig named `shared` on BOTH `H_A` (self-id `A`) and `H_B` (self-id `B`);
seat `lead-main@shared` on each; `H_B` registered on `H_A` as `B`.

**Steps:**
1. From `lead-main@shared` on `H_A`: `rig send lead-main@shared "collision test" --host B`.
2. On `H_B`, capture `lead-main@shared`. EXPECT `From: lead-main@shared@${ID_A}` — the origin host
   disambiguates the two same-named rigs (this is the collision the founder narrated,
   now honest-observable).
3. Run the verbatim `↩ Reply: rig send lead-main@shared@${ID_A} "..."` on `H_B`. EXPECT it lands
   on `H_A`'s `lead-main@shared` (the successor/reply follows the host the triple names),
   NOT `H_B`'s same-named `lead-main@shared`.
4. NEGATIVE (D10 honest scope): from `H_B`, `rig send lead-main@shared "x"` (BARE, no
   `--host`) → mints LOCALLY on `H_B`'s `shared`. This is EXPECTED and NOT fixed by
   this slice — the 2-part same-name ambiguity closes ONLY via `--host` / the
   sender-side triple, and the daemon's teaching refusal fires only for the 3-part
   `lead-main@shared@X` form (`unknown_destination_rig` + "use --host"). State this in the
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
