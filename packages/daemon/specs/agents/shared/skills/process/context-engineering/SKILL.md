---
name: context-engineering
description: >-
  Use when designing, reviewing, or debugging how an agent's context window gets filled, pruned,
  or shared — choosing what loads at boot versus on demand, sizing an install or an always-loaded
  file, fixing an agent that drifts, repeats itself, or forgets constraints mid-task, planning
  compaction or summarization, deciding single-agent versus subagents, engineering handoffs
  between agents, or picking a tool loadout. NOT for rewording a prompt's tone, choosing which
  model to pin, or debugging business logic — those are adjacent moments this skill does not
  serve.
metadata:
  openrig:
    stage: provisional
---

# Context Engineering

Curated distillation of the best publicly available expertise on context engineering for coding
agents, drawn from primary sources at Anthropic, OpenAI, and leading practitioners (Manus,
Cognition, Chroma, LangChain, Drew Breunig, and others). Load on the moments the description
names; it is deliberately not part of any base walk.

---

## 1. The mental model: what context engineering is

**Definition.** Context engineering is "the set of strategies for curating and maintaining the
optimal set of tokens (information) during LLM inference" — everything that lands in the window:
system instructions, tool definitions, retrieved data, message history, and tool outputs, not
just the prompt text (Anthropic, *Effective context engineering for AI agents*). Andrej
Karpathy's framing, popularized via LangChain: "the delicate art and science of filling the
context window with just the right information for the next step" — the LLM is a CPU and the
context window is its RAM, and your job is deciding what gets loaded into RAM at each step
(LangChain, *Context Engineering for Agents*).

**Why it superseded prompt engineering.** A chatbot answers one question with whatever fits in
one turn. An agent runs in a loop, accumulating tool results, file contents, and history across
dozens or hundreds of steps. The improvements stop coming from rewording instructions and start
coming from *rewiring* — what the agent retrieves, in what order, and what gets evicted when the
window fills (Anthropic, ibid.). Philipp Schmid's formulation of the practical consequence:
"Agent failures aren't only model failures; they are context failures." Most of the time when a
capable model does something dumb, the context it was given made the dumb thing likely
(Schmid, *The New Skill in AI is Context Engineering*).

**The physical constraint: attention is a budget, not a bucket.** Three mechanisms make context
a scarce resource rather than free storage:

1. **Quadratic attention.** In a transformer, every token attends to every other token — n²
   pairwise relationships. Longer sequences stretch the model's ability to capture them, and
   models are trained on distributions where short sequences dominate, so they have fewer
   specialized parameters for context-wide dependencies. The result is "a performance gradient
   rather than a hard cliff" (Anthropic, *Effective context engineering*).
2. **Context rot.** Chroma's study of 18 frontier models showed reliability degrades as input
   length grows *even on trivially simple tasks* like retrieval and text replication — and
   degradation starts well before the window is full. What matters is not just length: distractor
   presence, needle–question similarity, and haystack structure all change how fast performance
   collapses (Chroma, *Context Rot*).
3. **Position effects.** Models exhibit a U-shaped attention curve: information at the beginning
   or end of a long context is used far better than information in the middle (Liu et al.,
   *Lost in the Middle*).

**The one-sentence discipline.** From Anthropic: **"Find the smallest set of high-signal tokens
that maximize the likelihood of some desired outcome."** Everything else in this pack is a
technique in service of that sentence.

**The components you are engineering.** Schmid's inventory is a useful checklist of what
actually occupies the window: (1) system instructions, (2) the user's immediate request,
(3) state/history of the current session, (4) long-term memory, (5) retrieved external
information, (6) tool definitions, (7) output-format specifications (Schmid, ibid.). Each is a
separate dial. When an agent misbehaves, walk this list asking "which of these is missing,
stale, bloated, or contradictory?"

---

## 2. Core principles (and the why behind each)

**P1 — Minimal ≠ short; curate for signal density.** The goal is the smallest *sufficient* set
of tokens, not the shortest prompt. A system prompt should fully outline expected behavior; the
sin is low-signal filler, not length (Anthropic, *Effective context engineering*).

