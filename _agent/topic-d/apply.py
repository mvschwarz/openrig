#!/usr/bin/env python3
"""Apply Topic D extract: reassemble chunks, copy staged files, patch wiring."""
from __future__ import annotations

import base64
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AGENT = Path(__file__).resolve().parent
FILES_DIR = AGENT / "files"
PATCH_DIR = AGENT / "patches"
CHUNKS_DIR = AGENT / "chunks"


def reassemble_chunks() -> int:
    manifest_path = CHUNKS_DIR / "manifest.json"
    if not manifest_path.is_file():
        return 0
    manifest = json.loads(manifest_path.read_text() or "{}")
    if not manifest:
        print("chunk manifest empty; skip")
        return 0
    n = 0
    for rel, meta in manifest.items():
        parts = meta["parts"]
        missing = [p for p in parts if not (CHUNKS_DIR / p).is_file()]
        if missing:
            print(f"skip incomplete chunks for {rel}: {missing}")
            continue
        b64 = "".join((CHUNKS_DIR / p).read_text().strip() for p in parts)
        data = base64.b64decode(b64)
        expect = meta.get("sha256")
        if expect:
            got = hashlib.sha256(data).hexdigest()
            if got != expect:
                raise SystemExit(f"sha256 mismatch for {rel}: {got} != {expect}")
        dest = ROOT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        print(f"chunk {rel} ({len(data)} bytes)")
        n += 1
    return n


def copy_staged_files() -> int:
    if not FILES_DIR.is_dir():
        return 0
    n = 0
    for src in sorted(FILES_DIR.iterdir()):
        if not src.is_file():
            continue
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
        # Exit 1 with "previously applied" / "Skipping" is OK under --forward.
        proc = subprocess.run(
            ["patch", "-p1", "--forward", "--batch", "-i", str(patch)],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        if proc.returncode not in (0, 1):
            raise SystemExit(f"patch failed for {patch.name}: exit {proc.returncode}")
        # returncode 1 with rejects that are NOT "Skipping" means a real conflict
        if proc.returncode == 1 and "Skipping" not in proc.stdout and "Skipping" not in proc.stderr:
            if "FAILED" in proc.stdout or "FAILED" in proc.stderr or ".rej" in proc.stdout:
                # previously-applied also writes .rej under some patch versions; allow if Skipping
                if "previously applied" not in proc.stdout and "previously applied" not in proc.stderr:
                    raise SystemExit(f"patch conflict for {patch.name}\n{proc.stdout}\n{proc.stderr}")
    return len(patches)


def main() -> int:
    n_chunks = reassemble_chunks()
    n_files = copy_staged_files()
    n_patches = apply_patches()
    print(f"ok chunks={n_chunks} files={n_files} patches={n_patches}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
