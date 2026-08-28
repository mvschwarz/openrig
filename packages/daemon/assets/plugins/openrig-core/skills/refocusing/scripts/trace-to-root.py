#!/usr/bin/env python3
"""Render topology and work context by ascending directory paths only."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

SHELVES = {"rigs", "pods", "seats", "missions", "slices"}


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


def render_topology(start, root, depth):
    output = ["## TOPOLOGY TRACE", f"root: {root}", f"start: {start}"]
    nodes, error = ascent(start, root)
    if error:
        return "\n".join(output + [f"TRACE GAP — {error}"])
    for node in nodes:
        chain_file = node / "LEARNED.md"
        text = read(chain_file)
        label = node.relative_to(root) or Path(".")
        if text is None:
            output.append(f"\n### {label}\nMISSING LINK — {chain_file}")
            continue
        body = text.strip() if depth == "full" else light_learned(text)
        output.append(f"\n### {label} · LEARNED.md\n{body}")
    return "\n".join(output)


def render_work(start, root, depth):
    output = ["## WORK TRACE", f"root: {root}", f"start: {start}"]
    nodes, error = ascent(start, root)
    if error:
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
            output.append(f"NOTES RESOLUTION GAP — {resolution_error} at {node}")
        elif notes:
            notes_path, notes_name = notes
            if depth == "full":
                notes_text = read(notes_path)
                if notes_text is None:
                    output.append(f"NOTES RESOLUTION GAP — resolved {notes_name} became unreadable at {notes_path}")
                else:
                    output.append(f"\nNOTES · {notes_name}\n{notes_text.strip()}")
            else:
                try:
                    size = notes_path.stat().st_size
                except OSError:
                    output.append(f"NOTES RESOLUTION GAP — resolved {notes_name} became unreadable at {notes_path}")
                else:
                    output.append(f"NOTES · {notes_name} · {size} bytes · {notes_path}")
        else:
            output.append(f"NOTES GAP — no readable mission notes at {node}")
    return "\n".join(output)


def derive_topology_start(root):
    explicit = os.environ.get("OPENRIG_REFOCUS_TOPOLOGY_NODE")
    if explicit:
        return Path(explicit)
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
    args = parser.parse_args()

    sections = []
    if args.trees in {"topology", "both"}:
        root = configured_root("topology.root", "OPENRIG_TOPOLOGY_ROOT")
        if root is None:
            sections.append("## TOPOLOGY TRACE\nTRACE GAP — topology.root is unresolved")
        else:
            start = Path(args.topology_start) if args.topology_start else derive_topology_start(root)
            sections.append(render_topology(start, root, args.depth) if start else
                            "## TOPOLOGY TRACE\nTRACE GAP — current topology node is unresolved; set OPENRIG_REFOCUS_TOPOLOGY_NODE")

    if args.trees in {"work", "both"}:
        root = configured_root("workspace.root", "OPENRIG_WORKSPACE_ROOT")
        if root is None:
            sections.append("## WORK TRACE\nTRACE GAP — workspace.root is unresolved")
        else:
            start = Path(args.work_start) if args.work_start else derive_work_start(root)
            sections.append(render_work(start, root, args.depth) if start else
                            "## WORK TRACE\nTRACE GAP — current work node is unresolved; set OPENRIG_REFOCUS_WORK_NODE")

    print("\n\n".join(sections))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
