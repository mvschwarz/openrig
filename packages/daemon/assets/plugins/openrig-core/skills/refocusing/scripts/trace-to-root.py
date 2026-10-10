#!/usr/bin/env python3
"""Render topology and work context by ascending directory paths only."""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
from pathlib import Path

SHELVES = {"rigs", "pods", "seats", "missions", "slices"}
# The daemon's exact current-work refusal meaning "this seat holds no in-progress typed baton"
# (daemon domain/current-work.js, NO_TYPED_IN_PROGRESS). Only this exact text earns the work-root
# fallback. Compare by equality, not prefix: the sibling refusal "no typed in-progress work
# resolved to a work node" is a resolution failure and must stay a named gap. If the daemon's
# wording changes, equality fails toward a named gap that shows the new text, never a silent fallback.
NO_CURRENT_BATON_BASIS = (
    "no typed in-progress work (only in-progress rows are considered; a typed row that is "
    "pending or blocked is not current work)"
)
# The daemon's session-name character set and human-class refs (domain/session-name.ts:
# validateSessionName, isHumanSeatSessionRef).
SESSION_CHARS = re.compile(r"[A-Za-z0-9\-_.@]+")
HUMAN_CLASS_SESSION = re.compile(r"human(?:-[A-Za-z0-9._-]+)?@(?:kernel|host)|[A-Za-z0-9._:-]+@external")


