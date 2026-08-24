---
name: software-for-agents
description: |
  Load this FIRST, before you assume how anything here works — especially before building, modifying, or
  "fixing a bug" in an OpenRig or studio-box system, or when something behaves unexpectedly and you're
  about to treat it as a code bug. You are almost certainly NOT operating in traditional software. This
  is a self-improving MARKDOWN CONTROL PLANE: the substrate is markdown + YAML + JSON + folder structure
  (skills, instructions, bootstrap files, schemas, conventions), and most "bugs" are coherence gaps in
  that layer, not broken functions. Read this to form the correct mental model so your fixes land at the
  precise spot that stops the footgun for every future rig — not just patch a symptom. It also covers why STUDIO APPS skip the mockup phase — for an agent-built app the build is as fast as the mockup, so the PRD is the fleshed intent (velocity as method, not a quality waiver). NOTE: the
  bug-tolerance in this model is SCOPED to agent-managed software; the OpenRig core and rigs.to stay
  rock-solid — see the scope block up top before you apply anything here.
metadata:
  openrig:
    stage: factory-approved
    audience: any agent building on OpenRig or a studio box — the first-load mental model
    sibling_skills:
      - forming-an-openrig-mental-model
      - openrig-program-manager
      - mission-slice-sop
      - openrig-user
---

# Software for agents — the markdown control plane

## Where this applies — and where it does NOT (read this first)

This mental model — *most bugs are coherence gaps, not code*; *ship-and-flag when unsure*; iterate fast —
is scoped to **agent-managed software: the studio-box mini-apps and any agent-in-the-middle / rapidly-
evolving lightweight UI** where an agent sits in the loop and downstream cleanup is cheap. It is NOT a
universal license.

**It does NOT apply to TRADITIONAL software held to a rock-solid, no-bugs bar:** the **OpenRig CLI
surfaces**, the **OpenRig repo** (daemon / CLI / UI / adapters), and the **rigs.to website**. There, a bug
is a bug — reproduce it, fix it in code, hold the full-rigor gate. Do NOT treat a real defect there as a
markdown coherence gap, and do NOT "ship and flag." If you are building or fixing OpenRig core or rigs.to,
the tolerance in this skill is OFF and `product-is-the-truth-not-the-proof` governs. **Know which lane
you're in before you apply anything below.**

---

You inherited the accumulated footgun-map of thousands of rigs that ran before you. They found and
solved most of the traps. Your job is to find the *next* one and patch it at the precise optimal spot
in the substrate, so the rig after you starts from a higher ledge. That is the actual work. Whatever
you were "assigned" (a video, a feature, a fix) is the vehicle for surfacing it.

## 1. This is not traditional software — it's a control plane made of markdown

In traditional software a bug is a broken function you fix in code. Here, the system you operate in is
an **agent-in-the-middle** system whose substrate is **markdown + YAML + JSON + folders**: skills,
instructions, bootstrap files (`CLAUDE.md`/`AGENTS.md`), schemas, `culture.md`, mission/slice notes,
conventions. **The agents ARE the backend.** So most "bugs" are not broken code — they are **coherence
failures in the markdown layer**: an instruction that's unclear or missing, a schema that drifted from
its documented state, a convention living in one seat's head instead of a skill.

**Consequence:** when something surprises you, your first hypothesis is *"the control plane is unclear
or drifted here,"* not *"the code is broken."* Sometimes it IS the code (fix it — don't overfit on
markdown; see §5, and mind the scope block above: in OpenRig core / rigs.to the code IS the first
hypothesis). But the highest-leverage fixes in the agent-managed layer are usually: make the substrate
coherent again at the exact spot the confusion arose. Keep the markdown/schemas/conventions in sync with
reality and the system **self-improves** — the next rig inherits the patched substrate and never re-hits it.

## 2. Progressive disclosure — skills are a hot tier, not a manual

Skills are misnamed. They are a **progressive-disclosure primitive**. Think CPU cache / hot storage
tier: the **name + description of every skill is always ambiently loaded** — a hot tier of awareness
the agent carries without opening anything. That is enormous leverage, good or bad. So:

