---
name: test-driven-development
description: Write the failing test first, then the minimum code to pass.
---

# Test-Driven Development

No production code before a failing test.

## Required loop

1. Write one failing test for the next behavior.
2. Run it and watch it fail for the right reason.
3. Write the minimum code to pass.
4. Run the test again and watch it pass.
5. Refactor only after green.

## Red flags

Stop if you catch yourself thinking:
- "I'll write the tests after"
- "This change is too small for TDD"
- "I already know what code I need"

That is how hidden regressions get shipped.

## Good implementer behavior

- tell QA what failing test you are starting with
- keep each cycle small
- do not smuggle unrelated refactors into the same task
- if the test is awkward to write, question the design instead of skipping the test