def rig_output(*args):
    try:
        result = subprocess.run(
            ["rig", *args], capture_output=True, text=True, timeout=10, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = (result.stdout or "").strip()
    return value if result.returncode == 0 and value else None


def configured_root(key, env_key):
    value = os.environ.get(env_key) or rig_output("config", "get", key)
    return Path(value).expanduser().resolve() if value else None


def under_root(path, root):
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def ascent(start, root):
    start = start.expanduser().resolve()
    if not under_root(start, root):
        return None, f"start is outside configured root: {start}"
    nodes = []
    current = start
    while True:
        if current.name not in SHELVES:
            nodes.append(current)
        if current == root:
            break
        parent = current.parent
        if parent == current:
            return None, f"could not reach configured root: {root}"
        current = parent
    return list(reversed(nodes)), None


def read(path):
    try:
        return path.read_text(encoding="utf8", errors="replace")
    except OSError:
        return None


def resolve_notes(node):
    try:
        result = subprocess.run(
            ["rig", "scope", "resolve-notes", str(node), "--json"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None, "resolver command timed out"
    except OSError as error:
        return None, f"resolver command could not start: {error}"
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        suffix = f": {detail[0]}" if detail else ""
        return None, f"resolver command exited {result.returncode}{suffix}"
    try:
        payload = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        return None, "resolver command returned malformed JSON"
    if not isinstance(payload, dict) or payload.get("ok") is not True or "resolution" not in payload:
        return None, "resolver command returned an invalid success shape"
    resolution = payload["resolution"]
    if resolution is None:
        return None, None
    if not isinstance(resolution, dict):
        return None, "resolver command returned an invalid resolution shape"
    resolved_path = resolution.get("path")
    resolved_name = resolution.get("name")
    if not isinstance(resolved_path, str) or not isinstance(resolved_name, str):
        return None, "resolver command returned an invalid resolution shape"
    return (Path(resolved_path), resolved_name), None


def intent(text):
    if not text or not text.startswith("---"):
        return None
    match = re.match(r"^---\s*\n(.*?)\n---(?:\s*\n|$)", text, re.S)
    if not match:
        return None
    lines = match.group(1).splitlines()
    for index, line in enumerate(lines):
        found = re.match(r"^intent:\s*(.*)$", line)
        if not found:
            continue
        value = found.group(1).strip()
        if value in {"|", ">", "|-", ">-", "|+", ">+"}:
            block = []
            for later in lines[index + 1:]:
                if later and not later[0].isspace():
                    break
                block.append(later.strip())
            return " ".join(part for part in block if part)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            if value[0] == '"':
                try:
                    return json.loads(value)
                except json.JSONDecodeError:
                    pass
            return value[1:-1]
        return value or None
    return None


def light_learned(text):
    if not text:
        return ""
    body = re.sub(r"^---\s*\n.*?\n---\s*\n", "", text, count=1, flags=re.S).strip()
    if len(body) <= 800:
        return body
    boundary = body.rfind("\n", 0, 800)
    return body[:boundary if boundary > 0 else 800].rstrip() + "\n[… use --depth full for the rest]"


# OPR.0.7.0.12 — the refocus packet (--packet). Duties and notes are carried as text by
# conventional section, with an honest "not found" and a bounded excerpt otherwise; nobody is
# asked to add headings. Old files are named with their measured age as a cue, not a verdict.
DUTY_HEADINGS = ("my job here", "standing duties")
NOTES_STATE_HEADINGS = ("current state",)
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
DEFAULT_NOTES_MAX_AGE_DAYS = 14


def heading_sections(text, wanted):
    """[(title, body)] for each Markdown heading whose title starts with a wanted phrase."""
    lines = re.sub(r"^---\s*\n.*?\n---\s*\n", "", text or "", count=1, flags=re.S).splitlines()
    found = []
    for index, line in enumerate(lines):
        match = HEADING.match(line)
        if not match or not match.group(2).strip().lower().startswith(wanted):
            continue
        level = len(match.group(1))
        body = []
        for later in lines[index + 1:]:
            heading = HEADING.match(later)
            if heading and len(heading.group(1)) <= level:
                break
            body.append(later)
        found.append((match.group(2).strip(), "\n".join(body).strip()))
    return found


def by_section(text, wanted, path):
    found = heading_sections(text, wanted)
    shown = "\n\n".join(f"{title}\n{body}" if body else title for title, body in found)
    missing = [phrase for phrase in wanted if not any(title.lower().startswith(phrase) for title, _ in found)]
    if not missing:
        return shown
    if not found:
        names = " or ".join(f'"{phrase.upper()}"' for phrase in wanted)
        return f"SECTION NOT FOUND — no {names} heading in {path}; bounded excerpt follows\n{light_learned(text)}"
    # Some sections matched: name each one that did not, with the same bounded excerpt, so text
    # kept under another heading is not silently dropped.
    names = ", ".join(f'"{phrase.upper()}"' for phrase in missing)
    return f"{shown}\n\nSECTION NOT FOUND — no {names} heading in {path}; bounded excerpt follows\n{light_learned(text)}"


def notes_max_age_days():
    try:
        value = float(os.environ.get("OPENRIG_REFOCUS_NOTES_MAX_AGE_DAYS", DEFAULT_NOTES_MAX_AGE_DAYS))
    except ValueError:
        return DEFAULT_NOTES_MAX_AGE_DAYS
    return value if value > 0 else DEFAULT_NOTES_MAX_AGE_DAYS


def age_cue(path, text):
    """An OLD NOTES line when the file is past the threshold, measured from `updated:` or mtime."""
    threshold = notes_max_age_days()
    updated, source = None, "mtime"
    match = re.match(r"^---\s*\n(.*?)\n---", text or "", re.S)
    if match:
        found = re.search(r"^updated:\s*[\"']?(\d{4}-\d{2}-\d{2})", match.group(1), re.M)
        if found:
            try:
                updated = datetime.datetime.strptime(found.group(1), "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc)
                source = "updated"
            except ValueError:
                updated = None
    if updated is None:
        try:
            updated = datetime.datetime.fromtimestamp(path.stat().st_mtime, datetime.timezone.utc)
        except OSError:
            return None
    age = (datetime.datetime.now(datetime.timezone.utc) - updated).total_seconds() / 86400
    if age <= threshold:
        return None
    return f"OLD NOTES — {path}, {age:.0f} days old, source {source}, threshold {threshold:g} days"


def render_topology(start, root, depth, failures, packet=False):
    output = ["## TOPOLOGY TRACE", f"root: {root}", f"start: {start}"]
    nodes, error = ascent(start, root)
    if error:
        failures.append(error)
        return "\n".join(output + [f"TRACE GAP — {error}"])
    for node in nodes:
        chain_file = node / "LEARNED.md"
        text = read(chain_file)
        label = node.relative_to(root) or Path(".")
        if text is None:
            output.append(f"\n### {label}\nMISSING LINK — {chain_file}")
            continue
        if depth == "full":
            body = text.strip()
        elif packet and node == nodes[-1]:
            # The seat's own file: its job and standing duties as text.
            body = by_section(text, DUTY_HEADINGS, chain_file)
        else:
            body = light_learned(text)
        output.append(f"\n### {label} · LEARNED.md\n{body}")
        cue = age_cue(chain_file, text) if packet else None
        if cue:
            output.append(cue)
    return "\n".join(output)


def render_work(start, root, depth, failures, fallback=None, packet=False):
    output = ["## WORK TRACE", f"root: {root}", f"start: {start}"]
    if fallback:
        output.append(f"FALLBACK — {fallback}")
    nodes, error = ascent(start, root)
    if error:
        failures.append(error)
        return "\n".join(output + [f"TRACE GAP — {error}"])
    for node in nodes:
        label = node.relative_to(root) or Path(".")
        spec = next((candidate for candidate in (node / "SPEC.md", node / "README.md") if candidate.is_file()), None)
        if spec is None:
            output.append(f"\n### {label}\nMISSING LINK — no SPEC.md or README.md at {node}")
        else:
            text = read(spec) or ""
            if depth == "full":
                body = text.strip()
            else:
                value = intent(text)
                body = f"intent: {value}" if value else "MISSING INTENT — no readable intent: field"
            output.append(f"\n### {label} · {spec.name}\n{body}")

        notes, resolution_error = resolve_notes(node)
        if resolution_error:
            failures.append(resolution_error)
            output.append(f"NOTES RESOLUTION GAP — {resolution_error} at {node}")
        elif notes:
            notes_path, notes_name = notes
            if depth == "full":
                notes_text = read(notes_path)
                if notes_text is None:
                    failures.append(f"unreadable notes: {notes_path}")
                    output.append(f"NOTES RESOLUTION GAP — resolved {notes_name} became unreadable at {notes_path}")
                else:
                    output.append(f"\nNOTES · {notes_name}\n{notes_text.strip()}")
                    cue = age_cue(notes_path, notes_text) if packet else None
                    if cue:
                        output.append(cue)
            elif packet:
                notes_text = read(notes_path)
                if notes_text is None:
                    failures.append(f"unreadable notes: {notes_path}")
                    output.append(f"NOTES RESOLUTION GAP — resolved {notes_name} became unreadable at {notes_path}")
                else:
                    output.append(f"\nNOTES · {notes_name}\n{by_section(notes_text, NOTES_STATE_HEADINGS, notes_path)}")
                    cue = age_cue(notes_path, notes_text)
                    if cue:
                        output.append(cue)
            else:
                try:
                    size = notes_path.stat().st_size
                except OSError:
                    failures.append(f"unreadable notes: {notes_path}")
                    output.append(f"NOTES RESOLUTION GAP — resolved {notes_name} became unreadable at {notes_path}")
                else:
                    output.append(f"NOTES · {notes_name} · {size} bytes · {notes_path}")
        else:
            output.append(f"NOTES GAP — no readable mission notes at {node}")

        # The SDLC convention keeps a node's current delivery state in PROGRESS.md; carry it
        # as text when present. Its absence is not a gap: many nodes have no PROGRESS.md.
        progress_path = node / "PROGRESS.md"
        progress_text = read(progress_path) if packet else None
        if progress_text is not None:
            progress_body = progress_text.strip() if depth == "full" else by_section(progress_text, NOTES_STATE_HEADINGS, progress_path)
            output.append(f"\nPROGRESS · PROGRESS.md\n{progress_body}")
            cue = age_cue(progress_path, progress_text)
            if cue:
                output.append(cue)
    return "\n".join(output)


def candidate_line(candidate):
    name = candidate.get("mission") or "?"
    if candidate.get("slice"):
        name += f" / {candidate['slice']}"
    intent_text = candidate.get("intent") or "no readable intent"
    line = f"- {name} — {intent_text} — source: {candidate.get('source') or 'unknown'}"
    if candidate.get("unresolved"):
        line += f" — UNRESOLVED ON THIS HOST: {candidate['unresolved']}"
    return line


def render_held_and_next(evidence):
    output = []
    held = evidence.get("held") or []
    if held:
        output.append("HELD WORK (blocked; this is not next):")
        for row in held:
            output.append(f"- {row.get('qitemId') or 'a row'} — {row.get('summary') or 'no summary'} — "
                          f"blocked on {row.get('blockedOn') or 'unknown'} — "
                          f"continuation: {row.get('continuation') or 'none recorded'}")
    following = evidence.get("next") or []
    if following:
        output.append("POSSIBLE NEXT WORK (pending; no order implied):")
        for row in following:
            missions = ", ".join(row.get("missions") or [])
            output.append(f"- {row.get('qitemId') or 'a row'} — {row.get('summary') or 'no summary'}"
                          + (f" [mission: {missions}]" if missions else ""))
    if evidence.get("heldAndNextTruncated"):
        output.append("(held and next lists were cut; `rig queue list` has the rest)")
    return "\n".join(output)


def render_candidates(evidence, root, depth, failures):
    """The work section from labelled queue evidence. One direct, resolved tag is shown as the
    work with its source; anything less certain lists every candidate and asks the agent."""
    candidates = evidence.get("candidates") or []
    unknown = evidence.get("unknown") or []
    if (len(candidates) == 1 and not unknown and candidates[0].get("kind") == "tag"
            and candidates[0].get("workNodePath") and not candidates[0].get("unresolved")):
        only = candidates[0]
        notes = [f"WORK FROM QUEUE EVIDENCE — {only.get('source')}. If this is stale, say what you are actually doing."]
        if not only.get("slice"):
            notes.append("no slice named")
        traced = render_work(Path(only["workNodePath"]), root, depth, failures, packet=True)
        head, _, rest = traced.partition("\n")
        return "\n".join([head, *notes, rest])

    missions_root = evidence.get("missionsRoot") or str(root / "missions")
    output = ["## WORK — name it"]
    if not candidates and not unknown:
        output.append("No in-progress queue row names your work. If you are working from messages, "
                      "name the mission they belong to; if you have no current work, say so.")
    elif len(candidates) > 1:
        output.append(f"{len(candidates)} candidates are in flight. Say which mission you are actually working on.")
    else:
        output.append("The queue evidence does not settle your work. Confirm a candidate or name your mission.")
    if candidates:
        output.append("Candidates (evidence, not a verdict; none is adopted for you):")
        output.extend(candidate_line(candidate) for candidate in candidates)
    if unknown:
        output.append("In-progress rows the queue cannot place:")
        output.extend(f"- {row.get('qitemId') or 'a row'} — {row.get('summary') or 'no summary'}: {row.get('reason')}"
                      for row in unknown)
    if not candidates:
        names = evidence.get("missionsOnHost") or []
        if names:
            listing = ", ".join(names) + (", …" if evidence.get("missionsOnHostTruncated") else "")
            output.append(f"Missions on this host: {listing}")
    output.append("Then read that mission's current intent as text:")
    output.append(f"  python3 {Path(__file__).resolve()} --trees work --packet --work-start {missions_root}/<mission>")
    orientation = render_work(root, root, "light", failures, packet=True)
    _, _, rest = orientation.partition("\n")
    output.append("\n## ORIENTATION — the project-level chain, not your work\n" + rest.lstrip("\n"))
    return "\n".join(output)


def read_candidates(source):
    try:
        raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf8")
        evidence = json.loads(raw)
    except (OSError, json.JSONDecodeError) as error:
        return None, f"work candidates unreadable: {error}"
    if not isinstance(evidence, dict) or not isinstance(evidence.get("candidates", []), list):
        return None, "work candidates have an invalid shape"
    return evidence, None


def canonical_seat(session):
    """(member, rig) for a canonical session name, else None so the caller asks `rig whoami`.

    Mirrors the daemon's parse contract (domain/session-name.ts, parseSessionName): the member is
    everything before the FIRST "@" and the rig is everything after it, which may itself contain
    "@". Human-class refs are not seats, and a name outside the session character set
    (validateSessionName) is uncertain, so both keep the lookup."""
    if not session or not SESSION_CHARS.fullmatch(session) or HUMAN_CLASS_SESSION.fullmatch(session):
        return None
    member, at, rig = session.partition("@")
    return (member, rig) if at and member and rig else None


def derive_topology_start(root):
    explicit = os.environ.get("OPENRIG_REFOCUS_TOPOLOGY_NODE")
    if explicit:
        return Path(explicit)
    # A stale session name (one left over from a seat swap) can name a seat that has no folder;
    # only an existing seat directory is trusted, otherwise `rig whoami` decides.
    seat = canonical_seat(os.environ.get("OPENRIG_SESSION_NAME"))
    if seat:
        member, rig = seat
        candidate = root / "rigs" / rig / "seats" / member
        if candidate.is_dir():
            return candidate
    raw = rig_output("whoami", "--json")
    if not raw:
        return None
    try:
        identity = json.loads(raw).get("identity", {})
    except json.JSONDecodeError:
        return None
    rig = identity.get("rigName")
    session = identity.get("sessionName")
    if not rig or not session:
        return None
    seat = str(session).split("@", 1)[0]
    return root / "rigs" / str(rig) / "seats" / seat


def derive_work_start(root):
    explicit = os.environ.get("OPENRIG_REFOCUS_WORK_NODE")
    if explicit:
        return Path(explicit)
    current = Path.cwd().resolve()
    if not under_root(current, root):
        return None
    while under_root(current, root):
        if (current / "SPEC.md").is_file() or (current / "README.md").is_file():
            return current
        if current == root:
            break
        current = current.parent
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trees", choices=("topology", "work", "both"), default=os.environ.get("OPENRIG_REFOCUS_TREES", "both"))
    parser.add_argument("--depth", choices=("light", "full"), default=os.environ.get("OPENRIG_REFOCUS_DEPTH", "light"))
    parser.add_argument("--topology-start")
    parser.add_argument("--work-start")
    parser.add_argument("--work-basis", help="the daemon's reason no current work node was named")
    parser.add_argument("--work-unknown", help="why the current work node could not be read")
    parser.add_argument("--check", action="store_true", help="exit nonzero on trace or notes resolution failure; rendered text is unchanged")
    parser.add_argument("--packet", action="store_true", help="carry duties and notes as text by section, with old-notes cues")
    parser.add_argument("--work-candidates", help="labelled work evidence as JSON (a path, or - for stdin), from `rig queue whoami --work-candidates`")
    args = parser.parse_args()

    sections = []
    failures = []

    def gap(text):
        failures.append(text)
        return text
    if args.trees in {"topology", "both"}:
        root = configured_root("topology.root", "OPENRIG_TOPOLOGY_ROOT")
        if root is None:
            sections.append(gap("## TOPOLOGY TRACE\nTRACE GAP — topology.root is unresolved"))
        else:
            start = Path(args.topology_start) if args.topology_start else derive_topology_start(root)
            sections.append(render_topology(start, root, args.depth, failures, packet=args.packet) if start else
                            gap("## TOPOLOGY TRACE\nTRACE GAP — current topology node is unresolved; pass --topology-start with a literal absolute path (or configure OPENRIG_REFOCUS_TOPOLOGY_NODE separately)"))

    if args.trees in {"work", "both"}:
        root = configured_root("workspace.root", "OPENRIG_WORKSPACE_ROOT")
        if root is None:
            sections.append(gap("## WORK TRACE\nTRACE GAP — workspace.root is unresolved"))
        else:
            # Precedence: an explicit start wins; then the hook's daemon answer (basis or unknown);
            # only a standalone run with neither falls back to inferring from the working directory.
            explicit = args.work_start or os.environ.get("OPENRIG_REFOCUS_WORK_NODE")
            evidence = None
            if args.work_candidates:
                evidence, error = read_candidates(args.work_candidates)
                if error:
                    sections.append(gap(f"## WORK TRACE\nTRACE GAP — {error}"))
            if explicit:
                sections.append(render_work(Path(explicit), root, args.depth, failures, packet=args.packet))
            elif evidence is not None:
                sections.append(render_candidates(evidence, root, args.depth, failures))
            elif args.work_candidates:
                pass  # the unreadable-evidence gap above is the answer; never fall back to the root
            elif args.work_basis == NO_CURRENT_BATON_BASIS:
                sections.append(render_work(root, root, args.depth, failures, packet=args.packet, fallback=(
                    f"no current typed baton ({args.work_basis}). Showing the project-level chain from the work root: "
                    "a broad orientation, not evidence of a current mission")))
            elif args.work_basis:
                sections.append(gap(f"## WORK TRACE\nTRACE GAP — no single current work node: {args.work_basis}"))
            elif args.work_unknown:
                sections.append(gap(f"## WORK TRACE\nTRACE GAP — current work node UNKNOWN: {args.work_unknown}"))
            else:
                start = derive_work_start(root)
                sections.append(render_work(start, root, args.depth, failures, packet=args.packet) if start else
                                gap("## WORK TRACE\nTRACE GAP — current work node is unresolved; pass --work-start with a literal absolute path (or configure OPENRIG_REFOCUS_WORK_NODE separately)"))
            held_and_next = render_held_and_next(evidence) if evidence else ""
            if held_and_next:
                sections.append(held_and_next)

    print("\n\n".join(sections))
    return 1 if args.check and failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
