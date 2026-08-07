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

**STAGE WHERE THE PRODUCT'S OWN USER CAN READ.** The image declares `USER openrig`
(`docker/testbed/Dockerfile:61`) with `WORKDIR /home/openrig` (`:62`), so a default
`docker exec` runs as `openrig` — which cannot traverse root's home. Fixtures therefore
stage under the openrig user's OWN home, the same posture L3.2 already proved with its
`~/work` copy. We do NOT exec as root to reach them: the daemon runs as `openrig`, so a
root-exec probe would test a user the product never uses AND would mask exactly the kind
of permission defect this testbed exists to surface.

```bash
STAGE=/home/openrig/topologies   # openrig-readable by construction (its own home)

# DELIVER AS THE PRODUCT'S OWN USER. `docker cp` preserves ROOT ownership, which
# yields a stage that is readable but NOT WRITABLE to `openrig` — and `rig up`'s
# pre-launch delivery WRITES into the stage (AGENTS.md), so a root-owned stage
# fails EACCES before any seat exists. Tar-piping into a default `docker exec`
# extracts AS `openrig`, so ownership is correct BY CONSTRUCTION — no chown step,
# no root exec anywhere in the procedure (same principle as the probe: the user
# the product runs as is the user that does the work).
SRC=packages/daemon/test/fixtures/self-host-live-legs/topologies
for h in H_A H_B; do
  docker exec "$h" mkdir -p "${STAGE}"
  tar -C "${SRC}" -cf - . | docker exec -i "$h" tar -C "${STAGE}" -xf -
done

# PRE-FLIGHT FENCE — the FULL product contract, AS THE EXEC USER, before anything
# depends on it. The stage is not just read: `rig up`'s pre-launch delivery WRITES
# into it, so read-only staging passes a read fence and then fails EACCES later.
# Both halves are probed by DOING them (a real touch/rm), not by reading mode bits —
# mode bits can lie under ownership, ACLs, or a read-only mount.
for h in H_A H_B; do
  AS="$(docker exec "$h" id -un)"
  docker exec "$h" test -r "${STAGE}/shared.yaml" || {
    echo "ABORT: ${STAGE}/shared.yaml not READABLE as ${AS} on ${h} — image declares USER openrig (Dockerfile:61); stage where that user can read, never exec as root";
    docker exec "$h" ls -la "${STAGE}" 2>&1 | head -20; exit 1; }
  docker exec "$h" sh -c "touch '${STAGE}/.fence-write' && rm -f '${STAGE}/.fence-write'" || {
    echo "ABORT: ${STAGE} not WRITABLE as ${AS} on ${h} — rig up delivers AGENTS.md into the stage, so a root-owned (docker cp) stage fails EACCES at instantiate; deliver as the exec user (tar-pipe), never chown mid-proof";
    docker exec "$h" ls -lad "${STAGE}" 2>&1; docker exec "$h" ls -la "${STAGE}" 2>&1 | head -20; exit 1; }
done

# ASSERT byte-identity of the collision spec across hosts, BEFORE any leg runs
SA="$(docker exec H_A sha256sum "${STAGE}/shared.yaml" | cut -d" " -f1)"
SB="$(docker exec H_B sha256sum "${STAGE}/shared.yaml" | cut -d" " -f1)"
[ "$SA" = "$SB" ] || { echo "ABORT: shared.yaml differs across hosts ($SA vs $SB) — the collision premise is void"; exit 1; }

docker exec H_A bash -lc "cd '${STAGE}' && rig up rig-a.yaml && rig up shared.yaml"
docker exec H_B bash -lc "cd '${STAGE}' && rig up rig-b.yaml && rig up shared.yaml"
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

## LEG A — CROSS-HOST STAMPED TRIPLE: TWO SURFACES, TWO VERBS

**WHY THIS LEG IS SPLIT (grounded in the delivery-lock's own words).** The locked
proof contract, item 3, reads: *"ALWAYS: send, broadcast, and queue sender surfaces
all render the sender triple member@rig@host unconditionally — local sends included —
with the host token in one fixed deterministic position."* It names **three** surfaces,
so the property is NOT "one identity somewhere" — it is the same triple appearing on
each surface independently. The earlier single-leg form drove `rig send` (transport)
and then asserted a stored `source_session` on a forwarded qitem (queue) — two different
stores reached by two different verbs. `rig send` creates NO queue row, so that
assertion could only ever read zero rows. **Action must match assertion: never infer a
queue record from a rendered terminal envelope.** Each surface below is proven by the
verb that actually writes it.

**Fixture:** origin `H_A` (`${ID_A}`), destination `H_B` (`${ID_B}`), seats
`orch-main@rig-a` on `H_A` and `dev-main@rig-b` on `H_B`; both hosts registered in both
directions (see REGISTRATION above — the reply half needs the reverse row).

### LEG A1 — TRANSPORT SURFACE (`rig send`): the rendered envelope + verbatim reply

1. Self-ids come from the ADOPT-BY-READ capture above (`${ID_A}`/`${ID_B}`), NOT
   `rig whoami` (it answers for a seat; a host has none).
2. From `orch-main@rig-a` on `H_A`: `rig send dev-main@rig-b "ping" --host B`.
3. On `H_B`, capture `dev-main@rig-b`'s pane. EXPECT `From: orch-main@rig-a@${ID_A}` —
   the ORIGIN host, never `@${ID_B}`.
4. Copy the `↩ Reply: rig send orch-main@rig-a@${ID_A} "..."` hint VERBATIM and run it on
   `H_B`. EXPECT it routes to `H_A` and delivers to `orch-main@rig-a`, not a local
   lookalike.

**A1 PASS:** the rendered signature names `${ID_A}`; the verbatim reply lands on `H_A`.
**A1 asserts NOTHING about the queue** — no qitem is created by `rig send`, and claiming
one would be inferring a store from a render.
**Fail-open control:** stop `H_A`'s daemon, repeat step 2 → `From:` degrades to the 2-part
form, no crash (C1, incr 3).

### LEG A2 — QUEUE SURFACE (`rig queue create --host`): the DURABLE stored provenance

The lock names the queue sender surface separately, and only a queue verb writes a queue
row. Drive the real cross-host queue write and assert on the row itself:

```bash
# from H_A, create a qitem ON H_B with a unique body (the discriminator)
export BODY="lega2-$(date +%s)"   # exported: the python assertion below reads it from the environment
docker exec H_A bash -lc "rig queue create --source orch-main@rig-a --destination dev-main@rig-b --host '${ID_B}' --summary 'leg-a2 provenance' --body '${BODY}'"
# assert on H_B's DURABLE row — the stored identity, not a rendered line
docker exec H_B bash -lc "rig queue list -A --json" | python3 -c "
import json,sys,os
rows=[q for q in json.load(sys.stdin) if os.environ['BODY'] in (q.get('body') or '')]
assert len(rows)==1, f'expected exactly 1 row for the discriminator, got {len(rows)}'
r=rows[0]; print('sourceSession:', r.get('sourceSession'), '| tags:', r.get('tags'))
"
```

**A2 PASS:** exactly one row matches the unique body; its stored `sourceSession` is the
host-qualified triple naming the ORIGIN (`orch-main@rig-a@${ID_A}`, stamp-at-forward,
incr 4a); the shipped `from-host:` tag is present and unchanged (lock item 6).
**A2 asserts NOTHING about the pane** — the envelope is A1's surface.

*Coverage note for the gate: the lock's item 3 names a THIRD surface, `broadcast`. This
leg proves send + queue LIVE; whether broadcast's live capture is required here or is
covered by item 3's "tests" half is a gate call, not a runbook choice — flagged rather
than silently omitted.*

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
