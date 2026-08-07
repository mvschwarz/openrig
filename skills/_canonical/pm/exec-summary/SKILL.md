---
name: exec-summary
description: "Generate a 1-2 page executive summary for a feature — orients sales, leadership, and engineering from a single document."
---

You generate an executive summary for a feature that's ready for development. The summary orients three audiences from one document: sales (pitch), leadership (strategy), and engineering (behavioral overview).

## What You Produce

A single `executive-summary.md` file in the feature folder. 600-800 words excluding mockups and FAQ. Written in present tense as if the feature already exists.

## Sources to Read

Before writing, silently gather all context from the feature folder:

1. **requirements.md** — acceptance criteria, business rules, scope, user stories
2. **background.md** — customer drivers, competitive context, regulatory considerations
3. **validation.md** — demand evidence, status quo, desperate user, narrowest wedge
4. **supporting/mockup-ascii.md** — visual mockups (pull 2-3 key screens)

## Output Structure

```markdown
---
title: "Executive Summary: [Feature Name]"
feature: [feature-folder-name]
status: [ready | in-progress | shipped]
jira: [ticket key]
updated: [today's date]
---

# [Feature Name]

## The Problem
[2-3 sentences. Customer pain in their language. Name real customers/prospects.]

## The Solution
[2-3 sentences. What we built, present tense. No jargon.]

## Who It's For
[Primary personas + named customers/prospects waiting for this.]

## Why Now
[Deals it unblocks, competitive gap it closes, what it enables next.]

## How It Works
[5-8 key capabilities. Describe actual user-facing behavior — enough for a dev to understand what to build.]

## Key Decisions
[5-8 non-obvious business rules and design choices. Focus on surprising or counter-intuitive ones.]

## Visual Preview
[2-3 ASCII mockup screens from supporting/ — the key screens that tell the story.]

## What We're NOT Building
[5-8 key out-of-scope items with brief reason.]

## Dependencies & Sequencing
[What must ship first. Cross-feature dependencies. Prerequisites.]

## Success Metrics
[2-4 measurable outcomes. Mix of usage and business metrics.]

## FAQ

### For Sales
[2-3 questions. When available, what to tell prospects, competitive positioning.]

### For Leadership
[2-3 questions. Opportunity cost, strategic fit, risks.]

### For Engineering
[2-3 questions. Dependencies, known risks, what's deferred, data model implications.]
```

## Writing Guidelines

- **Present tense throughout.** Write as if the feature exists.
- **Customer-readable language.** A prospect should understand sections 1-5.
- **Be specific, not vague.** Name deals, dollar amounts, competitors.
- **Key Decisions should surprise.** Don't list obvious things.
- **Mockups are curated.** Pick the 2-3 that tell the story.
- **FAQ answers should be direct.** No hedging.
- **Hard cap: 2 pages** for core content. FAQ can be a third page.
