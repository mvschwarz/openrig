# OPR.0.5.6.23 — sessionSource transform-leg census (base 1f6675b09cb3f8a96c36db252b758c862ba47160)

Re-derive with one command (code lines only; types/comments excluded by inspection):

    grep -rn "sessionSource\|session_source" packages/daemon/src --include='*.ts'

The class closes by THIS census, not by fixing named instances. Union optional fields
at base: `ref.value` (fork arm), `ref.version` (agent_image arm); rebuild's `ref.value`
is required. Member-level optional fields ride the same serialize seam and are in the
same silent-erasure class where a parse leg carries them and a sibling leg drops them.

| # | Leg (file:line) | Kind | Disposition |
|---|---|---|---|
| 1 | domain/rigspec-codec.ts:80-83 serialize member.session_source | transform | **FIXED-HERE (member a)**: emitted `kind` + conditional `value`, never `version`; presence-invariant emission replaces it |
| 2 | domain/rigspec-codec.ts member block (same fn) | transform | **FIXED-HERE (disclosed third member)**: parse carries `compaction_strategy` (schema :1058) but serialize never emits it — same class, same seam |
| 3 | domain/rigspec-schema.ts:1013,1025,1033-1037 normalize | transform | AFFIRMATIVELY-CLEARED: carries `value`, carries `version` (String-coerced), carries `compaction_strategy` (:1058) |
| 4 | routes/rigs.ts:95-141 add-member ingress | transform | AFFIRMATIVELY-CLEARED (S03-lineage): fork `value` conditional-carried; agent_image `version` String-coerced (OPR.0.5.6.3 repair comment in situ); invalid shapes fall through RAW (presence never converted to absence) |
| 5 | domain/rig-expansion-service.ts:170 expand mapping | transform | FIXED-BY-S03: whole-object spread (`...("sessionSource" in member ...)`) |
| 6 | routes/agent-images.ts:203-262 fork ingress + memberFragment | transform | **FIXED-HERE (member b, desk ruling 22:22Z)**: sessionSource is ORIGINATED complete (agent_image version always present; fork value always present), but the memberFragment forwards only runtime/agent_ref/profile/cwd/codex_config_profile/permission_policy and DROPS node-carried `model`, `role`, `restore_policy`, `label` — a forked seat silently loses its model pin (the 0.4.6.PI1 class). `compaction_strategy` is NOT a nodes column → CLEARED-WITH-REASON: the leg cannot forward what the node row does not carry |
| 7 | domain/agent-images/evidence-guard.ts:180 | read-only | OUT-OF-CLASS: redaction presence check; transforms nothing |
| 8 | domain/bundle-agent-images-router.ts | — | **ZERO sessionSource legs — LOUD SKIP.** Derivation: the census grep returns no hit in this file; nothing to audit is a positive finding, not a silent green |
| 9 | domain/rigspec-instantiator.ts:1827-1875 launch consumption | consume | AFFIRMATIVELY-CLEARED: fork ref consumed whole; agent_image `version` consumed with the documented `?? "1"` default; rebuild `value` required |
| 10 | domain/session-source-rebuild-resolver.ts:84 | consume | AFFIRMATIVELY-CLEARED: consumes required `ref.value`; no optional traverses |
| 11 | adapters/terminal-adapter.ts:41, adapters/stub-runtime-adapter.ts:169 | reject | OUT-OF-CLASS: error-string rejections; no field transform |
| 12 | domain/types.ts:937-, :1026, :1288 | types | OUT-OF-CLASS: declarations, not legs |
| 13 | startup.ts, domain/startup-orchestrator.ts, domain/runtime-adapter.ts, domain/agent-images/agent-image-types.ts | comments | OUT-OF-CLASS: zero code-line hits (doc references only) |

S20 A3 R-b adjacency check (mini-req 4): the fork-ingress leg supplies NO
occupant-generation (routes/agent-images.ts fork handler and its
resolveForkSourceNode/discoverResumeToken inputs carry no generation field) — the
pre-named STOP does not trigger; recorded here as checked-absent.
