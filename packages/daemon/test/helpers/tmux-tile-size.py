# A private tmux server and real PTYs only: no OpenRig daemon, agents or desktop.
# argv: the shell to run the tile script with, then the writable and read-only tile argvs (JSON).
import fcntl
import json
import os
import pty
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time

shell, writable, readonly = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
tmux = shutil.which("tmux")

# Wider than any tile below, so a tile that attached would show only the start of it.
LINE = "START " + " ".join(str(i) for i in range(1, 45)) + " END"
# A rule as wide as the seat's window, as Claude Code draws them.
RULE = "\u2500" * 160


class Server:
    def __init__(self, root, name):
        self.socket = root + "/" + name
        self.env = {"HOME": root, "TMPDIR": root, "PATH": os.environ["PATH"], "TERM": "xterm-256color", "LC_ALL": "C"}
        self.clients = []
        self.output = {}

    def call(self, *args):
        return subprocess.check_output([tmux, "-S", self.socket, *args], env=self.env,
                                       stderr=subprocess.PIPE, text=True, timeout=3).strip()

    def start_seat(self, command=None):
        self.call("-f", "/dev/null", "new-session", "-d", "-x", "160", "-y", "20", "-s", "seat",
                  command or "printf \"%s\\n%s\\n\" \"" + LINE + "\" \"" + RULE + "\"; exec cat")
        self.call("set-option", "-g", "status", "off")
        self.call("set-option", "-g", "window-size", "latest")
        self.call("set-environment", "-t", "seat", "OPENRIG_NODE_ID", "tile-fixture")
        if not command:
            self.wait_for(lambda: LINE in self.seat_screen(), "the seat must print its line")

    def tile(self, argv, columns, rows):
        argv = [self.socket if arg == "TILE_SOCKET" else arg for arg in argv]
        if argv[0] == "/bin/sh":
            argv[0] = shell
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

        def terminal():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            # As in a real terminal pane: a test runner may hand its children Ctrl-C ignored.
            signal.signal(signal.SIGINT, signal.SIG_DFL)
        process = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, env=self.env,
                                   preexec_fn=terminal, close_fds=True)
        os.set_blocking(master, False)
        client = (process, master, slave, os.ttyname(slave))
        self.clients.append(client)
        self.output[master] = b""
        return client

    def drain(self):
        for process, master, slave, tty in self.clients:
            try:
                while True:
                    chunk = os.read(master, 65536)
                    if not chunk:
                        break
                    self.output[master] += chunk
            except (BlockingIOError, OSError):
                pass

    def seen(self, client):
        self.drain()
        return self.output[client[1]].decode("utf-8", "replace")

    def geometry(self):
        return self.call("display-message", "-p", "-t", "seat:", "#{window_width}x#{window_height}")

    def client_ttys(self):
        return [line for line in self.call("list-clients", "-F", "#{client_tty}").splitlines() if line]

    def seat_screen(self):
        return self.call("capture-pane", "-p", "-J", "-t", "seat:")

    def wait_for(self, predicate, expected, seconds=6, detail=None):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.drain()
            if predicate():
                return
            time.sleep(0.05)
        raise AssertionError(expected + "; window=" + self.geometry() + "; clients=" + repr(self.client_ttys())
                             + ("; " + detail() if detail else ""))

    def stop(self):
        try:
            self.call("kill-server")
        except subprocess.CalledProcessError:
            pass
        for process, master, slave, tty in self.clients:
            os.close(master)
            os.close(slave)
        for process, master, slave, tty in self.clients:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=3)
        return all(process.poll() is not None for process, *_ in self.clients)


def cell(root, name, body, command=None):
    server = Server(root, name)
    try:
        server.start_seat(command(server) if command else None)
        return body(server)
    finally:
        assert server.stop(), name + ": every tile and client must exit"


def read_only_alone(server):
    tile = server.tile(readonly, 40, 30)
    server.wait_for(lambda: LINE in server.seen(tile), "a read-only tile shows the whole line")
    # The tile is no client of the seat, so the seat keeps its own size.
    assert server.client_ttys() == [], "a read-only tile must not attach"
    assert server.geometry() == "160x20", "a read-only tile must not resize the seat"
    # The seat's rule is cut to the tile's 40 columns rather than wrapped over four rows.
    assert "\u2500" * 40 + "\r\n" in server.seen(tile) and "\u2500" * 41 not in server.seen(tile), "a rule fits the tile"
    before = len(server.seen(tile))
    server.call("send-keys", "-t", "seat:", "-l", "MARK-NEW-OUTPUT")
    server.wait_for(lambda: "MARK-NEW-OUTPUT" in server.seen(tile)[before:], "new seat output reaches the view")
    # While it shows, a read-only tile's terminal neither echoes keys nor turns Ctrl-C into a signal.
    iflags, flags = termios.tcgetattr(tile[2])[0], termios.tcgetattr(tile[2])[3]
    assert not flags & termios.ECHO and not flags & termios.ISIG, "a read-only tile's terminal must be quiet"
    assert not iflags & termios.IXON, "Ctrl-S must not freeze a read-only tile"
    os.write(tile[1], b"typed")
    time.sleep(1.5)
    assert "typed" not in server.seat_screen(), "keys typed in a read-only tile must not reach the seat"
    assert tile[0].poll() is None, "typing must not end a read-only tile"
    assert server.client_ttys() == [], "a read-only tile must not attach when typed in"
    server.call("kill-session", "-t", "seat")
    server.wait_for(lambda: tile[0].poll() is not None, "a read-only tile ends when its seat goes and none replaces it", 8)
    return {"window": "160x20"}


def read_only_beside_another_client(server):
    other = server.tile([tmux, "-S", server.socket, "attach", "-t", "=seat"], 160, 20)
    server.wait_for(lambda: len(server.client_ttys()) == 1, "the other client attaches")
    tile = server.tile(readonly, 40, 30)
    server.wait_for(lambda: LINE in server.seen(tile), "a read-only tile beside another client shows the whole line")
    assert server.client_ttys() == [other[3]], "only the other client is attached"
    assert server.geometry() == "160x20"
    return {"window": server.geometry()}


with tempfile.TemporaryDirectory(prefix="tile-size-") as temporary:
    print(json.dumps({
        "readOnlyAlone": cell(temporary, "a", read_only_alone),
        "readOnlyBesideAnother": cell(temporary, "b", read_only_beside_another_client),
    }))
