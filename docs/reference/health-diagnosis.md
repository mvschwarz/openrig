# Agent-operated System Health diagnosis

System Health can give a responsible agent one durable investigation packet when
a configured detector needs interpretation. The packet preserves the finding,
policy version, evidence, and current authority documents. It invites the agent
to investigate beyond that selection, including its own contribution. It does
not declare a pathology or perform corrective actions.

## Enable a bounded diagnosis loop

Process-only diagnosis also requires an explicit delegated operating posture at the
finding's resolved scope. Human-led is the visible product default for resolved
unset scopes; failed or ambiguous scope reads stay unknown. Findings remain
inspectable in either case. See [scoped operating posture](scoped-operating-posture.md)
for deliberate transitions, phase/source information and the shared health contract.

```sh
rig health policy --json > effective-policy.json
jq '.policy' effective-policy.json > health-policy.json
# Edit health-policy.json: diagnosis.enabled=true and diagnosis.owner=<seat@rig>.
rig health policy --file health-policy.json
rig health diagnose                    # preview; no writes or wakes
rig health diagnose --apply            # evaluate now and apply admitted actions
rig health diagnosis list
rig health diagnosis show <qitem-id>
```

`diagnosis list` and `diagnosis show` default to summaries in both text and
JSON. The detailed text summary shows queue state, owner, blocker, disposition,
uncertainty, finding identity and authority references. Summary JSON also keeps
the ceremony basis and current receipt identities. It keeps its object/array
shape and adds `readView`: `complete`, `omittedFields` (paths,
JSON byte counts and array counts), `fullJsonBytes`, and the exact `fullCommand`.
Packet copies, authority contents, evidence arrays and the diagnostic receipt ledger
are omitted explicitly. Current workflow-receipt envelopes remain, with
`evidenceIdentity` carrying recognized cut/candidate, verdict and evidence-reference
strings; their opaque evidence is omitted. These identity labels do not validate
a receipt. A summary is not the complete evidence. Byte counts describe
compact JSON serialization without the trailing newline, not model token counts.

For investigation or existing consumers that need the former complete JSON:

```sh
rig health diagnosis show <qitem-id> --full --json > diagnosis.json
rig health diagnosis list --full --json > diagnoses.json
```

`--full` without `--json` prints the complete record as formatted JSON. These
expansions may be large. Plain `--json` no longer includes all evidence fields;
migrate consumers of those fields to `--full --json`. HTTP API responses and
mutation-result JSON are unchanged. Full context remains necessary before an
agent acts on a diagnosis; the generated investigation packet names that command.

The daemon checks enabled policy once per minute. `health policy` reports whether
that check is scheduled and its last result, including errors. Ordinary `health`
list/explain commands remain observational. Diagnosis defaults to disabled;
ceremony amplification is the only default diagnosis trigger. A continuing
episode keeps one qitem, receives at most one additional presentation by default,
and shares an owner cooldown across episodes (one hour by default). A disposition
stops re-presentation. Disabling policy stops automatic admission and presentation.
Ownership changes do not silently reroute existing occurrences.
Outside a managed seat, name the writer with `rig health --actor <name> ...`.
Managed-seat transport identity takes precedence over that declared name.
Only the occurrence's assigned owner may record its disposition or request human
notification. Other agents can advise the owner; a policy-owner change does not
grant custody of existing occurrences. Writes retain the sender's identity
provenance on the queue transition.

Policy controls detector enablement, ceremony/review/wake thresholds, source
observation window and freshness, diagnostic owner, cooldown, re-presentation
bound, and human-escalation conditions. Edit plain JSON and apply it with the
command; unknown keys and invalid values refuse without changing the policy.
Applied proposals and their predecessors are retained under the configured
OpenRig home in `health/policy-history/`. The effective version also includes
the existing `health.context_pressure.warning_percent` and `critical_percent`
settings, which remain configurable with `rig config`. Their defaults are 95
and 99. CLI/TUI finding explanations show the policy version used.

## Passive ceremony diagnosis

Ordinary queue activity can admit a diagnosis without a health checkpoint.
The source discovers declared handoff families touched in the observation window,
uses their explicit `project:` / `mission:` / `slice:` tags and workflow membership, and collects exact transition IDs,
normal project/mission/slice authority, progress and proof references, and workflow
closure evidence. It never interprets Markdown or counts proof files, approvals,
C1 pairing, commits, tests, or terminal rows as accepted product outcomes.

