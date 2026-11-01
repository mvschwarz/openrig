#!/usr/bin/env python3
"""OpenRig environment-driver v1 guest operations and bounded Claude startup latch.

Baked into the selected image. No provider credentials, model policy, histories or
work payloads are built into this helper. Native restore belongs to a separate effect.
"""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import subprocess
import signal
import stat
import time
import uuid

LIMIT = 1024 * 1024
DEFAULT_ROOT = "/sandbox/openrig"


class Refused(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe(root, raw):
    root = Path(root)
    path = Path(raw)
    if not root.is_absolute() or root == Path("/") or any(part.is_symlink() for part in (root, *root.parents)):
        raise Refused("environment_root_invalid")
    if not path.is_absolute():
        path = root / path
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        raise Refused("environment_path_outside_root")
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise Refused("environment_path_invalid")
    current = root
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise Refused("environment_symlink")
    return path


def regular(root, raw, limit=LIMIT):
    path = safe(root, raw)
    parts = path.relative_to(root).parts
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in (*Path(root).parts[1:], *parts[:-1]):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
                raise Refused("environment_file_invalid")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                data = stream.read(limit + 1)
            after = os.fstat(fd)
            if len(data) > limit or len(data) != before.st_size or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns:
                raise Refused("environment_file_invalid")
            return data
        finally:
            os.close(fd)
    except FileNotFoundError:
        raise Refused("environment_file_missing")
    except OSError:
        raise Refused("environment_file_invalid")
    finally:
        os.close(directory)


def atomic(root, raw, data):
    path = safe(root, raw)
    path.parent.mkdir(parents=True, exist_ok=True)
    safe(root, path)
    temp = path.parent / (".openrig-" + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def descriptor(root, pending=False):
    name = "control/launch.pending.json" if pending else "control/launch.json"
    value = json.loads(regular(root, name))
    if value.get("version") != 1 or not value.get("generation") or not value.get("bindingId"):
        raise Refused("environment_descriptor_invalid")
    for file in value["files"]:
        data = regular(root, file["path"])
        if len(data) != file["bytes"] or digest(data) != file["sha256"]:
            raise Refused("environment_projection_changed")
    # P1-P3 never silently replace a requested native conversation with a fresh one.
    if value.get("resumeToken"):
        if value.get("nativeType") != "community:openshell-claude" or value["resumeToken"] != value["nativeId"]:
            raise Refused("environment_native_identity_invalid")
        checkpoint = value.get("checkpoint", {})
        files = checkpoint.get("files", []) if isinstance(checkpoint, dict) else []
        if not isinstance(files, list) or not 1 <= len(files) <= 129:
            raise Refused("environment_checkpoint_invalid")
        history = [file for file in files if file.get("path", "").startswith("native/projects/")]
        if len(history) != 1 or not history[0]["path"].endswith("/" + value["nativeId"] + ".jsonl"):
            raise Refused("environment_checkpoint_identity_mismatch")
        if checkpoint.get("nativeId") != value["nativeId"] or checkpoint.get("nativeType") != value["nativeType"]:
            raise Refused("environment_checkpoint_identity_mismatch")
        for file in files:
            data = regular(root, file["path"])
            if digest(data) != file["sha256"] or len(data) != file["bytes"]:
                raise Refused("environment_checkpoint_changed")
            if not file["path"].startswith("native/projects/"):
                continue
            rows = [json.loads(line) for line in data.decode().splitlines()]
            if not any(row.get("sessionId") == value["nativeId"] and row.get("type") in ("user", "assistant") for row in rows):
                raise Refused("environment_checkpoint_identity_mismatch")
            if any(row.get("sessionId", value["nativeId"]) != value["nativeId"] for row in rows):
                raise Refused("environment_checkpoint_identity_mismatch")
        if not checkpoint.get("files"):
            raise Refused("environment_checkpoint_missing")
    if not re.fullmatch(r"[0-9a-f-]{36}", value["nativeId"]):
        raise Refused("environment_native_identity_invalid")
    return value


def launch(root):
    deadline = time.monotonic() + 600
    while not safe(root, "control/launch.json").exists():
        if time.monotonic() >= deadline:
            raise Refused("environment_preparation_expired")
        time.sleep(.2)
    value = descriptor(root)
    fd = os.open(safe(root, "control/native.lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(Path(root) / "native"),
           "CLAUDE_CONFIG_DIR": str(Path(root) / "native")}
    secret = json.loads(regular(root, "control/activity.json"))
    allowed = {"OPENRIG_URL", "OPENRIG_ACTIVITY_HOOK_TOKEN", "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_OCCUPANT_GENERATION"}
    if set(secret) != allowed or secret["OPENRIG_OCCUPANT_GENERATION"] != value["generation"]:
        raise Refused("environment_activity_projection_invalid")
    env.update(secret)
    env.update({"DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "OPENRIG_RUNTIME": "openshell-claude", "OPENRIG_NODE": "/usr/bin/node",
                "OPENRIG_ENVIRONMENT_BINDING": value["bindingId"]})
    if safe(root, "control/provider-api-ref").exists():
        atomic(root, "native/settings.json", json.dumps({"apiKeyHelper": "cat /sandbox/openrig/control/provider-api-ref"}).encode())
    # Provider-owned injection may supply these native endpoint references. No host environment is copied.
    for name in ("ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"):
        if name in os.environ:
            env[name] = os.environ[name]
    argv = ["/usr/local/bin/claude", "--resume" if value.get("resumeToken") else "--session-id", value["nativeId"], "--strict-mcp-config", "--mcp-config", str(safe(root, "control/coordination.json"))]
    for plugin in value.get("plugins", []):
        argv.extend(["--plugin-dir", str(safe(root, plugin))])
    if value.get("model"):
        argv.extend(["--model", value["model"]])
    if value.get("effort"):
        argv.extend(["--effort", value["effort"]])
    if value.get("permissionMode"):
        argv.extend(["--permission-mode", value["permissionMode"]])
    work = safe(root, "work")
    work.mkdir(exist_ok=True)
    os.chdir(work)
    child = subprocess.Popen(argv, env=env, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr)
    started = process_start(child.pid)
    atomic(root, "control/native.json", json.dumps({"nativeId": value["nativeId"], "generation": value["generation"], "pid": child.pid, "started": started}).encode())
    code = child.wait()
    atomic(root, "control/native-exit.json", json.dumps({"nativeId": value["nativeId"], "generation": value["generation"], "pid": child.pid, "exitCode": code}).encode())
    # Keep bounded file/control access after native exit, so checkpoint/export do not depend on a live model.
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        time.sleep(1)


def process_start(pid):
    raw = (Path("/proc") / str(pid) / "stat").read_text()
    return raw[raw.rfind(")") + 2:].split()[19]


def native_identity(root):
    value = json.loads(regular(root, "control/native.json"))
    try:
        if process_start(value["pid"]) != value["started"]:
            raise Refused("environment_native_changed")
        fields = (Path("/proc") / str(value["pid"]) / "cmdline").read_bytes().split(b"\0")
        if value["nativeId"].encode() not in fields or not any(b"claude" in field for field in fields):
            raise Refused("environment_native_changed")
        return {"ok": True, **value, "running": True}
    except FileNotFoundError:
        exit_record = json.loads(regular(root, "control/native-exit.json"))
        if any(exit_record.get(key) != value.get(key) for key in ("nativeId", "generation", "pid")):
            raise Refused("environment_native_unconfirmed")
        return {"ok": True, **value, "running": False, "exitCode": exit_record["exitCode"]}



def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", default=DEFAULT_ROOT)
    for option in ("read", "stat", "stage", "install"):
        p.add_argument("--" + option)
    p.add_argument("--destination")
    p.add_argument("--previous")
    p.add_argument("--mode", choices=("0600", "0700"), default="0600")
    p.add_argument("--prepare", action="store_true")
    p.add_argument("--identity", action="store_true")
    p.add_argument("--stop-native")
    p.add_argument("--generation")
    p.add_argument("--checkpoint-files", action="store_true")
    args = p.parse_args()
    root = Path(args.root)
    if not root.is_absolute() or any(part.is_symlink() for part in (root, *root.parents)):
        raise Refused("environment_root_invalid")
    root.mkdir(parents=True, exist_ok=True)
    if args.stage:
        path = safe(root, args.stage)
        if path.exists():
            raise Refused("environment_stage_exists")
        path.parent.mkdir(parents=True, exist_ok=True)
        return {"ok": True}
    if args.read or args.stat:
        data = regular(root, args.read or args.stat)
        return {"ok": True, "sha256": digest(data), "bytes": len(data),
                **({"base64": base64.b64encode(data).decode()} if args.read else {})}
    if args.install:
        data = regular(root, args.install)
        destination = safe(root, args.destination)
        if destination.exists():
            if args.previous == "missing" or digest(regular(root, destination)) != args.previous:
                raise Refused("environment_projection_conflict")
        elif args.previous != "missing":
            raise Refused("environment_projection_changed")
        atomic(root, destination, data)
        os.chmod(destination, int(args.mode, 8))
        safe(root, args.install).unlink()
        return {"ok": True, "sha256": digest(data), "bytes": len(data)}
    if args.prepare:
        value = descriptor(root, pending=True)
        encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        published = safe(root, "control/launch.json")
        if published.exists():
            if regular(root, published) != encoded:
                raise Refused("environment_native_already_selected")
            return {"ok": True, "generation": value["generation"], "nativeId": value["nativeId"]}
        # This is the guest provider's injected reference, never an owner-host environment value.
        reference = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("CLAUDE_API_KEY")
        if not reference:
            raise Refused("environment_provider_reference_missing")
        atomic(root, "control/provider-api-ref", reference.encode())
        Path(root, "native").mkdir(exist_ok=True)
        atomic(root, "control/launch.json", encoded)
        return {"ok": True, "generation": value["generation"], "nativeId": value["nativeId"]}
    if args.identity:
        return native_identity(root)
    if args.stop_native:
        value = native_identity(root)
        if value["nativeId"] != args.stop_native or value["generation"] != args.generation:
            raise Refused("environment_native_changed")
        if value["running"]:
            os.kill(value["pid"], signal.SIGTERM)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                try:
                    if not native_identity(root)["running"]:
                        break
                except (Refused, OSError):
                    pass
                time.sleep(.1)
        return {"ok": True, "signal": "TERM", "nativeId": value["nativeId"], "generation": value["generation"]}
    if args.checkpoint_files:
        value = native_identity(root)
        relative = "native/projects/-sandbox-openrig-work/" + value["nativeId"] + ".jsonl"
        data = regular(root, relative)
        # A running writer's trailing partial record is not a checkpoint; retry after it settles.
        if not data.endswith(b"\n"):
            raise Refused("environment_checkpoint_incomplete")
        return {"ok": True, "files": [{"path": relative, "bytes": len(data), "sha256": digest(data)}]}
    launch(root)


if __name__ == "__main__":
    try:
        result = main()
        if result is not None:
            print(json.dumps(result))
    except (Refused, ValueError, KeyError, OSError) as error:
        print(json.dumps({"ok": False, "code": str(error) if isinstance(error, Refused) else "environment_guest_unconfirmed"}))
