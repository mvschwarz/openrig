#!/usr/bin/env python3
"""Apply Topic C wiring patches to large daemon files (MCP-friendly path)."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATCH_DIR = Path(__file__).resolve().parent / "patches"


def main() -> int:
    patches = sorted(PATCH_DIR.glob("*.patch"))
    if not patches:
        print("no patches", file=sys.stderr)
        return 1
    for patch in patches:
        print(f"apply {patch.name}")
        subprocess.check_call(
            ["patch", "-p1", "--forward", "--batch", "-i", str(patch)],
            cwd=ROOT,
        )
    print("ok", len(patches), "patches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
