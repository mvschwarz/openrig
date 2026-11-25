#!/usr/bin/env python3
"""Render topology and work context by ascending directory paths only."""

import argparse
import datetime
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

TRACE_STARTED = time.monotonic()
try:
    PARENT_TRACE_BUDGET = max(0, float(os.environ.get("OPENRIG_REFOCUS_PARENT_BUDGET_MS", "1650")) / 1000)
except ValueError:
    PARENT_TRACE_BUDGET = 1.65

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


def rig_output(*args, timeout=10):
    try:
        result = subprocess.run(
            ["rig", *args], capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    value = (result.stdout or "").strip()
    return value if result.returncode == 0 and value else None


def configured_root(key, env_key):
    value = os.environ.get(env_key) or rig_output("config", "get", key)
    return Path(value).expanduser().resolve() if value else None


def extra_work_roots(cli_roots):
    """Roots beyond workspace.root that the work trace may ascend to: a catalogued project
    can live outside workspace.root (#2693). Refocus-only, unlike OPENRIG_WORKSPACE_ROOT,
    which the CLI config store also reads as workspace.root."""
    values = list(cli_roots or [])
    values += [part for part in (os.environ.get("OPENRIG_REFOCUS_WORK_ROOT") or "").split(os.pathsep) if part]
    return [Path(value).expanduser().resolve() for value in values]


def work_root_for(start, root, extra_roots):
    """The deepest known root that contains start; workspace.root when none does, so a node
    outside every known root still reports the same gap."""
    if start is None or not extra_roots:
        return root
    start = Path(start).expanduser().resolve()
    containing = [candidate for candidate in (root, *extra_roots) if under_root(start, candidate)]
    return max(containing, key=lambda candidate: len(candidate.parts)) if containing else root


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


def may_have_parent(node, spec_text, timeout):
    # Avoid a parser process for ordinary documents without any possible key.
    # For possible links, use the same YAML parser as the CLI before querying.
    manifest = read(node / "mission.yaml")
    if manifest is None and (node / "mission.yaml").exists():
        return None
    frontmatter = re.match(r"\A---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)", spec_text)
    text = manifest if manifest is not None else (frontmatter.group(1) if frontmatter else "")
    if not re.search(r"parent|\\|\*|<<|\?", text, re.IGNORECASE):
        return False
    if timeout <= 0:
        return None
    rig = shutil.which("rig")
    paths = [str(Path(__file__).resolve().parent), str(node), str(Path.cwd())]
    if rig:
        paths.append(str(Path(rig).resolve().parent))
    script = """
const fs = require('node:fs');
const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
let yamlPath;
try { yamlPath = require.resolve('yaml', { paths: input.paths }); }
catch {
  const cli = require.resolve('@openrig/cli', { paths: input.paths });
  yamlPath = require.resolve('yaml', { paths: [path.dirname(cli)] });
}
const YAML = require(yamlPath);
const doc = YAML.parse(input.text);
const value = input.manifest ? doc?.metadata?.parent : doc?.parent;
process.stdout.write(typeof value === 'string' && value.trim() ? 'yes' : 'no');
"""
    try:
        result = subprocess.run(["node", "-e", script], input=json.dumps({"text": text, "manifest": manifest is not None, "paths": paths}), capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return {"yes": True, "no": False}.get(result.stdout) if result.returncode == 0 else None


# Contract twin of CLI scope-fs.ts and daemon scope/node-file.ts; parity is tested.
NOTES_FILE_PRECEDENCE = ("NOTES.md", "MISSION_NOTES.md")


def resolve_notes(node):
    for name in NOTES_FILE_PRECEDENCE:
        candidate = node / name
        try:
            if candidate.is_file() and os.access(candidate, os.R_OK):
                return (candidate, name), None
        except OSError:
            pass
    return None, None


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
# Each packet field is bounded on its own; there is no total cap. A row's summary and continuation are one line each,
# as are its scope's tags and reasons, the held and next lists show their newest rows with the full count, and a
# matched section's body is cut at a line.
FIELD_CHARS = 160
HELD_SHOWN = 20
NEXT_SHOWN = 10
CHOICES_SHOWN = 10
# A held or pending row's scope as the daemon sends it (RowScope); rows sharing all of it are one choice.
SCOPE_FIELDS = ("missions", "slice", "missionPath", "slicePath", "unresolved", "missionsRootFallback")
SECTION_CHARS = 1500
NOTHING_IN_PROGRESS = ("No in-progress queue row names your work. If you are working from messages, "
                       "name the mission they belong to; if you have no current work, say so.")


def one_line(text):
    """(text as one line, cut to FIELD_CHARS, whether it was shortened)."""
    flat = " ".join(str(text).split())
    if len(flat) <= FIELD_CHARS:
        return flat, flat != str(text).strip()
    return flat[:FIELD_CHARS - 1].rstrip() + "…", True


def bounded_section(body):
    if len(body) <= SECTION_CHARS:
        return body
    boundary = body.rfind("\n", 0, SECTION_CHARS)
    return body[:boundary if boundary > 0 else SECTION_CHARS].rstrip() + "\n[… use --depth full for the rest]"


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
    shown = "\n\n".join(f"{title}\n{bounded_section(body)}" if body else title for title, body in found)
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


def parsed_frontmatters(texts):
    """Parse all trace frontmatter in one batch; unknown documents stay unknown."""
    def simple_fallback(block):
        # Installed plugins may have neither PyYAML nor Node's yaml package.
        # Recognise only unambiguous single-line scalar fields; do not guess
        # flow mappings, complex values, or duplicate keys.
        if block is None:
            return None
        fields, seen = {}, set()
        pattern = re.compile(r'''^(?:(?P<quote>["'])(?P<quoted>progress_rail|current_state_updated)(?P=quote)|(?P<plain>progress_rail|current_state_updated))[ \t]*:[ \t]*(?P<value>[^\r\n#]*?)(?:[ \t]+\#.*)?[ \t]*$''')
        lines = block.splitlines()
        for index, line in enumerate(lines):
            match = pattern.match(line)
            if not match:
                continue
            key = match.group("quoted") or match.group("plain")
            if key in seen:
                return None
            seen.add(key)
            following = next((line for line in lines[index + 1:]
                              if line.strip() and not line.lstrip().startswith("#")), "")
            if following and following[0] in " \t":
                # A continued scalar is not an unambiguous single-line value.
                continue
            value = match.group("value").strip()
            if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
                value = value[1:-1]
            if key == "progress_rail" and value == "readme-only":
                fields[key] = value
            elif key == "current_state_updated" and re.fullmatch(r"[0-9TtZz:+.\-]+", value):
                fields[key] = value
        return fields

    blocks = []
    for text in texts:
        match = re.match(r"^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", text or "", re.S)
        blocks.append(match.group(1) if match else None)
    try:
        import yaml
        def parse(block):
            if block is None:
                return None
            try:
                value = yaml.load(block, Loader=yaml.BaseLoader)
                return value if isinstance(value, dict) else None
            except yaml.YAMLError:
                return None
        return [parse(block) for block in blocks]
    except ImportError:
        # OpenRig ships Node and the same YAML parser used by its scope writer.
        program = r'''const fs = require("fs"), path = require("path");
const rig = process.argv[2];
const roots = [path.dirname(process.argv[1])];
if (rig) {
  roots.push(path.dirname(fs.realpathSync(rig)));
  roots.push(path.join(path.dirname(rig), "node_modules", "@openrig", "cli"));
}
const yaml = require(require.resolve("yaml", {paths: roots}));
const blocks = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(blocks.map(block => {
  if (block === null) return null;
  try { const doc = yaml.parseDocument(block); const value = doc.toJS();
    return !doc.errors.length && value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
})));'''
        try:
            result = subprocess.run(["node", "-e", program, str(Path(__file__).resolve()), shutil.which("rig") or ""],
                                    input=json.dumps(blocks), capture_output=True, encoding="utf-8", timeout=1, check=True)
            values = json.loads(result.stdout)
            return values if isinstance(values, list) and len(values) == len(blocks) else [None] * len(blocks)
        except (OSError, subprocess.SubprocessError, ValueError):
            return [simple_fallback(block) for block in blocks]


def current_state_cue(text, metadata):
    """Use the state stamp, never the file mtime (other edits change it)."""
    stamp = metadata.get("current_state_updated") if isinstance(metadata, dict) else None
    if isinstance(stamp, str):
        try:
            updated = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            if updated.tzinfo is not None:
                hours = (datetime.datetime.now(datetime.timezone.utc) - updated).total_seconds() / 3600
                return f"CURRENT STATE — written {stamp} ({hours:.1f} hours ago)"
        except ValueError:
            pass
    return "CURRENT STATE — write time unknown"


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
    texts = []
    if packet:
        for node in nodes:
            spec_file = next((candidate for candidate in (node / "SPEC.md", node / "README.md") if candidate.is_file()), None)
            for candidate in (spec_file, node / "PROGRESS.md"):
                value = read(candidate) if candidate is not None else None
                if value is not None and value not in texts:
                    texts.append(value)
    metadata_by_text = dict(zip(texts, parsed_frontmatters(texts))) if texts else {}
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

            # Parent links are logical edges, not filesystem ancestors. Ask the
            # scope reader to resolve IDs so tracing uses the same rules as CLI.
            remaining = PARENT_TRACE_BUDGET - (time.monotonic() - TRACE_STARTED)
            has_parent = may_have_parent(node, text, remaining)
            if has_parent is None:
                failures.append(f"parent link unavailable or timed out: {node}")
                output.append(f"PARENT TRACE GAP — unable to read parent link within budget at {node}")
            elif has_parent:
                remaining = PARENT_TRACE_BUDGET - (time.monotonic() - TRACE_STARTED)
                workspace = next((ancestor for ancestor in node.parents if under_root(ancestor, root) and (ancestor / "project.yaml").is_file()), node.parent)
                raw = rig_output("scope", "mission", "show", str(node), "--workspace", str(workspace), "--json", timeout=remaining) if remaining > 0 else None
                try:
                    mission = json.loads(raw)["mission"]
                    for parent in mission["parentChain"]:
                        output.append(f"PARENT · {parent['id']} · {parent['path']}\nintent: {parent.get('intent') or 'MISSING INTENT'}")
                    if mission.get("parentGap"):
                        failures.append(mission["parentGap"])
                        output.append(f"PARENT TRACE GAP — {mission['parentGap']}")
                except (TypeError, ValueError, KeyError):
                    failures.append(f"parent link unavailable or timed out: {node}")
                    output.append(f"PARENT TRACE GAP — unable to read parent link within budget at {node}")

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
        if packet and progress_text is None and spec is not None:
            frontmatter = metadata_by_text.get(text)
            if isinstance(frontmatter, dict) and frontmatter.get("progress_rail") == "readme-only":
                progress_path, progress_text = spec, text
        if progress_text is not None:
            progress_body = progress_text.strip() if depth == "full" else by_section(progress_text, NOTES_STATE_HEADINGS, progress_path)
            output.append(f"\nPROGRESS · {progress_path.name}\n{progress_body}")
            metadata = metadata_by_text.get(progress_text)
            has_state = any((match := HEADING.match(line)) and match.group(1) == "##" and match.group(2).strip().lower() == "current state" for line in progress_text.splitlines())
            if has_state or (isinstance(metadata, dict) and "current_state_updated" in metadata):
                output.append(current_state_cue(progress_text, metadata))
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


def full_row_pointer(row, cut):
    return f" — full row: rig queue show {row['qitemId']}" if cut and row.get("qitemId") else ""


def row_fields(row, *fields, shortened=False):
    """Each named field as one bounded line, and a pointer to the whole row when any was shortened (or, with shortened,
    when the caller already shortened other text from the same row)."""
    values, cut = [], shortened
    for field, missing in fields:
        value, field_cut = one_line(row.get(field) or missing)
        values.append(value)
        cut = cut or field_cut
    return values, full_row_pointer(row, cut)


def cut_notice(name, state, rows, shown, daemon_cut):
    """The list's notice when it was cut here or by the daemon: how many are shown, of how many."""
    if not daemon_cut and len(rows) <= shown:
        return None
    total = f"more than {len(rows)}" if daemon_cut else str(len(rows))
    return (f"(the {name} list was cut: {min(len(rows), shown)} of {total} shown; "
            f"`rig queue list --owned --state {state}` has the rest)")


def scope_text(row):
    """A held or next row's scope as (missions, slice, note, shortened): its mission tags, its slice tag, and a note on
    why they did not resolve here or resolved only under a fallback missions root (so it may be another project's
    mission of the same name). Tags and reasons arrive verbatim, so each is one bounded line, as a row's other fields
    are; shortened says whether any was cut or flattened. A part the row lacks is empty."""
    parts, shortened = [], False
    for value in (", ".join(row.get("missions") or []), row.get("slice"), row.get("unresolved"), row.get("missionsRootFallback")):
        text, cut = one_line(value) if value else ("", False)
        parts.append(text)
        shortened = shortened or cut
    missions, slice_name, unresolved, fallback = parts
    if unresolved:
        note = f" — UNRESOLVED ON THIS HOST: {unresolved}" + (f" (through a fallback missions root: {fallback})" if fallback else "")
    else:
        note = f" — RESOLVED ONLY THROUGH A FALLBACK MISSIONS ROOT: {fallback}" if fallback else ""
    return missions, slice_name, note, shortened


def scope_label(row):
    """(a held or next row's own mission (and slice) tags as a label, with why they did not resolve here if they didn't;
    whether any part was shortened)."""
    missions, slice_name, note, shortened = scope_text(row)
    if not missions:
        return "", False
    return f" [mission: {missions}" + (f" / slice: {slice_name}" if slice_name else "") + "]" + note, shortened


def render_held_and_next(evidence):
    output = []
    per_list = "heldTruncated" in evidence or "nextTruncated" in evidence
    held = evidence.get("held") or []
    if held:
        output.append("HELD WORK (blocked; this is not next):")
        for row in held[:HELD_SHOWN]:
            label, label_cut = scope_label(row)
            (summary, blocked_on, continuation), pointer = row_fields(
                row, ("summary", "no summary"), ("blockedOn", "unknown"), ("continuation", "none recorded"), shortened=label_cut)
            output.append(f"- {row.get('qitemId') or 'a row'} — {summary} — blocked on {blocked_on} — "
                          f"continuation: {continuation}{label}{pointer}")
    following = evidence.get("next") or []
    if following:
        output.append("POSSIBLE NEXT WORK (pending; no order implied):")
        for row in following[:NEXT_SHOWN]:
            label, label_cut = scope_label(row)
            (summary,), pointer = row_fields(row, ("summary", "no summary"), shortened=label_cut)
            output.append(f"- {row.get('qitemId') or 'a row'} — {summary}{label}{pointer}")
    notices = [
        cut_notice("held", "blocked", held, HELD_SHOWN, per_list and bool(evidence.get("heldTruncated"))),
        cut_notice("next", "pending", following, NEXT_SHOWN, per_list and bool(evidence.get("nextTruncated"))),
    ]
    output.extend(notice for notice in notices if notice)
    if not per_list and evidence.get("heldAndNextTruncated"):
        output.append("(held and next lists were cut; `rig queue list` has the rest)")
    return "\n".join(output)


def scope_choice(row, root, extra_roots):
    """One named mission (and slice) with its folder and, when it has one, the command that reads it: the agent runs it
    as its own call, without this run's --work-root, so a folder outside workspace.root names the known root holding it.
    The name and reasons are bounded as a row's scope label is, with the row's pointer when shortened; the folder and its
    command keep the exact path."""
    missions, slice_name, note, shortened = scope_text(row)
    where = row.get("slicePath") or row.get("missionPath")
    line = (f"- {missions}" + (f" / {slice_name}" if slice_name else "") + (f" — {where}" if where else "")
            + note + full_row_pointer(row, shortened))
    if not where:
        return line
    work_root = work_root_for(where, root, extra_roots)
    return f"{line}\n  {read_command(where, work_root if work_root != root else None)}"


def held_context(evidence, root, depth, failures, extra_roots=(), packet=False):
    """Nothing in progress: held (blocked) and pending rows are context, never current work. Returns (trace, choices,
    open): the work trace of the one mission every row resolves to (of its slice, when that is the same for every row
    too), or else no trace and lines naming the missions the rows do name, each with the command that reads it, for the
    agent to choose from; open is true when one of them has no folder, so only the generic route can reach it. Missions
    are compared by resolved directory, never by name, and only across the daemon's whole lists: a cut list, a row naming
    no mission, one that did not resolve or one found only under a fallback missions root leaves the choice to the agent.
    Held rows come first only in the listing."""
    held, following = evidence.get("held") or [], evidence.get("next") or []
    rows = [*held, *following]
    named = [row for row in rows if row.get("missions")]
    if not named:
        return None, [], False
    missions = {row.get("missionPath") for row in rows}
    slices = {row.get("slicePath") for row in rows}
    if any(evidence.get(flag) for flag in ("heldTruncated", "nextTruncated", "heldAndNextTruncated")):
        why = "the held or pending list was cut, so rows past the cut may name other work"
    elif len(named) < len(rows):
        why = "a row names no mission"
    elif any("missionPath" not in row for row in named):
        why = "the daemon did not say which folders the rows' missions resolve to"
    elif None in missions:
        why = "a row's mission did not resolve to one directory here"
    elif any(row.get("missionsRootFallback") for row in named):
        why = "a row's mission resolved only through a fallback missions root"
    elif len(missions) > 1:
        why = "the rows name different missions"
    else:
        if len(slices) == 1 and None not in slices:
            start, level = next(iter(slices)), "this slice"
        else:
            start = next(iter(missions))
            level = ("this mission (not every row resolves to one slice, so it stops at the mission)"
                     if any(row.get("slice") for row in rows) else "this mission (no slice named)")
        note = (f"CONTEXT FROM HELD AND PENDING WORK — nothing is in progress, and every held and pending row "
                f"({len(held)} held, {len(following)} pending) resolves to {level}. It is context, not your current "
                "work: using it does not resume a task.")
        traced = render_work(Path(start), work_root_for(start, root, extra_roots), depth, failures, packet=packet)
        head, _, rest = traced.partition("\n")
        return "\n".join([head, note, rest]), [], False
    # One choice per scope, in row order; a shortened one points to the first row that names it.
    by_scope = {}
    for row in named:
        by_scope.setdefault(json.dumps([row.get(key) for key in SCOPE_FIELDS]), row)
    choices = [scope_choice(row, root, extra_roots) for row in by_scope.values()]
    more = [f"- … and {len(choices) - CHOICES_SHOWN} more"] if len(choices) > CHOICES_SHOWN else []
    open_choice = any(not (row.get("slicePath") or row.get("missionPath")) for row in named)
    return None, [f"Held and pending work is context, not current work, and does not settle one mission ({why}). "
                  "Choosing one does not resume a task. The missions it names, each with the command that reads it:",
                  *choices[:CHOICES_SHOWN], *more], open_choice


def read_command(folder, work_root=None, child=""):
    """The command an agent runs as its own call to read a work node's intent. Every actual path in it (this script, the
    root it may ascend to, the folder) is quoted here, exactly once; child is literal text such as the /<mission>
    placeholder the agent fills in."""
    extra_root = f" --work-root {shlex.quote(str(work_root))}" if work_root else ""
    return (f"python3 {shlex.quote(str(Path(__file__).resolve()))} --trees work --packet{extra_root} "
            f"--work-start {shlex.quote(str(folder))}{child}")


def work_start_route(missions_root, work_root=None):
    return ["Then read that mission's current intent as text:", f"  {read_command(missions_root, work_root, '/<mission>')}"]


def selected_project_missions(entry, project):
    """The daemon's listing of the selected project's missions, used only when its missions root is inside that project."""
    if not isinstance(entry, dict) or not isinstance(entry.get("missionsRoot"), str) or not entry["missionsRoot"]:
        return None
    names = entry.get("names")
    if not isinstance(names, list) or not all(isinstance(name, str) for name in names):
        return None
    missions_root = Path(entry["missionsRoot"]).expanduser().resolve()
    if not under_root(missions_root, Path(project).expanduser().resolve()):
        return None
    return {"project": str(entry.get("project") or Path(project).name), "missionsRoot": str(missions_root),
            "names": names, "truncated": bool(entry.get("truncated"))}


def render_candidates(evidence, root, depth, failures, extra_roots=(), project=None, project_unknown=None):
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
        start = Path(only["workNodePath"])
        traced = render_work(start, work_root_for(start, root, extra_roots), depth, failures, packet=True)
        head, _, rest = traced.partition("\n")
        return "\n".join([head, *notes, rest])
    held_trace, held_choices, _ = (held_context(evidence, root, depth, failures, extra_roots, packet=True)
                                   if not candidates and not unknown else (None, [], False))
    if held_trace:
        return held_trace

    missions_root = evidence.get("missionsRoot") or str(root / "missions")
    names = evidence.get("missionsOnHost") or []
    names_cut = evidence.get("missionsOnHostTruncated")
    listing = "Missions on this host"
    project_root = None
    # Orienting from the selected project, name its missions under its own root, not workspace.root's. A daemon that
    # predates the field, or an entry whose root isn't inside this project, keeps workspace.root's listing.
    selected = (selected_project_missions(evidence.get("projectMissions"), project)
                if not candidates and not unknown and project else None)
    if selected:
        missions_root, names, names_cut = selected["missionsRoot"], selected["names"], selected["truncated"]
        listing = f"Missions in the selected project ({selected['project']})"
        # The next call is the agent's own, with none of this run's --work-root: name the project root so it can ascend.
        project_root = Path(project).expanduser().resolve()
    output = ["## WORK — name it"]
    if not candidates and not unknown:
        output.append(NOTHING_IN_PROGRESS)
        output.extend(held_choices)
    elif len(candidates) > 1:
        output.append(f"{len(candidates)} candidates are in flight. Say which mission you are actually working on.")
    else:
        output.append("The queue evidence does not settle your work. Confirm a candidate or name your mission.")
    if candidates:
        output.append("Candidates (evidence, not a verdict; none is adopted for you):")
        output.extend(candidate_line(candidate) for candidate in candidates)
    if unknown:
        output.append("In-progress rows the queue cannot place:")
        for row in unknown:
            (summary,), pointer = row_fields(row, ("summary", "no summary"))
            output.append(f"- {row.get('qitemId') or 'a row'} — {summary}: {row.get('reason')}{pointer}")
    if not candidates and names:
        output.append(f"{listing}: " + ", ".join(names) + (", …" if names_cut else ""))
    output.extend(work_start_route(missions_root, project_root))
    # Nothing in progress: orient from the seat's selected project, which may live outside
    # workspace.root (#3320), or say why none was selected. Held and next work stay evidence only.
    orient_root = root
    if not candidates and not unknown and project:
        orient_root = Path(project).expanduser().resolve()
    elif not candidates and not unknown and project_unknown:
        output.append(f"PROJECT UNSELECTED — {project_unknown}; showing the work root instead")
    orientation = render_work(orient_root, orient_root, "light", failures, packet=True)
    _, _, rest = orientation.partition("\n")
    heading = ("the selected project's chain, not your work" if orient_root is not root
               else "the project-level chain, not your work")
    output.append(f"\n## ORIENTATION — {heading}\n" + rest.lstrip("\n"))
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
    parser.add_argument("--work-root", action="append", default=[], help="an extra root the work trace may ascend to, for a catalogued project outside workspace.root; repeatable (also OPENRIG_REFOCUS_WORK_ROOT, separated by the OS path separator)")
    parser.add_argument("--work-project", help="the root of the project selected for this seat (as work-install selects it); the broad orientation when there is no current typed baton")
    parser.add_argument("--work-project-unknown", help="why no single project was selected for this seat")
    parser.add_argument("--work-basis", help="the daemon's reason no current work node was named")
    parser.add_argument("--work-unknown", help="why the current work node could not be read")
    parser.add_argument("--unresolved-work-advisory", action="store_true", help="show unresolved typed work as an advisory with broad orientation")
    parser.add_argument("--work-unknown-timed-out", action="store_true", help="the --work-unknown lookup timed out (a slow daemon); with --unresolved-work-advisory it is an advisory, not a failure")
    parser.add_argument("--check", action="store_true", help="exit nonzero on trace or notes resolution failure; rendered text is unchanged")
    parser.add_argument("--packet", action="store_true", help="carry duties and notes as text by section, with old-notes cues")
    parser.add_argument("--work-candidates", help="labelled work evidence as JSON (a path, or - for stdin), from `rig queue whoami --work-candidates`")
    parser.add_argument("--held-work", help="with --work-basis naming no current baton: the seat's held and pending rows as JSON (a path, or - for stdin), the `heldAndPendingWork` field of `rig queue whoami --json --held-work`; shown as context, never as current work")
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
            extra_roots = extra_work_roots(args.work_root)
            explicit = args.work_start or os.environ.get("OPENRIG_REFOCUS_WORK_NODE")
            evidence = held = None
            if args.work_candidates:
                evidence, error = read_candidates(args.work_candidates)
                if error:
                    sections.append(gap(f"## WORK TRACE\nTRACE GAP — {error}"))
            elif args.held_work and not explicit and args.work_basis == NO_CURRENT_BATON_BASIS:
                held, error = read_candidates(args.held_work)
                if error:
                    sections.append(gap(f"## WORK TRACE\nTRACE GAP — held and pending {error}"))
            # Nothing in progress: held and pending work as context, traced when it settles one mission, else listed
            # for the agent to choose from above the broad orientation below.
            held_trace, held_choices, open_choice = (held_context(held, root, args.depth, failures, extra_roots, args.packet)
                                                     if held else (None, [], False))
            if held_choices:
                # Each choice with a folder carries its own command; the generic one is only for a mission without one.
                generic = work_start_route(held.get("missionsRoot") or str(root / "missions")) if open_choice else []
                sections.append("\n".join(["## WORK — name it", NOTHING_IN_PROGRESS, *held_choices, *generic]))
            if explicit:
                sections.append(render_work(Path(explicit), work_root_for(explicit, root, extra_roots), args.depth, failures, packet=args.packet))
            elif evidence is not None:
                sections.append(render_candidates(evidence, root, args.depth, failures, extra_roots,
                                                  project=args.work_project, project_unknown=args.work_project_unknown))
            elif args.work_candidates:
                pass  # the unreadable-evidence gap above is the answer; never fall back to the root
            elif held_trace:
                sections.append(held_trace)
            elif args.work_basis == NO_CURRENT_BATON_BASIS and args.work_project:
                # The seat's selected project, which may live outside workspace.root (#3320).
                project = Path(args.work_project).expanduser().resolve()
                sections.append(render_work(project, project, args.depth, failures, packet=args.packet, fallback=(
                    f"no current typed baton ({args.work_basis}). Showing the selected project's chain from its root: "
                    "a broad orientation, not evidence of a current mission")))
            elif args.work_basis == NO_CURRENT_BATON_BASIS:
                unselected = (f"\nPROJECT UNSELECTED — {args.work_project_unknown}; showing the work root instead"
                              if args.work_project_unknown else "")
                sections.append(render_work(root, root, args.depth, failures, packet=args.packet, fallback=(
                    f"no current typed baton ({args.work_basis}). Showing the project-level chain from the work root: "
                    "a broad orientation, not evidence of a current mission" + unselected)))
            elif args.unresolved_work_advisory and args.work_basis and args.work_basis.startswith("typed work did not resolve: "):
                sections.append(f"## WORK TRACE\nTRACE GAP — no single current work node: {args.work_basis}")
                sections.append(render_work(root, root, args.depth, failures, packet=args.packet, fallback=(
                    "typed work could not be resolved. Showing the project-level chain from the work root: "
                    "a broad orientation, not evidence of a current mission")))
            elif args.work_basis:
                sections.append(gap(f"## WORK TRACE\nTRACE GAP — no single current work node: {args.work_basis}"))
            elif args.unresolved_work_advisory and args.work_unknown and args.work_unknown_timed_out:
                # A lookup that timed out says nothing about this seat's work: name it, orient broadly, and don't fail --check.
                sections.append(f"## WORK TRACE\nTRACE GAP — current work node UNKNOWN: {args.work_unknown}")
                sections.append(render_work(root, root, args.depth, failures, packet=args.packet, fallback=(
                    "the work lookup timed out, which says nothing about this seat's work. Showing the project-level chain "
                    "from the work root: a broad orientation, not evidence of a current mission")))
            elif args.work_unknown:
                sections.append(gap(f"## WORK TRACE\nTRACE GAP — current work node UNKNOWN: {args.work_unknown}"))
            else:
                start = derive_work_start(root)
                sections.append(render_work(start, root, args.depth, failures, packet=args.packet) if start else
                                gap("## WORK TRACE\nTRACE GAP — current work node is unresolved; pass --work-start with a literal absolute path (or configure OPENRIG_REFOCUS_WORK_NODE separately)"))
            held_and_next = render_held_and_next(evidence or held) if evidence or held else ""
            if held_and_next:
                sections.append(held_and_next)

    print("\n\n".join(sections))
    return 1 if args.check and failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
