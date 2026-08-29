---
name: applying-a-permission-policy
description: "Use when a permission policy is attached to a rig/seat (rig.yaml permission_policy:), or a user asks you to apply one, and you must translate that harness-neutral policy into the target harness's LIVE permission config — Claude settings.json / Codex config.toml / Pi run flags. Agent-driven and interactive: you read the policy, ground yourself in YOUR harness version, show the diff, and ask before writing. NOT for defining policies (that's the policy spec) and NOT a set-and-forget updater."
metadata:
  openrig:
    stage: established             # config cells VM-verified + cold-transfer PASSING (rerun #2) + built-in SPEC FILES landed → skill translates FROM the spec (POINT-not-COPY). The two established criteria met 2026-08-04. Reviewed at push.
    tested_against:                # VERSION STAMP — the whole point; re-verify at every harness bump
      claude_code: "2.1.220 — VM-CONFIRMED 2026-08-03 (all cells)"
      codex: "0.120.0 — VM-CONFIRMED 2026-08-03 (sandbox_mode/approval_policy; on-failure deprecated-but-accepted)"
      pi: "0.83.0 — VM-CONFIRMED 2026-08-03: --approve/--no-approve govern PROJECT-RESOURCE TRUST, NOT tool permissions; Pi has NO permission surface (see Pi leg)"
    verification_status: "Live-verified 2026-08-03/04. Claude 2.1.220 + Codex 0.120.0 config cells CONFIRMED live. Pi 0.83.0 divergence folded (flags = project-resource trust, not a permission gate). Cold-transfer rerun #1 blocked on the force_push/push_to_remote prefix collision → added the PREFIX-COLLISION rule. Cold-transfer rerun #2: TRANSFERS — all 5 gate checks pass (collision resolved deterministically without asking; single ordinary write confirmation; defaultMode floor written; Codex workspace-write/on-request; Pi compute-nothing). Blocking collision/floor defect CLOSED → gate cleared, 4.8-shippable (provisional-with-passing-cold-transfer). Non-blocking seam closed: the built-in SPEC FILES landed (arch-accepted, source:builtin) → skill translates FROM the spec, interim in-skill pinned summary retired (POINT-not-COPY). stage:ESTABLISHED 2026-08-04 — both criteria met."
---

# Applying a permission policy

## Translation is best-effort — read this first
This skill provides the policy schema and OpenRig's best current understanding of how to translate it to each harness. That guidance is **best-effort and version-stamped**: harness permission surfaces change frequently across versions, so a mapping that is correct today can drift on a later release. When you apply a config-surface policy:
- **Verify against the current docs for your installed harness version.** Treat this skill's tables as version-stamped starting points (see `tested_against`), not settled truth.
- **Prefer testing in a protected or disposable environment first.** An incorrect write can lock a seat out or over-permit it, so confirm the format before applying it to a live seat.
- **Hand-editing via the harness's own settings tools is always a valid path.** If a translation is uncertain, setting the policy directly — or asking the user to — is a legitimate outcome, not a failure.

The reliable, deterministic parts are the **blunt instruments**: the YOLO full-bypass flag and the floor (Claude `acceptEdits` / Codex `workspace-write`), which ride the stable launch-flag surface. **Fine-grained config-rule translation — the allow/ask/deny prefix rules and the Codex posture — is the best-effort part** and carries no guarantee of exact fidelity. If a translation looks wrong, fall back to a blunt instrument or a direct hand-edit.

## ⚠ Read this preamble first — why this is a SKILL, not a script (do not "improve" it into a deterministic updater)
Harness permission formats are a **moving target**. The exact fact this skill is stamped against — Claude Code 2.1.220 permission rules are **prefix-only** (no flag-precise Bash match) — is *version-specific*; the rule grammar can change on the next point release. A hardcoded/deterministic updater would foot-gun the instant it does, and a wrong permission write can **lock a seat out or silently over-permit it**. So the maintained artifact is this caveated, version-stamped skill that an agent reads and applies **interactively, grounding in the live format** — never a code path that writes blindly. If you are tempted to replace this with a deterministic projector: that temptation is the bug this preamble exists to stop.