At the configured traffic threshold (20 transitions by default), a fresh,
complete family becomes `ceremony.stage=needs-diagnosis`, `status=indeterminate`,
and `severity=info`. CLI/TUI call this **needs diagnosis**, not a confirmed
warning. Enabled diagnosis policy admits one bounded packet even though the
product denominator is unknown. Ordinary unavailable/stale detector records
remain ineligible. Diagnosis and human-notification traffic are excluded from
the numerator and cannot recursively generate another investigation.

The agent reads the actual evidence, including beyond the supplied references,
and resolves the semantic outcome granularity and consequence boundary. Use the
existing disposition command with an optional `progress` result:

```json
{
  "basis": "<current finding.ceremony.basis from diagnosis show>",
  "conclusion": "established",
  "outcomes": [{"id": "<distinct meaningful outcome>", "observedAt": "<time inside the measured interval>", "evidenceRefs": ["<normal proof path>"]}],
  "boundedAuthority": false,
  "boundary": "<selected SDLC boundary and why this outcome census covers the interval>",
  "evidenceRefs": ["<inspected authority/evidence path>"],
  "missingFacts": []
}
```

Put this object in `progress` beside the existing verdict/steering/uncertainty
fields. `established` affirms a complete census for the exact interval; an empty
outcome list affirms zero outcomes, not failed discovery. `false-positive`
clears the suspicion without inventing a denominator when no missing facts remain.
A false-positive assessment that still names missing facts stays indeterminate
and does not close the episode interval. `indeterminate` supplies
no outcomes and names the missing fact in `missingFacts`. Required references
must resolve inside the workspace; extra evidence beyond the initial packet is
allowed. The receipt retains the actual actor, timestamp, identity provenance,
source basis, and evidence hashes. A changed basis refuses a stale submission.
Later evidence changes make confirmation indeterminate rather than preserving
a false ratio. Outcome meaning remains attributed agent judgment.

Only an established, current assessment permits a ratio. The projector computes
it from the distinct listed outcomes and exact transitions; a qualifying ratio
with no bounded-authority counter-signal becomes `confirmed` / `active` /
`warning`. Proportionate or bounded-authority results clear the episode. An
explicitly cleared assessment marks the end of that interval; sufficient later
traffic in the same family starts a new episode. Repeated reads never advance
these boundaries. One occurrence and the existing owner cooldown apply to each
episode; a disposition stops repeated requests.

This bounded source covers explicitly linked project or mission work: at most 2,000 touched
qitems, 1,000 members / 10,000 transitions per family, 200 workflow
receipts, 200 declared slices, and 100 proof files per selected slice. Overflow
refuses visibly. When more than 200 families (roots) were touched, it evaluates the
200 with the most transitions in the window, then by lineage ID, and reports the
result as partial coverage with the total and omitted counts. Omitted families
were not evaluated, so having no finding for them is not a healthy verdict.
Context files are bounded to 64 KiB. A lineage beginning before
the retained window remains indeterminate, with the missing interval named.
Project planning does not require a successor mission: an explicit project identity
resolves its current context, with mission and phase absent unless evidenced.
Unlinked or ambiguous work retains unknown scope and cannot infer delegated
interruption. Absence is not health. The packet includes missing context references so an agent
can name or repair its own knowledge gap without manufacturing source truth.

## Optional outcome-boundary checkpoint

Live queue transitions do not, on their own, prove product outcomes or the
authority for a bounded operation. At a meaningful outcome boundary, the agent
holding those facts may submit a census for one qitem lineage and time window. Set `includeHandoffs: true`
to follow its declared handoff descendants; this is the normal path for work that
passed between seats. The root alone usually misses the review/return traffic.
Prefer the existing proof/progress/outcome artifact as evidence. Do not add a
checkpoint to each edit or message. This is a fallback for explicitly supplied evidence;
normal activity uses passive diagnosis above. An existing checkpoint owns its
lineage so the passive source does not create a duplicate episode.

