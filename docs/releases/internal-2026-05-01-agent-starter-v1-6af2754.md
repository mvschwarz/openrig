# OpenRig Internal Source Runtime: Agent Starter v1 (`6af2754`)

## Summary

Agent Starter v1 is present in OpenRig source at commit `6af2754`, but it is
not yet a public npm/GitHub release. Lifecycle selected internal source-state
runtime promotion with an L4 active-control-plane gate before host agents can
rely on it.

## Included In This Runtime State

- RigSpec member `starter_ref` for named Agent Starter registry entries.
- Daemon-side Agent Starter resolver with path-aware credential scanning.
- STARTER-layer `guidance_merge` delivery before ordinary startup files.
- `rig up --plan --json` `resolve_starter` stage with `detail.starterContent`.
- Validation rejection for terminal members and `starter_ref +
  session_source.mode: fork`.

## Operator / Setup Notes

- The active host daemon was still `rig-real-17812d5` at Lifecycle curation
  time. It does not serve this feature.
- Availability requires an operator-window upgrade to a runtime at or after
  `6af2754`, including copied-production-DB rehearsal and post-upgrade live
  smoke.
- No npm publish, git tag, GitHub release, or package version bump is included
  in this note.

## Known Limitations

- Only `guidance_merge` starter content is covered in this vertical.
- `skill_install`, `send_text`, native fork composition, `rig agent-starter`
  management commands, UI, bundles, marketplace, signing, and cross-host
  transport remain future work.
- The daemon depends on a reachable Agent Starter registry, currently the v0
  substrate registry fallback at `openrig-work/specs/agent-starters/`.

## Verification Performed

- L1 source-backed tests for schema, codec, resolver, instantiator, route, CLI
  plan output, and SQLite roundtrip.
- L3 auth-ready disposable Tart VM proof for Claude and Codex
  `guidance_merge` delivery.
- L4 active-control-plane proof remains blocked on the operator upgrade window.

## Commits Included

- `eb4acf2` - schema + resolver scaffolding.
- `2673e30` - codec emit, expansion preservation, redacted refusal.
- `2f8f269` - adapter pass-through and `rig up` integration.
- `6af2754` - real-adapter, route, CLI plan, continuity, and SQLite proof.