**P2 — Engineer for the next step, not the whole task.** Context is curated per inference step
(Karpathy via LangChain). The question is never "what might the agent ever need" but "what does
this step need to succeed." This is why loading everything upfront loses to just-in-time
retrieval on long tasks.

**P3 — Degradation precedes exhaustion.** Budget context well below the marketed window.
Chroma showed serious degradation mid-window; Breunig collects the operational evidence: a
Gemini agent's planning quality collapsed beyond ~100K tokens *[perishable snapshot, 2025–2026: model/vendor-specific — teach the mechanism, re-verify the number]* into repeating past actions, and
Databricks found correctness falling around 32K for Llama 3.1 405B (Breunig, *How Long Contexts
Fail*). *[perishable snapshot, 2025–2026: model/vendor-specific — teach the mechanism, re-verify the number]* These specific ceilings are model- and time-specific — the durable lesson is that every
model has one, and it is lower than the spec sheet.

**P4 — Stability is money and latency: design append-only.** Manus calls KV-cache hit rate "the
single most important metric for a production-stage AI agent": cached input tokens can cost 10x
less than uncached (their figure: $0.30 vs $3.00/MTok). *[perishable snapshot, 2025–2026: model/vendor-specific — teach the mechanism, re-verify the number]* One changed token invalidates the cache
for everything after it. Therefore: stable prompt prefixes (never embed a timestamp at the top),
append-only context (never rewrite history mid-session), deterministic serialization (Manus,
*Context Engineering for AI Agents*). Anthropic's caching docs confirm the mechanics: exact
prefix matching, cache reads at 0.1x base price, and a strict tools → system → messages
hierarchy where a change at any level invalidates everything below it (Anthropic, prompt
caching docs).

**P5 — Attention has a shape; place and refresh accordingly.** Because of the U-curve (Liu et
al.) and recency effects, put durable instructions at the start, and re-surface the *current
objective* near the end. Manus operationalizes this as **recitation**: the agent rewrites a
todo.md and appends it late in context on every step, "reciting its objectives into the end of
the context" to prevent goal drift across ~50-tool-call tasks (Manus, ibid.).

**P6 — Failures are context, not garbage.** Keep failed actions and stack traces in context;
the model updates its implicit beliefs and stops repeating the mistake (Manus, ibid.). The
12-Factor Agents version: "Compact Errors into Context Window" — represent failures efficiently
so they inform the next step rather than either vanishing or flooding the window (HumanLayer,
*12-Factor Agents*, Factor 9).

