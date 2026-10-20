#!/usr/bin/env python3
"""Apply Topic D extract: copy staged files + patch large wiring (MCP-friendly)."""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENT = Path(__file__).resolve().parent
FILES_DIR = AGENT / "files"
PATCH_DIR = AGENT / "patches"


def copy_staged_files() -> int:
    if not FILES_DIR.is_dir():
        return 0
    n = 0
    for src in sorted(FILES_DIR.iterdir()):
        if not src.is_file():
            continue
        # packages__daemon__src__domain__x.ts -> packages/daemon/src/domain/x.ts
        rel = src.name.replace("__", "/")
        dest = ROOT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        print(f"copy {rel}")
        n += 1
    return n


def apply_patches() -> int:
    if not PATCH_DIR.is_dir():
        return 0
    patches = sorted(PATCH_DIR.glob("*.patch"))
    for patch in patches:
        print(f"apply {patch.name}")
        subprocess.check_call(
            ["patch", "-p1", "--forward", "--batch", "-i", str(patch)],
            cwd=ROOT,
        )
    return len(patches)


def main() -> int:
    n_files = copy_staged_files()
    n_patches = apply_patches()
    if n_files == 0 and n_patches == 0:
        print("nothing to apply", file=sys.stderr)
        return 1
    print(f"ok files={n_files} patches={n_patches}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