```json
{
  "schema": "openrig.health-checkpoint/v0alpha1",
  "lineageQitemId": "<existing-product-qitem>",
  "includeHandoffs": true,
  "scope": {"type": "slice", "projectId": "<project>", "missionId": "<mission>", "sliceId": "<slice>"},
  "startedAt": "<ISO timestamp>",
  "observedAt": "<ISO timestamp>",
  "transitionIds": "derive",
  "productOutcomes": [
    {"id": "<outcome-id>", "observedAt": "<ISO timestamp>", "evidenceRef": "<proof-artifact-path>"}
  ],
  "productCensusRef": "<artifact establishing the complete outcome census for this lineage/window>",
  "boundedAuthority": {"applies": false, "evidenceRef": "<bounded-effect-authority assessment>"},
  "sdlc": {"expectation": "<selected components and review boundary>", "evidenceRef": "<authority for that selection>"},
  "authorityPaths": {
    "project": ["<current project SPEC and project.yaml paths>"],
    "mission": ["<current mission SPEC and mission.yaml paths>"],
    "slice": ["<current slice SPEC and slice.yaml paths>"]
  }
}
```

```sh
rig queue transitions <existing-product-qitem>
rig health checkpoint --file checkpoint.json
rig health --instance --json
```

`transitionIds: "derive"` asks the existing submission command to collect the
complete census once, then retain the exact IDs in the checkpoint and its audit.
The author supplies outcomes and their meaning, not a row-by-row bookkeeping
ritual. An explicit ID array is also supported for sealed replay or a
caller-supplied census. Later reads never silently extend either form.

The daemon verifies that transition IDs are the complete census for that exact
qitem and window, including all handoff descendants when selected. It does not
infer shared lineage from similar names or seat names. The complete transition
census may be assembled from the queue ledger; omitting a descendant refuses.
Explicit mission/slice tags on counted family members must match the checkpoint
scope; untagged descendants inherit the declared handoff relationship.
The bound is 1,000 linked qitems and 10,000 transitions; an oversized family
refuses rather than silently sampling it. Independent roots are separate censuses. It counts
those transitions and the distinct, evidenced product outcomes, and explains
both sides of the ratio, the literal gate-tag breakdown, and the selected SDLC
expectation. These are custody/status transitions, not messages or judgments
about whether each review was useful. A product outcome is a distinct evidenced
user-visible result; commits, test runs, returns and fixes needed to achieve
that same promised result do not each create another denominator unit. The
census must state its outcome granularity and coverage. The same granularity
must be used for positive and proportionate controls. An empty outcome list requires the same census evidence
as a nonempty one. An unavailable product census is a null denominator: the explanation says
no ratio was computed, rather than silently substituting zero or one.
`boundedAuthority.applies=null` means unknown, never false.
Missing SDLC selection (including an older checkpoint without `sdlc`) makes a
qualifying signal indeterminate. Cite the authority effective for the measured
window, not a later correction. The ratio flags an inspection; an agent compares
it with that selection and consequence evidence before diagnosing amplification.
Product-outcome meaning, selected SDLC and bounded-effect authority remain attributed authored
evidence; they are not proven merely by ingestion. Findings label that source
and use medium confidence. Required evidence references must resolve to nonempty,
readable local files (at most 1 MiB) inside the configured workspace. Absolute
paths and paths relative to that workspace are supported; other reference kinds
(including section addresses) remain unavailable. Resolved evidence records carry
a SHA-256; missing files and symlink escapes remain attributed claims but force
indeterminate source truth and cannot admit a diagnosis. Availability is checked
again on every projection; presence does not certify the artifact's meaning.
This authority assessment is distinct from the
project/mission/slice documents supplied to the diagnosing agent. Embedded
authority is limited to canonical `SPEC.md` and project/mission/slice YAML files
at their corresponding work-tree nodes, at most 64 KiB each. Other paths and
symlink aliases are reported unavailable without embedding their contents.
Each entry retains its authority level. Project files must be at the configured
project root; mission files must belong to the finding's mission; slice files
must also have a sibling `SPEC.md` declaring the finding's slice ID (and matching
mission when declared). A sibling slice or another mission is unavailable even
when its filename is canonical. Without mission/slice scope, those authority
levels remain unavailable.

## Current selected context and correction