**P7 — Share decisions, not just facts.** Cognition's two principles: "Share context, and share
full agent traces, not just individual messages" and "Actions carry implicit decisions, and
conflicting decisions carry bad results." Two workers given the same task summary but not each
other's traces will make incompatible implicit choices (their example: subagents building
visually clashing pieces of the same game) (Cognition, *Don't Build Multi-Agents*). Any handoff
or summary that transmits conclusions without the decisions behind them is lossy in the way that
breaks systems.

**P8 — Calibrate instruction altitude.** System prompts fail in two directions: hardcoded
brittle if-else logic (fragile, high-maintenance) and vague high-level guidance that "falsely
assumes shared context." Aim for "specific enough to guide behavior effectively, yet flexible
enough to provide strong heuristics." Start minimal with a capable model, then add instructions
driven by observed failure modes — not speculation (Anthropic, *Effective context engineering*).

**P9 — Own the window; treat the agent as a function of its context.** Deliberately control
what the model receives rather than accepting framework defaults ("Own your context window,"
Factor 3), and design the agent as "a stateless reducer" — output is a pure function of the
context you assembled, which makes context bugs reproducible and testable (HumanLayer,
*12-Factor Agents*, Factors 3 and 12).

---

## 3. The technique catalog

LangChain's taxonomy organizes nearly everything into four moves: **write** (persist outside the
window), **select** (pull the right things in), **compress** (shrink what's there), **isolate**
(split across contexts) (LangChain, *Context Engineering for Agents*). The named techniques:

### 3.1 Progressive disclosure

**What:** Structure knowledge in layers so the agent loads only what the current task needs.
Anthropic's Agent Skills are the canonical design: Level 1 is name + description metadata
(always in the system prompt — just enough to know *when* the skill applies), Level 2 is the
SKILL.md body (loaded when relevant), Level 3+ is bundled files and scripts the agent navigates
"only as needed." Context becomes "effectively unbounded" because nothing loads until demanded
(Anthropic, *Equipping agents for the real world with Agent Skills*).

**Why it works:** It converts a token cost into a pointer cost. The analogy Anthropic uses is
"an onboarding guide for a new hire" — compartmentalized knowledge absorbed progressively.

**When:** Any recurring domain knowledge, workflow, or reference material. The rule of thumb
from Claude Code's docs: always-loaded files (CLAUDE.md) get only what applies broadly to every
session; anything situational belongs in an on-demand skill (Claude Code best practices).

### 3.2 Just-in-time retrieval (vs. pre-computed context)

**What:** The agent maintains lightweight identifiers — file paths, queries, URLs — and loads
data at runtime with tools, instead of receiving everything up front. This mirrors human
cognition: we don't memorize corpora, we keep organization systems and retrieve on demand.
Metadata itself (folder hierarchies, naming conventions, timestamps) is signal (Anthropic,
*Effective context engineering*).

**Trade-off:** Runtime exploration is slower than pre-computed retrieval (embeddings/RAG). The
production answer is usually **hybrid**: some context up front for speed, plus tools for
autonomous exploration — Claude Code's CLAUDE.md-plus-grep pattern (Anthropic, ibid.). Classic
RAG — "selectively adding relevant information to help the LLM generate a better response" —
remains the right tool when the corpus is large and unindexed by structure (Breunig, *How to
Fix Your Context*).

**When:** Prefer just-in-time for coding agents in navigable environments (filesystems, git,
APIs); prefer indexed retrieval for large unstructured corpora; hybridize when latency matters.

### 3.3 Compaction and summarization

**What:** When the window approaches its limit, summarize the trajectory, reinitialize with the
summary, and continue. Claude Code auto-compacts near the window limit (LangChain reports at
~95%); the model distills decisions, code patterns, and open threads while discarding redundant
tool outputs (Anthropic, *Effective context engineering*; LangChain, ibid.).

**How to tune it:** "Start by maximizing recall to ensure your compaction prompt captures every
relevant piece of information from the trace, then iterate to improve precision by eliminating
superfluous content" (Anthropic, ibid.). Good summarization prompts enforce temporal ordering,
structured sections (environment, steps tried, current status), and explicit "UNVERIFIED"
marking on uncertain facts — because "if a bad fact enters the summary, it can poison future
behavior" (OpenAI Cookbook, *Session memory*).

**Trimming vs. summarizing** (OpenAI Cookbook, ibid.): keep-last-N-turns trimming is
deterministic, zero-latency, easy to reason about — but loses old constraints abruptly. LLM
summarization preserves long-range decisions compactly — but adds latency spikes, drift risk,
and observability burden. Trimming fits tool-heavy, independent tasks; summarization fits
long-horizon work where accumulated decisions matter.

**Cognition's caution:** a dedicated compressor model that distills "key details, events, and
decisions" is their recommended path for long tasks — and they note it "is hard to get right."
Getting it right means capturing decisions and their rationale, not just facts (Cognition,
ibid.).

### 3.4 Context editing / tool-result clearing

**What:** The lightest-touch compaction: automatically drop stale tool calls and results deep in
history while preserving the conversational thread. Anthropic ships this as "context editing";
measured effects: context editing alone gave 29% improvement on internal agentic-search evals,
combined with the memory tool 39%; on a 100-turn web-search eval it let agents complete
workflows that would otherwise die of context exhaustion while cutting token consumption 84%
(Anthropic/Claude, *Context management*).

**Tension to know:** this conflicts with P4 (append-only for cache) and P6 (keep errors). The
reconciliation: clear *bulky, stale, already-acted-upon* tool outputs (a 30K-token file read
from 40 turns ago), keep *decisions and failures*. Manus's version keeps information
*restorable* — drop a webpage's content but keep its URL, drop a document's body but keep its
path (Manus, ibid.).

### 3.5 Structured note-taking (agentic memory)

**What:** The agent writes notes to persistent storage outside the window — a NOTES.md, a
todo.md, a memory directory — and pulls them back when relevant. Persistent memory with minimal
context overhead. Anthropic's example: Claude playing Pokémon "maintains precise tallies across
thousands of game steps," builds maps, and remembers strategies across multi-hour sessions
(Anthropic, *Effective context engineering*). Anthropic's memory tool productizes this as
file-based CRUD in a client-side memory directory persisting across conversations
(Anthropic/Claude, *Context management*).

**The general form — filesystem as ultimate context:** Manus treats the filesystem as memory
that is "unlimited in size, persistent by nature, and directly operable by the agent itself"
(Manus, ibid.). Breunig's name for the family is **context offloading**; even a simple
scratchpad ("think" tool) produced up to 54% improvement on specialized-agent benchmarks
(Breunig, *How to Fix Your Context*).

**Memory layers in practice** (synthesis of LangChain + Anthropic + OpenAI): (1) in-context
working memory — the current window; (2) session-scoped scratchpads/todo files; (3) persistent
cross-session memory — files or stores, retrieved by relevance; (4) always-loaded curated core
(CLAUDE.md-class files), kept ruthlessly small. Information should flow *down* this stack as it
proves durable, and each layer buys persistence at the price of retrieval reliability.

### 3.6 Sub-agents and context isolation

**What:** Breunig's "context quarantine": isolate work in dedicated threads, each with its own
window (Breunig, *How to Fix Your Context*). Anthropic's research system is the flagship: an
orchestrator spawns parallel subagents, each exploring one facet with a clean window, each
returning a *condensed* summary — typically 1,000–2,000 tokens — to the coordinator.
"Subagents facilitate compression by operating in parallel with their own context windows"
(Anthropic, *Multi-agent research system*). The multi-agent system beat single-agent Claude
Opus 4 by 90.2% on their internal research eval, at the price of ~15x the tokens of a chat
(Anthropic, ibid.).

**When it wins:** read-heavy, parallelizable, breadth-first work — research, codebase
investigation, review — where workers' outputs are *reports* that the orchestrator integrates.
Claude Code's guidance is exactly this: "use subagents to investigate" so exploration burns a
disposable context, not your main one; and use a fresh-context subagent for adversarial review,
because "a fresh context improves code review since Claude won't be biased toward code it just
wrote" (Claude Code best practices).

**When it loses:** write-heavy, coherence-critical work. Cognition's argument (P7): parallel
workers make conflicting implicit decisions and current models can't negotiate them away;
"running multiple agents in collaboration only results in fragile systems" for building
software. Their prescription is a single agent with full traces plus a compressor (Cognition,
ibid.). OpenAI's builder guidance points the same direction: maximize a single agent's
capability first and reach for multi-agent orchestration only when single-agent complexity
demonstrably fails (OpenAI, *A practical guide to building agents*). See §6 for the
reconciliation.

### 3.7 Structured handoffs and delegation contracts

**What:** When context must cross an agent boundary, the transfer is an engineered artifact,
not a vibe. Anthropic's hard-won spec for what every delegated task must contain: **an
objective, an output format, guidance on tools and sources, and clear task boundaries.**
Without it, "agents duplicate work, leave gaps, or fail to find necessary information"
(Anthropic, *Multi-agent research system*).

**Effort scaling belongs in the contract:** encode explicit rules — "simple fact-finding
requires just 1 agent with 3–10 tool calls, direct comparisons might need 2–4 subagents with
10–15 calls each" — or orchestrators over-provision wildly (early versions spawned 50 subagents
for simple queries) (Anthropic, ibid.).

