#!/usr/bin/env python3
"""compose.py — leaf-to-root chain composition and subtree renders.

  up   <start-dir> --name FILE [--name FILE ...] [--root DIR]
       Walk from start-dir up to root (default: filesystem stops at a dir
       containing .compose-root, or at --root). Emit the chain ROOT-FIRST
       (defaults, then overrides) with provenance headers, and a MISSING-LINK
       report for altitudes without the file — the scream is output, not error.

  down <root-dir> --name FILE [--name FILE ...] [--exclude GLOB ...]
       Gather every instance of the named files under root-dir.

  progress <root-dir> --name FILE [--name FILE ...] [--exclude GLOB ...]
       THE DERIVED PROGRESS VIEW (the PROGRESS.md prototype done right):
       count markdown checkboxes in the named files (the mark level), roll
       counts UP the tree, and print a walk-map-shaped tree with done/total
       per level. Never stored in any file — the render is the only home.
       Gather every instance of the named files under root-dir (the subtree
       render; run at the topology root = THE TRUNK RENDER). Sorted by path.

Composed output is GENERATED, NEVER EDITED (fragments are the source of truth).
Seals/locks bind to a render's bytes, not to fragments. Stdlib only.
"""
import argparse, os, sys, fnmatch, datetime, re, shutil, subprocess

# A SHELF holds instances of an altitude; it is not a position and carries no chain file.
# Both trees have them: missions/ slices/ (work) and rigs/ pods/ seats/ (topology). Without
# this list the trace reports every shelf as a gap and the audit tells you to scaffold one —
# which is litter that inflates the map to a clean-looking 5/5 while adding nothing. Extend
# with --shelf for a tree that names them differently.
SHELF_NAMES = {"missions", "slices", "seats", "pods", "rigs"}

_TPL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates")
def _template_bytes(name):
    try:
        return open(os.path.join(_TPL_DIR, name), "rb").read()
    except OSError:
        return None

def read_state(path):
    """Detection is DETERMINISTIC-FIRST, declared-second — never memory-reliant:
    1. byte-identical to the shipped template  -> 'unseeded' (nobody had to remember anything)
    2. `status: UNSEEDED` marker on content that DIFFERS from the template -> 'conflicted':
       render the content AND scream — real work is never hidden behind a stale field,
       and the disagreement is its own reported state (third-state law).
    3. otherwise -> 'seeded'. Every residual failure mode shows too much plus a scream,
       never hides work and never silently trusts a field."""
    raw = open(path, "rb").read()
    tpl = _template_bytes(os.path.basename(path))
    body = raw.decode("utf-8", errors="replace")
    head = "\n".join(body.splitlines()[:15])
    marked = re.search(r"^status:\s*UNSEEDED", head, re.M)
    if tpl is not None and raw == tpl:
        m = re.search(r"^owners?:\s*(.+)$", head, re.M)
        return "unseeded", (m.group(1).strip() if m else "owner unknown — untouched scaffold")
    if marked:
        return "conflicted", body
    return "seeded", body

def hdr(title):
    return f"\n\n<!-- ═══ {title} ═══ -->\n\n## ⟦{title}⟧\n"

def frontmatter(payload):
    """Parse the frontmatter block ONCE. Returns (dict, note); note is set when there is
    nothing to read, so a caller can report the gap rather than silently skip it."""
    if not payload:
        return None, "no content"
    m = re.match(r"^---\n(.*?)\n---\n", payload, re.S)
    if not m:
        return None, "no frontmatter"
    try:
        import yaml
        return (yaml.safe_load(m.group(1)) or {}), None
    except Exception as e:
        return None, f"frontmatter did not parse ({e.__class__.__name__})"

def field_of(payload, field):
    """Extract ONE frontmatter field. Returns (value, note).
    A chain walked by FIELD composes intent without dragging bodies: three sentences
    unfurl, not three documents. A level whose file exists but lacks the field is a
    real gap and is reported as such — never silently skipped."""
    fm, note = frontmatter(payload)
    if fm is None:
        return None, note
    if field not in fm:
        return None, f"no `{field}:` field"
    v = fm[field]
    return (" ".join(str(v).split()) if v is not None else None), None