`diagnosis show` and `list` refresh top-level `authority` at `authorityReadAt`.
The original `packet.authority` and presentation receipts remain historical
snapshots. Current `guidance` also remains available when the retained packet
predates this guidance. Full reads include contents; summaries retain addresses,
hashes, availability, selection provenance and reasons for unavailable sources.

The reader reuses `project.yaml`'s `install.context` and the selected
`lifecycle.profiles[profile].workflow.context_refs`, plus the current mission's
`lifecycle.workflow.context_refs`. Project owners can select planning authority
and relevant causal corrections there, even before any mission exists:

```yaml
install:
  context:
    - PREFLIGHT.md#current-authority
    - evidence/process-correction.md
```

These are authored selections, not inferred authority or executable adoption.
Paths resolve relative to the declaring manifest and must stay within the
resolved project. Local `file.md#h2/h3` addresses use the existing Markdown
reader. Missing/ambiguous sections, aliases, unsupported addresses, unknown scope
and missing selections' files remain unavailable. No links are followed
recursively and no successor mission is guessed. The reader accepts at most 32
selected addresses, each source file at most 64 KiB, with 128 KiB of selected
content in total; exceeded limits are visible as unavailable references. A hash
for a section covers exactly the returned section bytes. Bare library refs and
remote URLs are not fetched by this local reader.

Authority and current usefulness are separate questions. An incomplete global
outcome census cannot justify retaining a particular restriction whose premise
was disproved. Read current corrections before interpreting historical
dispositions, preserve unrelated valid boundaries such as publication authority,
and distinguish automatic wake/receipt bookkeeping from useful owner action.
Normal interactive planning is not itself pathology. State the relevance and
cost of the interruption in the assessment; do not turn the signal into a
recurring self-audit or require a universal outside reviewer.

Checkpoints are audited under `health/checkpoints/history/`; replaying identical
bytes writes nothing. Later censuses advance observation time. High-to-high
observations retain episode identity; a clearing checkpoint and later recurrence
produce a cleared episode and a new ID. Reads never update checkpoint state.
Stale, unavailable, contradictory, clipped, or missing evidence cannot admit a
diagnosis. No findings is not a healthy assertion. The current source bounds are
200 lineages, 10,000 transitions and 1,000 product outcomes per checkpoint, and
1 MiB per input. Unsupported or invalid sources fail visibly.

## Investigate and record a disposition

Read the exact evidence and the current authority. Trace where the pattern
began, test whether your own actions amplified it, and distinguish another seat
or stale guidance. A second opinion is optional. The packet is a starting point,
not a closed evidence set.

```json
{
  "verdict": "insufficient evidence",
  "causalStart": null,
  "steering": "Inspect the missing outcome evidence; apply separately established corrections within current authority.",
  "uncertainty": "The cited artifact does not yet establish the denominator.",
  "evidenceRefs": ["<inspected-evidence-path>"]
}
```

```sh
rig health diagnosis record <qitem-id> --file disposition.json
rig health diagnosis show <qitem-id>
```

Verdicts are `false positive`, `early real condition`, `established pathology`,
`insufficient evidence`, or `resolved`. The disposition is retained on the
diagnostic qitem's transitions and visible in CLI output and the queue. Recording
it does not close or alter the underlying product work. Changed dispositions
retain earlier testimony; exact replay is a no-op. A detector clearing is
recorded separately from an agent declaring the problem resolved.

An optional `correction` keeps the causal judgment, proposed or taken action,
and later behavioral effect distinct. It does not require a complete `progress`
census. For example, a retained-case assessment can record:

```json
{
  "applicability": "The retired emergency restriction no longer applies; publication still needs its separate decision.",
  "causalJudgment": "The retained trace attributes persistence of the restriction to a disproved premise.",
  "action": {"state": "taken", "summary": "The authorized restriction was retired in the retained case.", "evidenceRefs": ["evidence/correction-action.md"]},
  "effect": {"state": "unobserved", "summary": "No later natural opportunity has been observed.", "evidenceRefs": []}
}
```