**Returns are contracts too:** the worker's report back is a compression step (1–2K tokens,
per §3.6) and inherits every summarization risk in §3.3 — a handoff that reports conclusions
without decisions violates P7. The spec-then-fresh-session pattern is the single-player
version: interview, write a self-contained SPEC.md (files, interfaces, out-of-scope,
end-to-end verification step), then start a clean session to execute it (Claude Code best
practices).

### 3.8 Tool loadout and tool design

**Selection:** "Every model performs worse when provided with more than one tool" is the
provocative headline from Berkeley's function-calling data; a quantized Llama 3.1 8B failed
with 46 tools and succeeded with 19 (Breunig, *How Long Contexts Fail*). Dynamic tool
selection — RAG over tool descriptions — improved Llama 3.1 8B performance 44% (Breunig, *How
to Fix Your Context*); LangChain cites ~3x tool-selection accuracy from the same family of
techniques (LangChain, ibid.). Anthropic's design rule: tools must have minimal overlap — "if a
human engineer can't definitively say which tool should be used in a given situation, an agent
can't be expected to do better" (Anthropic, *Effective context engineering*).

**Response design:** tool outputs are context injections; engineer them. Paginate, filter, and
truncate with sensible defaults (Claude Code caps tool responses at 25,000 tokens *[perishable snapshot, 2025–2026: model/vendor-specific — teach the mechanism, re-verify the number]*); prefer
semantically meaningful names over UUIDs; offer a `response_format: concise|detailed` knob;
consolidate chains of granular calls into one higher-level tool (`schedule_event`, not
`list_users` + `list_events` + `create_event`); use error messages to steer the agent toward
efficient strategies like "many small targeted searches" (Anthropic, *Writing effective tools
for agents*). CLI tools are often the most context-efficient integration surface of all
(Claude Code best practices).