- **Write skill name + description as TRIGGERS** — *why/when do you reach for this?* — not as titles.
  The hot tier's whole job is to fire when an agent doesn't yet know it needs the skill (the
  "you don't know what you don't know" problem). This skill's own description is written that way.
- **Reaching for a skill unfurls a trail.** A good skill routes you — breadcrumbs, pointers, maps —
  so it becomes *inevitable* you find the exact context on disk for what you're doing.
- **If the context doesn't exist, generate it.** A skill can ship **scripts** that produce context
  optimally shaped for a decision, or that execute a fiddly API surface so you don't stumble through 12
  tool calls discovering it. Use a **script as a prompt**: run it — if it works, the result IS your
  context; if it fails, it should fail in a way that *teaches* you how the system works, so you can
  read the script, understand the edge case, and do the thing manually. Scripts belong in the skill
  folder next to the SKILL.md.

## 2b. Self-certifying artifacts — the convention 5 seats (both models) converged on

The single most expensive failure class in production is **not being able to tell a finished artifact
from an unfinished one.** A mid-write file read as final; a render OOM-killed mid-write left a corrupt
`.mp4` that passed a filename check; a truncated clip passed a duration check and froze on playback. In
one build, five seats — Claude *and* Codex, independently — each invented a *different* ad-hoc
completeness check (ffprobe moov, duration compare, filename convention, manifest assetExists, ffmpeg
input count). Five blind spots. So make it ONE shared primitive:

**When you author ANY tool that produces an artifact (render / composite / export / cut), it must
self-certify:**
1. Write to `<name>.partial` (never the final path directly).
2. **Verify the content** — the specific property that can be wrong, not a proxy: moov atom present,
   duration matches the intended window, audio stream present, colorspace/hue correct, resolution =
   delivery res. (Filename ≠ correct; duration ≠ complete; "clean-encoded" ≠ right.)
3. **`fsync`, then atomically `rename`** `<name>.partial` → `<name>` (rename is atomic; a half-written
   file never appears at the real path).
4. Write the manifest, then a **`.done` sentinel LAST.**

Then *"is this finished?"* is **one `stat` of `<name>.done`** — identical for every tool, seat, watcher,
and a compacted agent restoring cold (who is least equipped to know what was mid-write when the lights
went out). **Consumers fail closed:** e.g. a swap-into-slot (`restore_occupant`) must refuse an artifact
lacking `.done` or failing the verify-gate. This convention collapses the whole "content over filename,
disk over memory" discipline into one check the substrate enforces for you. Build the sentinel; the
workarounds disappear. (Code-side companion: a fail-closed verify-gate wired into the swap verb — a
coordinated build with the tool owner, not a solo markdown edit.)

## 3. Build it like software — piggyback on what agents are trained for

Agents are fine-tuned to write code and build software; the harness itself is a terminal/coding
instrument. So **whatever you're asked to build — even a video — map the process to a software SDLC**
and you inherit all that baked-in muscle memory. This is why, e.g., the mini-NLE's beats carry
reference IDs like `1.1 / 2.1`: a storyboard is the **human-facing visual metaphor**, but underneath it
is a **specification** — sections, beats, success criteria, the thing being built.

Use an **agent SDLC**, not the antiquated human one (which was shaped around human-org weaknesses):
**intent → plan → spec → build → verify → review → QA → done.** The human slots in as **steering,
judgment, taste, review**; the agents do the technical nitty-gritty, in parallel, fast. Map any
"build X with agents" task onto this and the primitives (specs, locks, proof, verification) become
intuitive instead of alien.

## 4. Phases and the LOCK gate (spec-locking, not just "done")

Building runs in **phases**, and each phase has a **lock gate** — you don't advance until the taste/
steering owner has locked it. This is exactly *don't start building until the PRD is locked by product*:

