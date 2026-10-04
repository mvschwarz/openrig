# Find specialists with rosters

A roster records who to involve for a purpose and why. The same seat can appear in several
rosters with different capabilities and engagement. Membership is a recommendation, not an
assignment or a grant of authority. Contact someone with the existing `rig send` or `rig queue` commands.

Put JSON files in `<workspace.root>/rosters/`. Read `workspace.root` with
`rig config get workspace.root`, or use `--folder` to read another folder in place.

```sh
rig roster list
rig roster show production --json
rig roster find 'colour grading'
rig roster find 'editor@studio' --folder ./rosters --json
```

`list` reads authored purposes and curators without contacting daemons. `show` and `find` read the
configured daemon and registered HTTP hosts through `rig ps`. Each command reads current node
listings once per route, not once per member. `find` matches part of a capability tag or seat
address, ignoring case. A seat in two rosters produces two recommendations with their own reasons.

```json
{
  "version": 1,
  "id": "production",
  "name": "Production",
  "purpose": "Make a film",
  "curator": { "seat": "lead@studio", "host": "host-a" },
  "updated_at": "2026-10-01",
  "members": [{
    "seat": "editor@studio",
    "host": "host-a",
    "capabilities": ["colour grading"],
    "engagement": ["consult", "review"],
    "use_when": "Choose a look or review a grade",
    "why": "Knows the footage and the delivery requirements",
    "caveat": "Ask about availability first"
  }]
}
```

Use the serving daemon's `hostSelfId` and the exact seat address from `rig ps --nodes -A --json`.
A caller's local host alias is not necessarily that identity. Other hosts must already be
registered; the roster command does not register them or dispatch work. Existing HTTP fan-out
reports SSH-only hosts as unsupported. JSON retains per-host failures and partial-read warnings.

Authored files contain recommendations, not runtime facts. Extra fields are ignored, including
any authored runtime, model or activity. At read time the command joins by exact host self-id
and seat. Unmatched or conflicting observations are `unknown`; a seat not reported running is
`stale`, with current runtime/model unknown. The configured model is the registry declaration.
The observed native model remains unknown: these commands do not open native histories or verify
what model the provider is running. Activity includes its sample time when the daemon supplies it;
activity and running status do not promise that someone is available for new work.

The JSON `observations.readAt` is when the inventory read completed, not a native observation
timestamp. Rosters are never rewritten by these commands. Malformed files produce warnings while
valid rosters remain usable; duplicate IDs make `show` report ambiguity instead of selecting one.