**Masking over removal:** dynamically removing tools mid-session invalidates the KV cache and
confuses the model about past references; prefer masking token logits to constrain choice
while keeping definitions stable (Manus, ibid.).

### 3.9 Context budgets and caching discipline

**What:** Treat the window as a budgeted resource with an explicit spending plan: how much for
system + tools, how much reserved for the task, at what fill level compaction triggers. Claude
Code's docs are blunt: "The context window is the most important resource to manage," and its
UX (a /context inspector, status-line usage tracking, /clear, targeted /compact) is budget
tooling (Claude Code best practices). Chroma's practical corollary: set working budgets far
below the advertised window for high-accuracy work (Chroma, ibid.).

**Caching discipline (the mechanics behind P4):** structure prompts static-first (tools →
system → messages); place cache breakpoints on the last *stable* block, never on content that
changes per request; verify with cache-read/cache-write token counts rather than assuming.
A timestamp above the fold means you pay cache-write prices on every request forever
(Anthropic, prompt caching docs; Manus, ibid.).

**Few-shot rut:** uniform repeated action-observation patterns in context cause the model to
mimic rhythm over substance — "drift, overgeneralization, or sometimes hallucination." Inject
structured variation in serialization and phrasing (Manus, ibid.).

---

## 4. Failure modes

Breunig's four-way taxonomy (*How Long Contexts Fail*) is the field's shared vocabulary; know
these by name:

1. **Context poisoning** — "a hallucination or other error makes it into the context, where it
   is repeatedly referenced." The Gemini-plays-Pokémon agent poisoned its own goals section and
   pursued impossible objectives. Nastiest via summaries: one bad fact in a compaction poisons
   every future turn (OpenAI Cookbook, ibid.). *Mitigations:* validate before persisting, mark
   uncertain facts UNVERIFIED, keep summaries auditable, quarantine risky exploration in
   subagents.
2. **Context distraction** — the context grows so long "the model over-focuses on the context,
   neglecting what it learned during training." Symptom: repeating past actions instead of
   synthesizing new plans (Gemini beyond ~100K *[perishable snapshot, 2025–2026: model/vendor-specific — teach the mechanism, re-verify the number]*). *Mitigations:* budgets, compaction, recitation.