- **Storyboard / intent phase** — done on the **canvas** now (the highest-bandwidth human↔agent surface:
  the human steers, chats, annotates/circles; agents build structure fast). Iterate here; get the
  storyboard through the canvas gate. (Canvas largely replaced the NLE's old in-timeline storyboard.)
- **Plan phase (brief, in the NLE)** — build the spine with placeholders so the human can click through
  the main-stage player and *feel the flow* (sequencing problems surface when placeholders are strung
  together with audio). **Lock every beat** = the spec is approved; this is what unlocks parallel build.
- **Fill phase** — many agents build each beat in parallel, in clear lanes. **Lock a beat when it's
  final** (`/api/approve`): lock means *don't touch, we're good, signal to everyone incl. the human.*
  Unlock to revise. **All beats locked = done.**

The lock is the "finished" primitive at the editorial layer. Locking a whole phase's beats before the
next phase is the discipline that lets 10 agents work in parallel without catastrophic collisions —
everyone knows the target, their lane, and who judges done (the **producer owns the final product**).

## 4b. Studio apps skip the mockup phase — the build IS the mockup

For a **studio app**, do not run a separate mockup phase. The whole point of the Studio is that a mockup
buys you almost nothing here: **as fast as it takes to build a mockup, you can build the running app** —
an unlock made possible by agentic engineering. A mockup is only ever a device to flesh out the PRD; once
the PRD and its settled answers exist, that phase is **done**. The Studio is a lightweight, rapid-velocity,
agent-in-the-middle leveraged system: build apps fast, iterate on them fast.

The phase model above collapses accordingly:

1. **The PRD + settled answers ARE the fleshed intent** — no separate mockup gate, no plan-lock-on-mockups step.
2. **Spec-lock the WHAT** — `rig scope slice approve --scope spec` locks the intent the PRD already fleshed.
3. **BUILD the app**, then **iterate on the RUNNING app at mockup speed** — the running thing is the
   iteration surface, not an image.
4. **LOOK is on the running screens** (any "mockup" proof tag now points at the running app's screens),
   then **proof-lock** — `rig scope slice approve --scope delivery`. A slice is not done until every
   proof-contract item has evidence from the **running app**.

**Velocity is the METHOD, not a quality waiver.** The LOOK is still a real LOOK; the proof contract still
binds at delivery. You are removing a redundant artifact, not lowering the bar.

**Scope — this does NOT generalize** (consistent with the scope block at the top): it applies to the
studio-app / agent-in-the-middle loop only. Outside that loop, a **locked design mockup that a slice must
match is still legitimate** — do not strip mockups from traditional or design-locked work. Know which lane
you're in. For the build mechanics, see the studio's build skill (`building-studio-apps`); this section is
the *why* and *when*.

## 5. Where to fix — and don't overfit on markdown

- **Precise-spot discipline:** find the *one* place a coherence fix belongs (the skill, the schema, the
  bootstrap, `culture.md`) so it can't recur — not a symptom patch. Ask: *what would have prevented
  this for every future rig?*
- **Don't overfit on the markdown layer** — deterministic code bugs exist and you should fix them. The
  studio-box apps (NLE, canvas, media manager, shell) live in the **studio-box repo**, portable across
  hosts (VPS/Mac/VM). **A code fix there fixes ALL studio boxes, not just this host** — so: clear bug or
  broadly-useful feature → ship it; host-specific behavior → make it optional/guarded. When unsure, ship
  and flag it; downstream cleanup beats you becoming the bottleneck. *(This ship-and-flag latitude is the
  studio-box / agent-managed lane only — re-read the scope block: OpenRig core + rigs.to hold the
  rock-solid bar, no ship-and-flag.)*
- **Culture lives in `culture.md`** — the rig's social contract / constitution: how the team
  coordinates, the parallel-agent lanes, the phase-locking discipline, who owns the final call.
  Coordination is largely **emergent** (bottom-up, evolutionary pressure across thousands of rigs) — but
  once a pattern proves out, *write it down there* so it's inherited, not re-discovered.

## The one-line seed
You're not maintaining code; you're **gardening a self-improving control plane made of markdown and
schemas, using software-engineering muscle memory, with the lock as your spec-gate** — and every
footgun you patch at the right spot (in the agent-managed lane) makes every future rig better. See also:
`forming-an-openrig-mental-model` (the OpenRig runtime), `mission-slice-sop` (the SDLC operating
procedure), `openrig-user` (the CLI surface), `product-is-the-truth-not-the-proof` (the doctrine that
governs the rock-solid lane). *(The "agents ARE the backend" idea — agent-in-the-middle — is inlined in
§1; a standalone `agent-in-the-middle` skill is a future candidate, not yet authored.)*
