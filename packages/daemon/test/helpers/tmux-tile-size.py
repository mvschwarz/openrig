# A private tmux server and real PTYs only: no OpenRig daemon, agents or desktop.
import fcntl
import json
import os
import pty
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time

writable, readonly = json.loads(sys.argv[1]), json.loads(sys.argv[2])
tmux = shutil.which("tmux")
# Honor TMPDIR: CI permits socket connections only inside its isolated IPC root.
with tempfile.TemporaryDirectory(prefix="tile-size-") as temporary:
    root = os.path.realpath(temporary)
    socket = root + "/s"
    env = {"HOME": root, "PATH": os.environ["PATH"], "TERM": "xterm-256color", "LC_ALL": "C"}
    clients = []

    def call(*args):
        return subprocess.check_output([tmux, "-S", socket, *args], env=env,
                                       stderr=subprocess.PIPE, text=True, timeout=3).strip()

    def drain_output():
        for process, master, slave, tty in clients:
            try:
                while os.read(master, 65536):
                    pass
            except (BlockingIOError, OSError):
                pass

    def attach(argv, columns, rows):
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        def terminal():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        process = subprocess.Popen([socket if arg == "TILE_SOCKET" else arg for arg in argv],
                                   stdin=slave, stdout=slave, stderr=slave, env=env,
                                   preexec_fn=terminal, close_fds=True)
        os.set_blocking(master, False)
        client = (process, master, slave, os.ttyname(slave))
        clients.append(client)
        return client

    def geometry():
        return call("display-message", "-p", "-t", "seat:", "#{pane_width}x#{pane_height}")

    def flags(tty):
        for line in call("list-clients", "-F", "#{client_tty}|#{client_flags}").splitlines():
            name, value = line.split("|", 1)
            if name == tty:
                return value
        return None

    def wait_for(predicate, expected):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            drain_output()
            if predicate():
                return
            time.sleep(0.04)
        raise AssertionError(expected + "; actual pane=" + geometry() + "; clients=" +
                             call("list-clients", "-F", "#{client_width}x#{client_height}:#{client_flags}"))

    try:
        call("-f", "/dev/null", "new-session", "-d", "-x", "80", "-y", "24", "-s", "seat", "/bin/sleep 60")
        call("set-option", "-g", "status", "off")
        call("set-option", "-g", "window-size", "latest")
        call("set-environment", "-t", "seat", "OPENRIG_NODE_ID", "tile-fixture")
        attach([tmux, "-S", socket, "attach", "-t", "=seat"], 14, 18)
        wait_for(lambda: geometry() == "14x18", "old sizing client must establish 14x18")
        viewer = attach(writable, 101, 32)
        wait_for(lambda: flags(viewer[3]) is not None, "writable tile must attach")
        wait_for(lambda: geometry() == "101x32", "writable tile must size the pane to 101x32")
        writable_flags = flags(viewer[3])
        assert "ignore-size" not in writable_flags and "read-only" not in writable_flags
        fcntl.ioctl(viewer[2], termios.TIOCSWINSZ, struct.pack("HHHH", 43, 121, 0, 0))
        wait_for(lambda: geometry() == "121x43", "real PTY resize must reach the pane")
        observer = attach(readonly, 111, 44)
        wait_for(lambda: flags(observer[3]) is not None, "read-only observer must attach")
        observer_flags = flags(observer[3])
        assert "read-only" in observer_flags and "ignore-size" in observer_flags
        assert geometry() == "121x43", "read-only observer must not change geometry"
        result = {"initial": "101x32", "resized": geometry(),
                  "writableFlags": writable_flags, "observerFlags": observer_flags}
    finally:
        try:
            call("kill-server")
        except subprocess.CalledProcessError:
            pass
        for process, master, slave, tty in clients:
            os.close(master)
            os.close(slave)
        for process, master, slave, tty in clients:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=3)
    assert all(process.poll() is not None for process, *_ in clients)
    result["clientsReaped"] = len(clients)
    print(json.dumps(result))