3. **Context confusion** — "superfluous content in the context is used by the model to generate
   a low-quality response." Prime driver: oversized tool loadouts. *Mitigations:* tool loadout
   selection, pruning, progressive disclosure.
4. **Context clash** — accumulated information and instructions that contradict each other.
   Microsoft/Salesforce measured a 39% average drop when prompts were sharded across turns; o3
   fell 98.1 → 64.1, because models "make assumptions in early turns... when LLMs take a wrong
   turn in a conversation, they get lost and do not recover." *Mitigations:* consolidate
   requirements before executing (spec first), clear-and-restart over correcting repeatedly.

Add the operational failures from production systems:

5. **Context rot at scale** — silent degradation well before the window is full (Chroma).
6. **Coordination failures** — duplicated work, gaps, 50 subagents on a trivial query,
   conflicting implicit decisions between parallel workers (Anthropic, *Multi-agent*;
   Cognition).
7. **Kitchen-sink sessions and correction spirals** — Claude Code's docs name the human-loop
   versions: unrelated tasks sharing one window; and repeated corrections polluting context
   with failed approaches — "after two failed corrections, /clear and write a better initial
   prompt incorporating what you learned." Also the over-specified always-loaded file:
   "Bloated CLAUDE.md files cause Claude to ignore your actual instructions" — for each line
   ask "Would removing this cause mistakes?"; if not, cut (Claude Code best practices).
8. **Lost-in-the-middle placement bugs** — the critical constraint buried at token 60,000 of
   120,000 (Liu et al.).

---

## 5. How the best teams operate

**They measure token-shaped things.** Anthropic found token usage alone explains 80% of
performance variance in their research eval (Anthropic, *Multi-agent*); Manus optimizes
KV-cache hit rate as the top-line production metric (Manus). Elite teams instrument context —
fill levels, cache hits, tokens per task — before theorizing.

**They iterate from observed failures, with the model in the loop.** Anthropic's tool and skill
guidance is evaluation-first: build representative tasks, watch real transcripts, let the model
critique its own failures, refine, re-run against held-out sets (Anthropic, *Writing effective
tools*; *Agent Skills*). Prompts start minimal and grow only where failures demand (P8). And
automated evals aren't sufficient: human testers caught Anthropic's agents "consistently
choosing SEO-optimized content farms over authoritative sources" — a context-quality failure no
programmatic eval flagged (Anthropic, *Multi-agent*).

**They keep the always-loaded core tiny and push everything else behind disclosure.** Concise
checked-in CLAUDE.md-class files for what applies every session; skills for everything
situational; pruning as routine maintenance ("treat CLAUDE.md like code") (Claude Code best
practices).

**They design the write path around verification and fresh contexts.** Explore → plan → 
implement → verify, with plan mode separating research from execution; a check the agent can
run (tests, build, screenshot diff) so the loop closes without a human; specs executed in fresh
sessions; adversarial review in a fresh subagent context (Claude Code best practices).

**They engineer for the cache and the filesystem.** Stable prefixes, append-only histories,
masked (not removed) tools, files as unlimited restorable memory, recitation for goal
stability, errors left visible (Manus). These are production-economics practices as much as
quality practices.

**They match architecture to task shape.** Anthropic's own selection heuristic: compaction for
long conversational flows; note-taking for iterative work with milestones (coding fits here);
multi-agent for parallel-explorable research (Anthropic, *Effective context engineering*).

---

## 6. Decision guide