Put this object beside `verdict`, `causalStart`, `steering`, `uncertainty` and
`evidenceRefs` in the existing disposition. Action states are `proposed` or
`taken`; effect states are `unobserved` or `observed`. Every referenced artifact
must be available locally; `taken` and `observed` each require evidence. These
checks establish availability, not causal truth. The receipt retains evidence
hashes and `assessment` identifies the actual queue actor, time and transition.
`behavioralEffect` is the latest owner's reported effect, defaulting to
`unobserved` for legacy dispositions. It is not an independent certification.
A later owner submission preserves previous testimony. Record an observed
effect only from a real later opportunity, with its next decision, useful work,
recurrence and interruption burden; a scripted replay proves mechanics only.
Closing a row, changing a prompt or clearing a numerical signal never supplies
that evidence automatically. No opportunity means unobserved, with the release
claim left to its decision owner. This guidance neither re-enables diagnosis nor
assigns corrective work.

## Human delivery

An assigned agent may explicitly request human escalation:

```sh
rig health diagnosis notify <qitem-id>
```

It requires a registered `human.address` and an admitted `human.conditions`
entry (`critical`, `established pathology`, or `confirmed ceremony`). The connector must be enabled
and pass live readiness checks. The current connector implementation verifies
Slack scopes and channel membership; the diagnosis service itself uses a
transport-neutral readiness port. The existing gateway owns delivery policy
and posting. One human request is retained per episode, and its actual delivery
outcome comes from queue receipts. `pending` is never presented as `posted`.
Inspect the returned qitem's transitions for the connector receipt. No periodic
health check performs remediation. With `human.conditions=["confirmed ceremony"]`,
the enabled diagnosis loop automatically requests one notification for an active,
confirmed passive ceremony episode. Provisional, indeterminate, cleared, and stale
episodes never notify. The existing readiness/gateway path owns the effect; an
unready connector leaves a visible, deduplicated readiness receipt. Later checks
may retry readiness but never create a second request for an existing episode.
Read-only list/explain/preview commands never send.

## Read-only consumers and calibration

A consumer such as a later Herder plugin reads `GET /api/health` and
`GET /api/health/:findingId`, or the identical `rig health --json` and
`rig health explain <finding-id> --json` records. The record schema is
`openrig.health/v0alpha1`; list metadata is `openrig.health-list/v0alpha1`.
For a source that bounds its input, list metadata also carries `coverage`
(`source`, `total`, `evaluated`, `omitted`, `limit`, `order`, `partial`), and
`rig health policy` reports the scheduled evaluation's coverage under
`engine.lastEvaluation.coverage`. Preserve ID, status, policy version, time window, freshness, evidence and
threshold together. There is no health score or implicit remediation authority.
The default list excludes cleared records; explicit cleared queries and exact
ID reads retain them while the source can still project them. A recurrence after
clear receives a new episode ID. This is an on-demand projection, not a history
store; a detail 404 does not prove resolution.

Lists default to 100 and cap at 200, with `total` and `truncated` explicit.
Ceremony findings take precedence before the cap so context pressure cannot
hide the primary signal. Narrow a truncated query; do not certify the unseen
remainder. Empty is not healthy, unavailable is not empty, and an indeterminate
finding cannot authorize a diagnostic occurrence except the explicit, fresh
`needs-diagnosis` passive candidate described above. An existing occurrence may
receive one status-observation receipt when its source becomes indeterminate;
that does not create another obligation or wake.

Live sources supply context pressure, passive ceremony candidates and attributed
assessments, plus optional ceremony checkpoints.
Behavioral and epistemic categories intentionally have no detector. Review
carousel, redundant wakes, stale directives and scope admission have typed
evaluators and replay controls, but the live source does not infer their missing
candidate-change, rescue, directive-conflict or admission-authority facts.
Untagged work and undeclared relationships remain outside passive ceremony
coverage; normal tagged work no longer requires a special outcome census. A small lineage below the configured threshold may still deserve an
agent's inspection; the threshold is a conservative admission rule, not a
definition of good process.

`packages/daemon/scripts/probe-health-calibration.mjs` accepts a sealed replay
export and output directory after daemon/CLI/TUI builds. It drives the compiled
checkpoint/list/explain/diagnosis commands, renders the TUI, retains exact
records and screens, compares database and filesystem effects around reads,
and measures query cost against declared budgets. Every write uses a disposable
home and database. Historical expected states must be grounded independently
of the detector formula; incomplete outcome evidence is an indeterminate case,
not a denominator of one. A calibration report describes its selected corpus
and remaining blind spots, not a fleet-wide false-positive rate.