def _cut_at_boundary(s, n):
    """Cut to AT MOST n chars, NEVER inside a token.

    Measured 2026-08-14: a cold subject read `see PROOF.m…` and `see P…` in the walk's own
    output. A path cut mid-token still READS as a path — the reader cannot tell `PROOF.m` from
    a file that is actually called that, so a truncation artifact is silently promoted to a
    fact about the tree. Filenames, paths and identifiers are exactly the tokens a reader is
    most likely to act on, which makes them the worst place to lose characters.

    So the cut lands on whitespace or it does not land: paragraph, then line, then word. A
    single unbroken token longer than the budget is DROPPED WHOLE rather than shortened —
    half an identifier is worse than no identifier."""
    if len(s) <= n:
        return s
    head = s[:n]
    if s[n:n + 1].isspace():                 # n already sits on a boundary
        return head.rstrip()
    for sep, floor in (("\n\n", n // 2), ("\n", n // 2), (" ", 0)):
        i = head.rfind(sep)
        if i > floor:
            return head[:i].rstrip()
    return ""                                # one unbroken token — drop it, never cut into it


def _short(s, n=52):
    s = " ".join(str(s).split())
    if len(s) <= n:
        return s
    return _cut_at_boundary(s, n - 1).rstrip(" ,;:.-—") + "…"

_ARTIFACT_KEYS = ("outputs", "output", "artifacts", "artifact")


def dep_artifacts(dep_dir, names, dep_fm):
    """WHAT THE DEPENDENCY HANDS YOU — the file, not the fact that it is done.

    Frontmatter first if the node declares it (`outputs:`/`output:`/`artifacts:`/`artifact:`),
    because a declaration outranks a guess. Otherwise the directory itself: everything beside
    the node file, which for a built slice IS its output (MAP.md, PROOF.md, the script). No
    prose parsing — a `## Output` section is written for humans and reading it would make the
    trace confidently wrong exactly where it is trying to stop being that."""
    for k in _ARTIFACT_KEYS:
        v = (dep_fm or {}).get(k)
        if v:
            return [" ".join(str(x).split()) for x in (v if isinstance(v, list) else [v])], "declared"
    try:
        entries = sorted(os.listdir(dep_dir))
    except OSError:
        return [], "unreadable"
    out = [e + ("/" if os.path.isdir(os.path.join(dep_dir, e)) else "")
           for e in entries if not e.startswith(".") and e not in set(names)]
    return out, "on disk"


def blocking_state(payload, lvl, names):
    """THE LEAF'S NEXT-ACTION FACTS, composed BESIDE its intent. Returns a line or None.

    Measured 2026-08-14: a cold seat walked `--field intent`, reconstructed the mission's
    thesis from ~90 words, and finished green and ready to start work its own slice says is
    blocked — because the walk opened the file holding `status: not-started`, extracted
    exactly one key, and threw the rest away. It answers *what is this for* completely and
    *what should I do now* not at all, and ships as though the first answered the second.

    So the blocking facts ride along: `status`, and `depends:` — a sibling slice id (or a
    list of them) RESOLVED ON DISK so the dependency's current state is reported rather than
    remembered. Leaf only — the ancestors say what the work is for, and only the leaf says
    whether to start it.

    Measured 2026-08-14: a cold subject working slice 13 needed slice 11's OUTPUT. The walk
    gave it 11's STATE and nothing else; the subject called the missing location "the single
    largest unknown in my Phase 1 answer and it was the load-bearing input", and resolved it
    with `ls` a phase later. A status answers *may I start*; it does not answer *where is the
    thing I start from*. So each dependency now renders its ABSOLUTE PATH and its output
    ARTIFACTS beside its state — and an id that resolves to nothing renders UNRESOLVED, said
    out loud, because an unresolvable dependency dropped in silence is the same false
    confidence in a smaller box."""
    fm, _ = frontmatter(payload)
    if not fm:
        return None
    parts = []
    if fm.get("status") is not None:
        parts.append(f"status: {_short(fm['status'], 88)}")
    deps = fm.get("depends")
    if deps:
        shelf = os.path.dirname(lvl)
        lines = ["depends:"]
        for dep in (deps if isinstance(deps, list) else [deps]):
            dep = " ".join(str(dep).split())
            dep_dir = os.path.join(shelf, dep)
            if not os.path.isdir(dep_dir):
                lines.append(f"    {dep} — ⚠ UNRESOLVED: no directory `{dep}` under {shelf}"
                             f" (nothing to point you at — check the id)")
                continue
            state, dfm = None, None
            for n in names:
                cand = os.path.join(dep_dir, n)
                if os.path.isfile(cand):
                    st, body = read_state(cand)
                    dfm = frontmatter(body)[0] if st != "unseeded" else None
                    state = _short((dfm or {}).get("status") or st)
                    break
            lines.append(f"    {dep} ({state})" if state else
                         f"    {dep} (⚠ no {'/'.join(names)} — state unknown)")
            lines.append(f"      path: {os.path.abspath(dep_dir)}")
            arts, how = dep_artifacts(dep_dir, names, dfm)
            if arts:
                shown = arts[:8]
                more = f" (+{len(arts) - 8} more)" if len(arts) > 8 else ""
                lines.append(f"      artifacts ({how}): " + " · ".join(shown) + more)
            else:
                lines.append(f"      artifacts: ⚠ none found — the dependency has produced no"
                             f" output file yet")
        parts.append("\n".join(lines))   # lines 2+ carry their own indent; the caller indents line 1
    return "\n  ".join(parts) or None


def operates_on(payload):
    """The roots this WORK touches — which are NOT the root the trace ascended.

    Measured 2026-08-14, 4 cold subjects out of 4: the walk orients to PURPOSE excellently
    and misleads on LOCATION every time. Naming the walked root did not help, because the
    failure is not "which tree am I looking at" — it is "which tree does this work act on."
    A slice about the skill library renders inside a map rooted at the workspace, and the
    reader plans into the tree it was shown. One subject planned to CREATE a second corpus,
    duplicating the very thing whose duplication was that slice's subject.

    The walk cannot infer this: a work node is not bound to a root. So the node DECLARES it
    and the leaf renders it verbatim. Mechanical, like `depends:`, and absent when unstated
    rather than guessed."""
    fm, _ = frontmatter(payload)
    if not fm:
        return None
    roots = fm.get("operates_on")
    if not roots:
        return None
    return [" ".join(str(r).split()) for r in (roots if isinstance(roots, list) else [roots])]


# WHAT SURVIVES TRUNCATION. Both lists are read off the 15 real SPEC.md files of
# context-engineering-v2 — every pattern below matches a heading that actually exists there;
# no category is invented for symmetry. CONTRACT is the completion-and-scope family (`Done
# when`, `What done looks like`, `Scope fences`, `Output`, `Inputs`, `Depends on`, `What must
# be built`, `How we will know it works`, `PAYLOAD`). DISCUSSION is the rationale-and-history
# family (`Why …`, `The problem …`, `The evidence …`, `The finding …`, `RESULT …`, `Also
# found`, `Triage`, `What is already done`, `New evidence`, `Where this spec was wrong`) —
# valuable, and the first thing a reader can go get from the file itself.
# Anything unmatched sits in the MIDDLE on purpose: an unfamiliar heading is neither
# privileged nor sacrificed, so a new section shape degrades gracefully instead of silently
# becoming the first casualty.
_PRI_CONTRACT = re.compile(
    r"(done when|what done looks like|scope fence|outputs?\b|inputs?\b|depends on|"
    r"what must be built|how we will know|acceptance|payload|deliverable)", re.I)
_PRI_DISCUSSION = re.compile(
    r"^(why\b|the problem|the evidence|the finding|result\b|also\b|related\b|triage\b|"
    r"background\b|history\b|what is already done|new evidence|measured\b|answered\b|"
    r"where this spec was wrong|notes for|the counter-argument|the asset|the mechanism|"
    r"this mission is the acceptance criteria)", re.I)


def _priority(heading):
    """0 = preamble (never dropped) · 1 = contract · 2 = unclassified · 3 = discussion."""
    if heading is None:
        return 0
    if _PRI_CONTRACT.search(heading):
        return 1
    if _PRI_DISCUSSION.match(heading):
        return 3
    return 2


def _sections(body):
    """Split a node body at LEVEL-2 headings into [(heading|None, chunk), ...].

    Chunk 0 is the preamble — the `# Title` and its lede — and carries heading None. `###`
    stays inside its parent section: in these specs it is a sub-step of the section above it,
    and splitting there would let half a section survive its own heading."""
    starts = [m.start() for m in re.finditer(r"^## +.*$", body, re.M)]
    if not starts:
        return [(None, body)]
    out = [(None, body[:starts[0]])]
    for i, s in enumerate(starts):
        chunk = body[s:starts[i + 1] if i + 1 < len(starts) else len(body)]
        out.append((chunk.splitlines()[0].lstrip("# ").strip(), chunk))
    return out


def leaf_body(payload, cap):
    """Ancestors compose by FIELD; the leaf composes by BODY.

    Measured 2026-08-14 (slice 01 A/B): a cold agent given three intent sentences
    reconstructed the mission's thesis correctly, then assumed the work tree it had been
    shown was the tree its slice was about. The slice was about the TOPOLOGY tree. It built
    a coherent four-step plan aimed at the wrong one — and the three altitudes it planned
    over need three different verbs, which it had no way to know.

    That is misdirection, not a gap. Ancestors compress beautifully because they are stable
    and abstract. **The leaf is where the nouns live, and a field-only walk throws them
    away** — every word that would have disambiguated it sat in the body that was not shown.

    Truncation is BY PRIORITY, never by position. Measured 2026-08-14: positional cutting on
    slice 13 dropped `Output`, `Done when` and `Scope fences` — the three sections that say
    what to produce, when it is finished and what it may not touch — and kept four screens of
    rationale, because the rationale happened to be written first. The subject rated its own
    grasp of purpose 85% and its next action 70% and named that omission as the reason. A
    render that keeps the argument and drops the contract has the priorities backwards."""
    if not payload:
        return None
    m = re.match(r"^---\n.*?\n---\n", payload, re.S)
    body = (payload[m.end():] if m else payload).strip()
    if not body:
        return None
    if len(body) <= cap:
        return body
    secs = _sections(body)
    if len(secs) == 1:                     # headingless prose — nothing to prioritise
        kept = _cut_at_boundary(body, cap)
        return (kept + "\n\n[… " + str(len(body) - len(kept)) + " more chars, no further "
                "headings — prose tail]" + "\n(read the node file for these)")
    # Drop LOWEST priority first and, within a tier, the LARGEST section first. Size beats
    # position here and it was measured: slice 13's contract sections total more than any
    # sane cap, and dropping the tier tail-first killed `Done when` (12 lines) and `Scope
    # fences` (9) to save `Output` and `Inputs` (~2k chars each) — the two long prose
    # sections eating the two short decisive ones. Largest-first keeps the most sections
    # standing, and in these specs the short section is the one carrying the ruling. The
    # preamble (title + lede, index 0) is never a candidate: it is what names the thing.
    keep, size = set(range(len(secs))), len(body)
    for i in sorted(range(1, len(secs)), key=lambda i: (-_priority(secs[i][0]), -len(secs[i][1]))):
        if size <= cap:
            break
        keep.discard(i)
        size -= len(secs[i][1])
    kept = "".join(secs[i][1] for i in sorted(keep)).rstrip()
    if len(kept) > cap:                    # preamble alone overflows; cut it safely, never mid-token
        kept = _cut_at_boundary(kept, cap)
    dropped = [secs[i][0] for i in range(1, len(secs)) if i not in keep]
    # NAME what was cut. A byte count reads as trivia; two subjects in a row lost the
    # acceptance criteria to it and neither could tell, because a truncated head can end on
    # a clean rhetorical close and look like a finished document. Listing the dropped
    # headings turns invisible truncation into a decision the reader can actually make —
    # one subject lowered its own confidence honestly on the strength of this line alone.
    tail = ("\n\nOMITTED FROM THIS RENDER — " + str(len(body) - len(kept)) + " chars, sections: "
            + " · ".join(dropped) if dropped else
            "\n\n[… " + str(len(body) - len(kept)) + " more chars, no further headings — prose tail]")
    return kept + tail + "\n(read the node file for these)"


def resolve_roots():
    """WHERE THE TWO TREES LIVE — resolved, never hardcoded, never guessed.

    A skill ships inside a plugin and its scripts must run unmodified on a stranger's machine.
    The WORK tree has been addressable for a while (`workspace.root`). The TOPOLOGY tree was not:
    every consumer hardcoded `~/.openrig/shared-docs`, so half the walk was portable and half was
    not. Precedence matches every other typed key: env > config > derived > fail-with-the-key.

    The derived step is honest rather than clever: this script physically lives inside the
    shared-docs tree, so it can find its own `rigs/` sibling by walking up from __file__. That
    works for the library copy and its symlinked projections (resolved with realpath) and NOT for
    a real plugin copy — which is correct. A plugin copy on
    someone else's machine has no business inferring a path; it must be told, and it fails saying
    exactly which key to set rather than picking a directory and being confidently wrong."""
    out = {}
    out["work_root"] = os.environ.get("OPENRIG_WORKSPACE_ROOT") or rig_config("workspace.root")

    t = os.environ.get("OPENRIG_TOPOLOGY_ROOT") or rig_config("workspace.topology_root")
    if not t:
        # realpath, NOT abspath: the runtime tiers project this script as a SYMLINK
        # (~/.claude/skills/... -> the library copy). abspath keeps the symlink's own path, so
        # the ascent runs up a tree with no `rigs/` sibling and topology_root comes back
        # UNRESOLVED — for every agent reaching the tool the documented way. Measured 2026-08-14:
        # exit 3 via the projection, exit 0 via the realpath, same file.
        here = os.path.realpath(__file__)
        for _ in range(6):                       # scripts/ skill/ skills/ openrig-work/ -> shared-docs/
            here = os.path.dirname(here)
            cand = os.path.join(here, "rigs")
            if os.path.isdir(cand):
                t = cand
                break
    out["topology_root"] = t
    return out


def rig_config(key):
    if not shutil.which("rig"):
        return None
    try:
        p = subprocess.run(["rig", "config", "get", key], capture_output=True, text=True, timeout=10)
        v = (p.stdout or "").strip()
        return v if p.returncode == 0 and v else None
    except Exception:
        return None


def compose_up(start, names, root, field=None, prefer=False, shelves=None, leaf_cap=2400):
    shelves = SHELF_NAMES | set(shelves or ())
    start = os.path.abspath(start); root = os.path.abspath(root) if root else None
    levels = []
    d = start
    while True:
        levels.append(d)
        if root and os.path.samefile(d, root): break
        if not root and os.path.exists(os.path.join(d, ".compose-root")): break
        parent = os.path.dirname(d)
        if parent == d: break
        d = parent
    levels.reverse()  # root first: defaults, then overrides
    out = [f"<!-- GENERATED by compose.py up · {datetime.datetime.now().isoformat(timespec='minutes')} -->",
           f"<!-- start: {start} · altitudes: {sum(1 for d in levels if os.path.basename(d) not in shelves)} ({len(levels)} path segments) · chains: {', '.join(names)}" + (f" · FIELD: {field}" if field else "") + " -->",
           "<!-- Composed view — never edit; edit the fragments. -->"]
    GLYPH = {"seeded": "✓ seeded", "unseeded": "⟂ UNSEEDED", "conflicted": "⚠ stale marker",
             "absent": "✗ absent", "shelf": "· shelf"}
    missing, unseeded = [], []
    # --prefer turns the --name list into ONE chain resolved per level by precedence
    # (first match wins) instead of N independent chains. A tree mid-rename is the normal
    # case, not an exception: SPEC.md is the current node filename and README.md the legacy
    # one, and a trace that cannot span both reports a chain as broken when it is merely mixed.
    # Test the START NODE against the TREES, not the root against the workspace. Being
    # somewhere under workspace.root is not the property that matters: the measured hazard
    # is a fixture tree at workspace/artifacts/<qitem>/fixture-workspace/missions/, which is
    # inside workspace.root and is not a work tree. Only slices_root and topology_root name
    # actual trees, so those are the discriminator.
    _cfg = [c for c in (rig_config("workspace.slices_root"),
                        resolve_roots().get("topology_root")) if c]
    _here = os.path.abspath(start)
    _root_warning = None
    if _cfg and not any(_here == os.path.abspath(c) or _here.startswith(os.path.abspath(c) + os.sep)
                        for c in _cfg):
        _root_warning = ("  ⚠ THIS IS NOT A CONFIGURED TREE. Trees on this instance: "
                         + " · ".join(_cfg) + "\n    A walk renders just as cleanly from a stray or"
                         " fixture tree — verify before acting on it.")
    groups = [list(names)] if prefer else [[n] for n in names]
    for group in groups:
        name = group[0]
        out.append(f"\n\n# CHAIN: {' → '.join(group)} (root → leaf)"
                   + (" · precedence: first match wins per level" if len(group) > 1 else ""))
        # pass 1 — collect the state of every level (this IS the trace; the map derives from it)
        chain, hits = [], {}
        for lvl in levels:
            p = None
            for n in group:
                cand = os.path.join(lvl, n)
                if os.path.isfile(cand):
                    p, hits[lvl] = cand, n
                    break
            where = os.path.relpath(lvl, levels[0]) or '.'
            # A SHELF is a path segment, not an altitude. The chain has three rungs — project,
            # mission, slice — and rendering `missions/` and `slices/` as rungs implies five.
            # Any file living at a shelf is ordinary folder documentation, NOT a chain link:
            # ignore it rather than flagging it. `README.md` does double duty as a legacy node
            # name and as a plain readme, and only the level it sits at can tell them apart.
            is_shelf = os.path.basename(lvl) in shelves
            if is_shelf:
                state, payload, p = "shelf", None, None
                hits.pop(lvl, None)
            elif p:
                state, payload = read_state(p)
            else:
                state, payload = "absent", None
            # Resolve the field HERE so the map can tell the truth. A map keyed on file
            # presence says ✓ for a level that composes nothing — the exact reading that
            # lets a trace certify the drift it exists to catch.
            fval, fnote = (field_of(payload, field) if (field and state == "seeded") else (None, None))
            chain.append((lvl, where, state, payload, fval, fnote))
        # TRACE — derived orientation tree (never stored in files; the render is the only home)
        # The map shows ALTITUDES as rungs; shelves fold into the next rung's path so the tree
        # depth equals the number of levels that actually carry intent.
        rungs, pending = [], []
        for idx, row in enumerate(chain):
            if row[2] == "shelf" and idx != len(chain) - 1:
                pending.append(os.path.basename(row[0]) or row[0])
                continue
            label = "/".join(pending + [os.path.basename(row[0]) or row[0]])
            rungs.append((label, row)); pending = []
        leads = [("" if i == 0 else "   " * (i - 1) + "└─ ") + rungs[i][0] + "/" for i in range(len(rungs))]
        width = max(len(l) for l in leads) + 2
        # NAME THE REFERENT. Three cold subjects in a row assumed the tree they were
        # SHOWN was the tree their slice was ABOUT, and planned into the wrong one. The map
        # cannot know "work" vs "topology" semantically, but it knows what it walked — and
        # root + chain filename is enough to tell them apart (workspace/SPEC.md vs rigs/LEARNED.md).
        out.append(f"\nTRACE · root {levels[0]} · chain {' → '.join(group)}")
        # VALIDATE THE ROOT. Measured 2026-08-14: this box has four directories named
        # `missions`, one of them a TEST FIXTURE under artifacts/. Handed the fixture as
        # --root, the trace renders an equally clean, equally confident chain — because
        # `✓ seeded` means "a file was found here", never "you are in the right tree".
        # Confidence that is independent of correctness is the failure this whole mission
        # is against, so the trace now says when it cannot vouch for where it is standing.
        if _root_warning:
            out.append(_root_warning)
        for i, (_label, (lvl, where, state, payload, fval, fnote)) in enumerate(rungs):
            note = f" (owner: {payload})" if state == "unseeded" and payload else ""
            here = "   ← you are here" if i == len(rungs) - 1 else ""
            glyph = f"⟂ no {field}" if (field and state == "seeded" and not fval) else GLYPH[state]
            # In precedence mode, name WHICH file answered at each level — a mixed tree is
            # readable state, not noise, and hiding it is how a rename looks like corruption.
            via = f" [{hits[lvl]}]" if len(group) > 1 and lvl in hits and state != "shelf" else ""
            out.append(f"  {leads[i]:<{width}}{glyph}{via}{note}{here}")
        # pass 2 — contents, states collapsed per the three-state rules
        found = 0
        for lvl, where, state, payload, fval, fnote in chain:
            if state == "shelf":
                continue          # a path segment, not a position — contributes nothing, flags nothing
            elif state == "unseeded":
                out.append(f"\n⟂ {name} @ {where} — UNSEEDED (scaffold only, not rendered; seed it: {payload})")
                unseeded.append(f"{name} @ {where} (owner: {payload})")
            elif state == "conflicted":
                found += 1
                out.append(hdr(f"{name} @ {where} — ⚠ carries status: UNSEEDED but content differs from template"))
                out.append(payload.rstrip())
                unseeded.append(f"{name} @ {where} — MARKER/CONTENT DISAGREE: rendered anyway; owner should clear the stale status line")
            elif state == "seeded":
                found += 1
                if field:
                    if fval:
                        out.append(f"\n{where}:  {fval}")
                    else:
                        out.append(f"\n{where}:  ⚠ {fnote}")
                        unseeded.append(f"{name} @ {where} — {fnote}")
                    # The leaf is the only level whose answer is an ACTION. Compose its
                    # blocking state here or the walk certifies the next step it never read.
                    if lvl == chain[-1][0]:
                        blocked = blocking_state(payload, lvl, group)
                        if blocked:
                            out.append(f"  {blocked}")
                        roots = operates_on(payload)
                        if roots:
                            out.append("  operates on: " + " · ".join(roots))
                        # ...and the only altitude that SPECIFIES. See leaf_body().
                        lb = leaf_body(payload, leaf_cap) if leaf_cap else None
                        if lb:
                            out.append(f"\n─── {where} · node body ───")
                            out.append(lb)
                else:
                    out.append(hdr(f"{name} @ {where}"))
                    out.append(payload.rstrip())
            else:
                missing.append(f"{name} @ {where}")
        if not found:
            out.append(f"\n⚠ NO seeded instances of {name} on this walk.")
    if unseeded or missing:
        out.append("\n\n# ⚠ CHAIN AUDIT (the walk screams once, here — never by breaking, never by template litter)")
        if unseeded:
            out.append("UNSEEDED (file exists, template only — the owner writes the first true version):")
            out += [f"- {m}" for m in unseeded]
        if missing:
            out.append("ABSENT (no file at a POSITION — scaffold it, or report to the level owner if absence looks wrong):")
            out += [f"- {m}" for m in missing]
    return "\n".join(out)

def compose_down(root, names, excludes):
    root = os.path.abspath(root)
    hits = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x != "node_modules"
                   and not any(fnmatch.fnmatch(os.path.join(dirpath, x), g) for g in excludes)]
        for name in names:
            if name in files:
                hits.append(os.path.join(dirpath, name))
    hits.sort()
    out = [f"<!-- GENERATED by compose.py down · {datetime.datetime.now().isoformat(timespec='minutes')} -->",
           f"<!-- root: {root} · files: {len(hits)} · chains: {', '.join(names)} -->",
           "<!-- Subtree render (trunk render at a tree root). Never edit. -->"]
    unseeded = []
    for p in hits:
        state, payload = read_state(p)
        rel = os.path.relpath(p, root)
        if state == "unseeded":
            unseeded.append(f"{rel} (owner: {payload})")
        elif state == "conflicted":
            out.append(hdr(f"{rel} — ⚠ stale UNSEEDED marker on real content"))
            out.append(payload.rstrip())
            unseeded.append(f"{rel} — MARKER/CONTENT DISAGREE: rendered anyway; clear the stale status line")
        else:
            out.append(hdr(rel))
            out.append(payload.rstrip())
    if unseeded:
        out.append("\n\n# ⚠ UNSEEDED under this root (scaffold only — collapsed, not rendered)")
        out += [f"- {u}" for u in unseeded]
    if not hits:
        out.append("\n⚠ no chain files under this root — unfurl first?")
    return "\n".join(out)

def compose_progress(root, names, excludes):
    import collections
    root = os.path.abspath(root)
    direct = collections.defaultdict(lambda: [0, 0])   # dir -> [done, total] from its own files
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x != "node_modules"
                   and not any(fnmatch.fnmatch(os.path.join(dirpath, x), g) for g in excludes)]
        for name in names:
            if name in files:
                txt = open(os.path.join(dirpath, name), encoding="utf-8", errors="replace").read()
                done = len(re.findall(r"^\s*[-*] \[[xX]\]", txt, re.M))
                open_ = len(re.findall(r"^\s*[-*] \[ \]", txt, re.M))
                if done + open_:
                    direct[dirpath][0] += done
                    direct[dirpath][1] += done + open_
    agg = collections.defaultdict(lambda: [0, 0])       # dir -> rolled-up [done, total]
    for d, (dn, tt) in direct.items():
        cur = d
        while True:
            agg[cur][0] += dn; agg[cur][1] += tt
            if os.path.samefile(cur, root): break
            cur = os.path.dirname(cur)
    out = [f"<!-- GENERATED by compose.py progress · {datetime.datetime.now().isoformat(timespec='minutes')} -->",
           "<!-- Derived from the mark level at render time. Never store this in a file. -->",
           f"\nPROGRESS MAP ({', '.join(names)} — checkbox = the one mark level; everything above derives):"]
    if not agg:
        out.append("  (no checkboxes found in the named files under this root — nothing is marked here)")
        return "\n".join(out)
    keys = sorted(agg, key=lambda d: os.path.relpath(d, root))
    leads = []
    for d in keys:
        rel = os.path.relpath(d, root)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        label = os.path.basename(root) if rel == "." else os.path.basename(d)
        leads.append(("" if depth == 0 else "   " * (depth - 1) + "└─ ") + label)
    width = max(len(l) for l in leads) + 2
    for i, d in enumerate(keys):
        dn, tt = agg[d]
        pct = 100 * dn // tt if tt else 0
        glyph = "✓" if dn == tt else ("◐" if dn else "○")
        own = " ·" if d in direct else "  "   # · = has marks of its own (vs pure roll-up)
        out.append(f"  {leads[i]:<{width}}{glyph} {dn}/{tt} ({pct}%){own}")
    return "\n".join(out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["up", "down", "progress", "roots"])
    ap.add_argument("path", nargs="?")
    ap.add_argument("--name", action="append")
    ap.add_argument("--root", default=None)
    ap.add_argument("--prefer", action="store_true",
                    help="treat --name as a PRECEDENCE list (first match wins per level) rather "
                         "than separate chains — for a tree mid-rename: --name SPEC.md --name README.md --prefer")
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--field", default=None, help="compose ONE frontmatter field up the chain (e.g. --field intent) instead of whole bodies")
    ap.add_argument("--leaf-cap", type=int, default=2400, metavar="N",
                    help="with --field: also render the LEAF's body, capped at N chars (0 = off). "
                         "Ancestors compress; the leaf is where the nouns are.")
    ap.add_argument("--shelf", action="append", default=[],
                    help=f"extra directory name that HOLDS instances rather than being a position, so "
                         f"its absence of a chain file is correct (defaults: {', '.join(sorted(SHELF_NAMES))})")
    a = ap.parse_args()
    if a.mode == "roots":
        r = resolve_roots()
        for k in ("work_root", "topology_root"):
            v = r.get(k)
            if v:
                print(f"{k}={v}")
            else:
                key = "workspace.root" if k == "work_root" else "workspace.topology_root"
                print(f"# {k} UNRESOLVED — set it: rig config set {key} <path>", file=sys.stderr)
        sys.exit(0 if all(r.values()) else 3)
    if not a.name:
        ap.error("--name is required for up/down/progress")
    if a.mode == "up":
        print(compose_up(a.path, a.name, a.root, a.field, prefer=a.prefer, shelves=a.shelf, leaf_cap=a.leaf_cap))
    elif a.mode == "down":
        print(compose_down(a.path, a.name, a.exclude))
    else:
        print(compose_progress(a.path, a.name, a.exclude))