| Situation | Reach for | Source |
|---|---|---|
| Recurring domain knowledge, sometimes needed | Skill w/ progressive disclosure | Anthropic Skills |
| Rules needed every session | Tiny curated always-loaded file; prune ruthlessly | Claude Code docs |
| Large explorable environment (repo, filesystem) | Just-in-time retrieval via tools; hybrid if latency-bound | Anthropic CE |
| Large unstructured corpus | Indexed retrieval (RAG) | Breunig |
| Long task nearing window limit | Compaction (recall-first, then precision); or clear stale tool results | Anthropic CE / context mgmt |
| Long task with milestones | Structured notes + todo recitation | Anthropic CE, Manus |
| Cross-session persistence | File-based memory outside the window | Anthropic context mgmt, Manus |
| Breadth-first research / investigation / review | Parallel subagents, condensed returns, explicit delegation contract + effort scaling | Anthropic multi-agent |
| Coherent build/edit on one artifact | Single agent, full traces, compressor for length — not parallel workers | Cognition |
| Many tools available | Loadout selection; consolidate; namespace; no overlap | Breunig, Anthropic tools |
| Cost/latency pressure | Stable prefix + append-only + cache breakpoints; mask don't remove | Manus, Anthropic caching |
| Agent repeating itself / drifting | Suspect distraction: check fill level, compact or clear, recite goals | Breunig, Manus |
| Agent confidently wrong about earlier "facts" | Suspect poisoning: audit summaries and notes, restart from clean spec | Breunig, OpenAI Cookbook |

---

## 7. Contested territory and thin spots (curator flags)

- **Multi-agent vs. single-agent is genuinely contested.** Anthropic's 90.2% win (read-heavy
  research) and Cognition's "don't build multi-agents" (write-heavy engineering) are both
  primary, both credible, and resolve on task shape: parallelize *reads*, serialize *writes*,
  and make every boundary-crossing an engineered contract. Present both; don't flatten this
  into one rule.
- **All numeric ceilings are perishable.** 32K/100K distraction ceilings, minimum-cacheable
  token counts, the 10x cache price ratio, 25K tool-response caps — model- and vendor-specific
  snapshots (2025–2026). Teach the mechanism, re-verify the numbers.
- **Second-hand figures.** The 44% tool-selection gain, 54% think-tool gain, 39% sharded-prompt
  drop, and Berkeley tool numbers arrive via Breunig's synthesis of third-party papers —
  directionally solid, not independently verified here.
- **OpenAI's public context-engineering corpus is thinner than Anthropic's.** Their best
  material is SDK cookbooks (trimming vs. summarization is genuinely good) and the general
  agents guide; most named-technique literature comes from Anthropic and practitioners.
- **Long-context vs. retrieval is unsettled.** Growing windows keep re-raising "just stuff it
  all in"; context rot is the standing rebuttal, but the equilibrium moves with every model
  generation.

---

## Sources

1. Anthropic — Effective context engineering for AI agents — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
2. Anthropic — How we built our multi-agent research system — https://www.anthropic.com/engineering/multi-agent-research-system
3. Anthropic — Equipping agents for the real world with Agent Skills — https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
4. Anthropic — Writing effective tools for agents — https://www.anthropic.com/engineering/writing-tools-for-agents
5. Anthropic/Claude — Managing context on the Claude Developer Platform (context editing, memory tool) — https://claude.com/blog/context-management
6. Anthropic — Claude Code best practices — https://code.claude.com/docs/en/best-practices
7. Anthropic — Prompt caching documentation — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
8. Chroma — Context Rot: How Increasing Input Tokens Impacts LLM Performance — https://www.trychroma.com/research/context-rot
9. Drew Breunig — How Long Contexts Fail — https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html
10. Drew Breunig — How to Fix Your Context — https://www.dbreunig.com/2025/06/26/how-to-fix-your-context.html
11. Cognition — Don't Build Multi-Agents — https://cognition.com/blog/dont-build-multi-agents
12. Manus (Yichao "Peak" Ji) — Context Engineering for AI Agents: Lessons from Building Manus — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
13. LangChain — Context Engineering for Agents — https://www.langchain.com/blog/context-engineering-for-agents
14. Philipp Schmid — The New Skill in AI is Context Engineering — https://www.philschmid.de/context-engineering
15. HumanLayer (Dex Horthy) — 12-Factor Agents — https://github.com/humanlayer/12-factor-agents
16. Liu et al. — Lost in the Middle: How Language Models Use Long Contexts — https://arxiv.org/abs/2307.03172
17. OpenAI — A practical guide to building agents — https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
18. OpenAI Cookbook — Context engineering: short-term memory management with Sessions — https://developers.openai.com/cookbook/examples/agents_sdk/session_memory
