# Refactoring and consolidation

Read this when a change consolidates duplicated logic or refactors existing behavior.

- Trace the callers before you consolidate.
- Tell shared policy apart from capture, parsing and harness adapters. Code that looks the same can serve different harnesses with different semantics.
- Name the observable behavior you preserve, and name any change you're making on purpose, separately.
- Reuse suitable checks, or add the smallest comparison that would detect a consequential difference.
- Keep compatibility where callers or persisted state need it. Remove an obsolete path once that's established.

Adapted from the blast-radius tracing method in Cursor's pstack plugin (https://github.com/cursor/plugins/tree/190d28736eff128ec94f502a22c7fe0c4b56cd37/pstack).