## When to reach for this
- A rig/seat has a policy attached (`rig.yaml … permission_policy: <file>`), and you're at **setup/preflight** — apply it (**mandatory for autonomous seats**, see the freeze warning).
- A user asks "apply the Standard/Open/Locked/Operator policy here" or "set up permissions like <host>".
- NOT for authoring policies (that's the policy spec) and NOT for daemon-level enforcement (OpenRig is agnostic — it injects nothing).

## What you're translating (the boundary)
INPUT = a **harness-neutral policy spec** (arch's schema): `default_posture`, `floor`, `allow`/`ask`/`deny` as **semantic actions** (`push_to_remote`, `delete_files`, …), `destructive_class`, `source: builtin|custom`. You TRANSLATE that intent → the harness's live config. You never invent policy; you never pre-bake harness config into the spec.

## The apply flow (interactive — the interactive-ask IS the product)
1. **Read the policy spec** + its `source:` marker (built-in read-only from the package = copy-to-customize before editing; custom = user space).
2. **PREFLIGHT (mandatory) — ground yourself in THIS environment:**
   - **daemon-HOME must equal seat-HOME**, or a user-level Claude write never reaches the seat (assessment iv). Check; if they differ, **stop and ask** — do not write into the wrong HOME.
   - Read the harness's **actual current config file** + confirm its schema against your installed version (`claude --version`, the live settings.json shape, codex/pi versions). If the format differs from this skill's `tested_against`, trust the LIVE format and flag the drift.
3. **Derive the per-harness config** from the semantic actions (see the three legs below). Compute the Codex posture-collapse + Pi bit.
4. **Show the concrete DIFF before writing** (old → new, per file). Never a blind write.
5. **Resolve best-effort actions by the built-in's rule FIRST, then ask only on genuine ambiguity.** Best-effort destructive actions (`force_push`, `delete_files`, `delete_everything`, `read_secrets`) default to **`ask`** (never a `deny` that can't be enforced) — apply that default rather than stopping to question-back. Surface a question only when the policy is genuinely ambiguous or the seat is interactive. **For a same-prefix collision (`push_to_remote` vs `force_push`, both `Bash(git push:*)`), NEVER ask — apply the deterministic PREFIX-COLLISION rule in the Claude leg.** (Live cold-transfers caught fresh agents *question-backing* — first on the `force_push` default, then on the prefix collision — instead of applying the fixed rule; both freeze an autonomous seat.) On a Claude-only fleet, if the policy denies `network_egress`, **say so explicitly**: it is NOT enforceable — Claude has no network gate, a `Bash(curl:*)`/`Bash(wget:*)` deny is best-effort, and `python`/`node` fetch bypasses it (live-verified: `urllib` reached HTTPS 200 under a curl/wget deny). Route real egress-gating to the Codex sandbox, or record it as advisory on Claude.
6. **Back up the current config**, then write. Prefer the **user-level** file (`~/.claude/settings.json`) for durable policy — it's the clobber-resistant tier (deny wins across the union). **ALWAYS include `defaultMode: "acceptEdits"` in the Claude settings.json you write** — the floor key must be PRESENT in the file, or the config policy strips the floor. (This is the exact gap a live cold-transfer test FAILED on: the fresh agent wrote allow/deny lists but omitted `defaultMode`, leaving the seat below the floor.)
7. **Verify** the write landed and the seat can see it (re-read; confirm `defaultMode: "acceptEdits"` is present; for an autonomous seat, confirm no `ask` will freeze it).

## Two surfaces — and this skill writes only ONE of them
Permissions live on two surfaces with opposite stability — which is the whole reason for the agent-driven split:
- **LAUNCH-FLAG surface — STABLE (>1yr) → OpenRig sets it DETERMINISTICALLY, NOT this skill.** The flags OpenRig passes at boot: Claude `--permission-mode` / `--dangerously-skip-permissions`; Codex sandbox/bypass flags; Pi `--approve`/`--no-approve`. **Two things live here, both OpenRig-owned: the FLOOR (minimum, by default) and YOLO (full bypass, opt-in).**
- **CONFIG-FILE surface — CHAOTIC → NEVER deterministic → THIS SKILL'S DOMAIN.** Claude `settings.json` allow/ask/deny + defaultMode; Codex `config.toml` approval rules. This is where the Locked / Standard / Open policies get applied — agent-driven, version-stamped, caveated. (Pi has **no permission surface at all** — its `--approve`/`--no-approve` flags govern project-resource trust, not tool permissions (VM-confirmed Pi 0.83.0); a permission policy does not translate to Pi. See the Pi leg.)

**THE FLOOR (launch-flag, OpenRig-set — this skill KNOWS it, never WRITES it):** Claude `--permission-mode acceptEdits` (keep it); **Codex workspace-only** (stop forcing `danger-full-access` — ≈ Codex's own default ≈ setting-nothing = agnostic); Pi `--no-approve` (a project-resource-trust floor — Pi has no permission gate; see the Pi leg). **One consistent unconditional minimum** (no by-context switching — that mode idea is parked 5.0). A chosen config-file policy layers ON TOP of the floor.

**YOLO MODE (launch-flag, OpenRig-set, opt-in — for people done with permissions):** OpenRig boots every seat with the full-bypass flag (Claude `--dangerously-skip-permissions`; Codex full-bypass). **When YOLO is on, CONFIG-FILE POLICY IS MOOT** — this skill does NOT apply a config policy (or explicitly notes it's overridden by the flag); don't fight the bypass. YOLO is OpenRig's deterministic job, not this skill's. (**Operator = YOLO mode** — subsumed.)

## The three harness legs (skill-owned mapping knowledge, version-stamped + caveated)

### Claude — `~/.claude/settings.json` (user-level, clobber-resistant)
- **Action → prefix map** (VM-CONFIRMED @ Claude 2.1.220, 2026-08-03 — every row exercised through real Claude tool calls). `fidelity`: `clean` = the prefix honors intent; `best_effort` = prefix-only can't fully enforce → prefer `ask`, never a `deny` that lies.

  | Semantic action | `permissions.*` prefix rule(s) | fidelity |
  |---|---|---|
  | push_to_remote | `Bash(git push:*)` | clean |
  | force_push | ask the flag-first forms `Bash(git push --force:*)` `Bash(git push -f:*)` `Bash(git push --force-with-lease:*)`; base `Bash(git push:*)` follows push_to_remote (see the collision rule) | **best_effort** — catches flag-FIRST force; flag-LAST (`git push origin main --force`) leaks |
  | create_pr | `Bash(gh pr create:*)` | clean |
  | publish_package | `Bash(npm publish:*)` `Bash(pnpm publish:*)` `Bash(yarn publish:*)` `Bash(cargo publish:*)` | clean (multi-pattern) |
  | merge_or_release | `Bash(git merge:*)` `Bash(git tag:*)` `Bash(gh release:*)` | best_effort — protected-branch semantics not expressible |
  | delete_files | `Bash(rm:*)` | **best_effort** — target-first leak (`rm <t> -rf` slips); scope not boundable → default `ask` |
  | delete_everything | `Bash(rm -rf:*)` `Bash(rm -fr:*)` | **best_effort** — same leak → default to `ask`, never a silent deny |
  | reset_or_discard_vcs | `Bash(git reset:*)` `Bash(git clean:*)` `Bash(git checkout:*)` `Bash(git branch -D:*)` | best_effort |
  | drop_persistent_store | `Bash(dropdb:*)` `Bash(docker volume rm:*)` (+ project-specific) | best_effort (open-ended) → `ask` |
  | rig_up / rig_down | `Bash(rig up:*)` / `Bash(rig down:*)` | clean — ⚠ an `ask` here FREEZES an autonomous seat |
  | mutate_topology | `Bash(rig add:*)` `Bash(rig remove:*)` `Bash(rig rename:*)` | clean |
  | run_toolchain | `Bash(npm:*)` `Bash(npx:*)` `Bash(pnpm:*)` `Bash(yarn:*)` `Bash(node:*)` `Bash(tsc:*)` `Bash(vitest:*)` `Bash(jest:*)` | clean (the known set) |
  | run_arbitrary_shell | `Bash(*)` — this IS the `default_posture` knob | clean |
  | network_egress | `Bash(curl:*)` `Bash(wget:*)` (partial) | **best_effort** — Claude has NO native network gate; real floor = Codex sandbox (route it there) |
  | read_secrets | `Read(./.env)` `Read(~/.ssh/**)` `Read(**/*secret*)` (path-scoped) | **best_effort** — path-based, not secret-aware |
  | install_dependencies | `Bash(npm install:*)` `Bash(pip install:*)` `Bash(brew install:*)` | clean |
- **PREFIX-ONLY caveat** — cannot flag-precisely gate (`force_push` vs `push_to_remote` both match `Bash(git push:*)`); **target-first leak** (`rm <target> -rf` slips a `Bash(rm -rf*)` deny). Actions marked `best_effort` in the taxonomy (`force_push`, `delete_files`, `read_secrets`) → surface the caveat and prefer `ask` over a `deny` you can't enforce (a `deny` that leaks lies).
- **PREFIX-COLLISION resolution (deterministic — resolve it, NEVER ask).** When two actions collapse to the SAME base prefix with different dispositions — the canonical case is `push_to_remote`=allow + `force_push`=ask, both basing to `Bash(git push:*)` — you cannot put that base prefix in both `allow` and `ask`. Resolve without a question-back:
  - **Push allowed + force asked (Standard / Open):** put the base `Bash(git push:*)` per push's disposition (`allow`), AND add the flag-first force forms to `ask` (`Bash(git push --force:*)`, `Bash(git push -f:*)`, `Bash(git push --force-with-lease:*)`). RECORD in your diff that this is best-effort — flag-LAST force (`git push origin main --force`) leaks past the flag-first ask rules and runs under the allow. Don't block on it.
  - **Push denied (Locked):** `Bash(git push:*)` in `deny` already covers force — no conflict.
  This is a FIXED rule, not a user decision — apply it and note the leak. (A live cold-transfer FAILED because a fresh agent *blocked asking* "how to resolve the force_push/push_to_remote collision" instead of applying this default.)
- **`defaultMode: "acceptEdits"` is the FLOOR and MUST be written into every Claude settings.json you produce.** It is not a knob you tune, but it IS a key you must always include — a config policy that omits it strips the floor (the cold-transfer failure). Live-confirmed schema: `{"permissions":{"allow":[],"ask":[],"deny":[],"defaultMode":"acceptEdits"}}`.

### Codex — `~/.codex/config.toml` (via the existing X10 `codex_config_fragment` splice path — reuse, don't invent)
- Codex is **per-posture, not per-action**: the whole action set **collapses** to the nearest `{sandbox_mode, approval_policy}` pair. **Built-in → posture** (VM-CONFIRMED @ Codex 0.120.0, 2026-08-03 — each posture applied to a real seat: read-only blocked writes+egress, workspace-write allowed writes/blocked egress, danger-full-access allowed both):

  | Built-in | `sandbox_mode` | `approval_policy` | Collapse note (surface this to the user) |
  |---|---|---|---|
  | Locked | `read-only` | `on-request` | read-only blocks all writes + egress, prompts on escalation — OVER-restricts `edit_files` vs the Claude floor |
  | Standard ⭐ | `workspace-write` | `on-request` | workspace writes allowed, egress blocked by sandbox, prompt on escalation — UNDER-gates `create_pr` (no per-action ask; folds into the prompt) |
  | Open | `danger-full-access` | `on-failure` | everything allowed, prompt only on failure — OVER-permits the `destructive_class` vs the Claude ask-gates |
  | YOLO | *(flag-surface — full-bypass launch flag, NOT config.toml)* | — | not a config write; the rip-out adapter owns it |

  Valid values (VM-confirmed @ Codex 0.120.0): `sandbox_mode` ∈ {read-only, workspace-write, danger-full-access}; `approval_policy` ∈ {on-request, on-failure, never, untrusted, granular} (`granular` observed live at 0.120.0). ⚠ `on-failure` (used by Open) is marked **deprecated** in 0.120.0 help but still accepted — revisit if a future Codex drops it.
- Surface the collapse: "Codex can't gate per-action; this policy becomes sandbox=X approval=Y, which over-permits Z / under-permits W."

### Pi — NO permission surface at all (VM-confirmed Pi 0.83.0 — the earlier "approval bit" reading was WRONG)
- **Pi has no tool-permission gate — neither a config store NOR a permission-posture flag.** Live verification confirmed: Pi 0.83.0's `--approve`/`-a` and `--no-approve`/`-na` govern **project-resource trust** (whether project extensions/resources appear in RPC `get_commands`), **NOT** tool-call approval. There is no sandbox or permission mechanism to map a policy onto.
- So a permission policy **does not translate to Pi**. Do NOT say `--approve` = "auto-approve all", or that a posture "collapses to a Pi approval bit" — that was an earlier misread, corrected here. This skill computes **nothing** for Pi.
- Whatever the OpenRig adapter sets (`--no-approve` by default) is a project-resource-trust floor, not a permission posture — not this skill's to derive.
- Behavior to know (resource-trust, NOT permission-gating): under default ask / `--no-approve`, a project resource is silently **absent** from RPC `get_commands`; it appears under `--approve`. Never mistake that for permission enforcement.
- **Say this to the user for a Pi seat:** "Pi has no permission-policy surface today — the policy applies to Claude/Codex; Pi runs under its project-resource-trust flag unchanged."

## ⚠ The two warnings that save real fleets
- **`ask` FREEZES an autonomous/headless Claude seat** — it hangs on the first non-edit op. So for autonomous fleets apply **Open/YOLO** (or a policy with no asks) **at setup** — the floor only covers edits; bash still asks without an applied policy. Never leave an autonomous seat on a policy with live `ask` gates. (Pi has no permission ask at all — see the Pi leg; Codex prompts per its posture, not per-action.)
- **daemon-HOME ≠ seat-HOME** silently voids user-level writes — always the preflight check above.

## The built-ins — DEFINED by the shipped policy spec files (translate FROM the spec; POINT, don't COPY)
The four built-in policies ship as read-only spec files (`source: builtin`, `policy_schema_version: 1`) — they are the AUTHORITATIVE definitions. **Do NOT restate their action-sets here.** An earlier in-skill copy drifted (it under-asked `publish_package`/`merge_or_release`, which the spec ASKs) — the exact reason POINT-don't-COPY is the rule. Read the attached/selected spec and translate its semantic-action sets (`default_posture` / `allow` / `ask` / `deny` / `destructive_class`) per the three legs above.
- **Locked / Standard ⭐ / Open** — `surface: config`. Translate to the Claude / Codex config surface. **Standard ⭐** is the recommended default: routine dev incl. push allowed, the outward/release/history-rewriting acts (`create_pr`, `publish_package`, `merge_or_release`, `force_push`) ASK, destructive_class ASKs. Standard has live `ask` gates → not for a headless-autonomous Claude seat (use Open or YOLO). Locked = deny-default whitelist; Open = allow-default, destructive_class asks only.
- **YOLO** — `surface: flag`, `launch_posture: full_bypass`. This skill does **NOT** translate it — it points at OpenRig's deterministic flag-surface opt-in (the rip-out YOLO setting). When YOLO is on, any config-surface policy is MOOT (the bypass overrides it). (Subsumes the former "Operator".)

Built-ins ship read-only in the package (canonical names); copy-to-customize into user space (custom, user-named); the `source:` frontmatter marker travels on copy. Onboarding presents these as a required MENU (explain each + ask which; no-choice = the floor).

## Boundary (keeps this the only maintained piece)
This skill TRANSLATES + APPLIES only. It does **not** define policies (the policy spec does) and does **not** enforce at the daemon (OpenRig is agnostic). Spec = *what* (neutral intent); this skill = *how, on this harness version* (the caveated, version-stamped translation).

---
*Stage: ESTABLISHED (2026-08-04) — both criteria met: (1) cold-transfer PASSING (rerun #2, all 5 gate checks TRANSFER); (2) the built-in policy SPEC FILES landed (`source: builtin`, arch-accepted) as the authoritative source — the skill now translates FROM the spec and the interim in-skill pinned summary is retired (POINT-not-COPY). Config cells VM-CONFIRMED (Claude 2.1.220 / Codex 0.120.0); Pi has no permission surface (compute-nothing). Reviewed at push. feedback.md maintained.*
