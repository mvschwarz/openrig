# Refocus

1. What is the person actually trying to get? Not your current task — the outcome.
2. Does what you are doing RIGHT NOW move that? If you cannot say what a user gets, stop and say so.
3. What have you concluded without opening the file or running the thing?

Discomfort on any of these is the signal: drift feels like work.

The `refocusing` skill carries the source-appropriate path-only trace. Its
`scripts/trace-to-root.py` walks both current trees by default: topology `LEARNED.md`, then work
`SPEC.md` intent plus `NOTES.md`. Change breadth with `OPENRIG_REFOCUS_TREES=topology|work|both`
and read depth with `OPENRIG_REFOCUS_DEPTH=light|full`.

Replace this default without editing the plugin. The content ladder, highest precedence first, is:

1. `OPENRIG_REFOCUS_CONTENT_REF`, resolved by `rig context get`.
2. `OPENRIG_REFOCUS_CONTENT_FILE`, an operator-authored file.
3. `$OPENRIG_HOME/refocus/REFOCUS.md`, instance content.
4. This shipped default.

Fresh seats receive the separate onboarding assets `openrig-onboarding-01.md` and
`openrig-onboarding-02.md`. This file only cites those assets; it does not copy their world install.
