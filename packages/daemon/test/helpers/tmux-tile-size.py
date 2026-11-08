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

    def wait_for(self, predicate, expected, seconds=6):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.drain()
            if predicate():
                return
            time.sleep(0.05)
        raise AssertionError(expected + "; window=" + self.geometry() + "; clients=" + repr(self.client_ttys()))

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


def writable_tile(server):
    tile = server.tile(writable, 40, 30)
    server.wait_for(lambda: LINE in server.seen(tile), "a writable tile shows the whole line before anyone types")
    # Every key is read as a key: no flow control, and no other special handling.
    iflags, flags = termios.tcgetattr(tile[2])[0], termios.tcgetattr(tile[2])[3]
    assert not iflags & termios.IXON and not flags & termios.IEXTEN, "a showing tile must read every key"
    assert server.client_ttys() == [] and server.geometry() == "160x20", "an unused writable tile is no client"
    # The first key reaches the seat, and the tile attaches for the rest.
    os.write(tile[1], b"hello")
    server.wait_for(lambda: server.client_ttys() == [tile[3]], "the first key attaches the tile")
    server.wait_for(lambda: "hello" in server.seat_screen(), "the first key reaches the seat")
    os.write(tile[1], b" world")
    server.wait_for(lambda: "hello world" in server.seat_screen(), "typing in the attached tile reaches the seat")
    # The tile sizes the seat while it's used, as any client the person types in does.
    server.wait_for(lambda: server.geometry() == "40x30", "the tile in use sizes the seat")
    used = server.geometry()
    # Idle for the tile's idle time (2 s here): it detaches back to the view.
    server.wait_for(lambda: server.client_ttys() == [], "an idle tile detaches", 8)
    # After tmux's detach line, the view redraws the seat's screen itself.
    def viewing_again():
        after = server.seen(tile).rpartition("[detached")[2]
        return "\x1b[H\x1b[2J" in after and "hello world" in after.rpartition("\x1b[H\x1b[2J")[2]
    server.wait_for(viewing_again, "the detached tile views the seat again")
    # Enter as the first key goes to the seat, and attaches the tile again.
    os.write(tile[1], b"\r")
    server.wait_for(lambda: server.seat_screen().count("hello world") == 2, "Enter as the first key reaches the seat")
    server.wait_for(lambda: server.client_ttys() == [tile[3]], "the first key attaches the tile again")
    return {"used": used}


def recorder(server):
    # The seat asks for bracketed paste, as Claude Code does, and records every byte it's given, as a raw terminal
    # delivers them.
    return "printf \"\\033[?2004h\"; stty raw -echo; exec dd bs=1 of=" + server.socket + ".got 2>/dev/null"


def received(server):
    try:
        return open(server.socket + ".got", "rb").read()
    except FileNotFoundError:
        return b""


def writable_first_input(server):
    tile = server.tile(writable, 40, 30)
    server.wait_for(lambda: "\x1b[H\x1b[2J" in server.seen(tile), "the tile views the seat")
    # A paste that breaks inside a UTF-8 character, the rest arriving after the break.
    os.write(tile[1], b"A" * 63 + b"\xc3")
    time.sleep(0.3)
    os.write(tile[1], b"\xa9END")
    expected = b"A" * 63 + "\u00e9".encode() + b"END"
    server.wait_for(lambda: received(server) == expected, "the first input reaches the seat byte for byte")
    server.wait_for(lambda: server.client_ttys() == [tile[3]], "the first input attaches the tile")
    server.wait_for(lambda: server.client_ttys() == [], "an idle tile detaches", 8)
    # Ctrl-Space types a NUL.
    os.write(tile[1], b"\x00")
    expected += b"\x00"
    server.wait_for(lambda: received(server) == expected, "a NUL first key reaches the seat")
    server.wait_for(lambda: server.client_ttys() == [tile[3]], "a NUL first key attaches the tile")
    server.wait_for(lambda: server.client_ttys() == [], "an idle tile detaches", 8)
    # tmux's prefix works as in an attached tile: Ctrl-b d detaches at once, and nothing reaches the seat.
    os.write(tile[1], b"\x02d")
    server.wait_for(lambda: "[detached" in server.seen(tile).rpartition("\x1b[?2004h")[0][-400:] or
                    server.seen(tile).count("[detached") >= 3, "Ctrl-b d detaches the tile")
    time.sleep(0.5)
    assert received(server) == expected, "the prefix and its key must not reach the seat: " + repr(received(server)[len(expected):])
    # A paste while showing: the tile's terminal frames it only if the tile asked for that, as a terminal does.
    server.wait_for(lambda: server.seen(tile).rfind("\x1b[?2004h") > server.seen(tile).rfind("[detached"), "the tile shows again")
    framed = server.seen(tile).rfind("\x1b[?2004h") > server.seen(tile).rfind("\x1b[?2004l")
    paste = b"first line\rsecond line"
    os.write(tile[1], b"\x1b[200~" + paste + b"\x1b[201~" if framed else paste)
    expected += b"\x1b[200~" + paste + b"\x1b[201~"
    server.wait_for(lambda: received(server) == expected, "a paste reaches the seat as one paste")
    server.wait_for(lambda: server.client_ttys() == [], "an idle tile detaches", 8)
    # Ctrl-S and Ctrl-Q are keys like any other.
    os.write(tile[1], b"\x13\x11")
    expected += b"\x13\x11"
    server.wait_for(lambda: received(server) == expected, "Ctrl-S and Ctrl-Q reach the seat")
    server.wait_for(lambda: server.client_ttys() == [tile[3]], "Ctrl-S and Ctrl-Q attach the tile")
    server.wait_for(lambda: server.client_ttys() == [], "an idle tile detaches", 8)
    # A key and, at once, a paste: the paste is still framed, and both arrive in order.
    server.wait_for(lambda: server.seen(tile).rfind("\x1b[?2004h") > server.seen(tile).rfind("[detached"), "the tile shows again")
    os.write(tile[1], b"A")
    time.sleep(0.03)
    framed = server.seen(tile).rfind("\x1b[?2004h") > server.seen(tile).rfind("\x1b[?2004l")
    os.write(tile[1], b"\x1b[200~" + paste + b"\x1b[201~" if framed else paste)
    expected += b"A\x1b[200~" + paste + b"\x1b[201~"
    server.wait_for(lambda: received(server) == expected, "a key then a paste arrive in order, the paste framed")
    server.wait_for(lambda: server.client_ttys() == [], "an idle tile detaches", 8)
    # A run of text that ends in ; keeps it, through the client and before a paste alike.
    os.write(tile[1], b"ls;\r")
    expected += b"ls;\r"
    server.wait_for(lambda: received(server) == expected, "a trailing ; reaches the seat")
    server.wait_for(lambda: server.client_ttys() == [], "an idle tile detaches", 8)
    server.wait_for(lambda: server.seen(tile).rfind("\x1b[?2004h") > server.seen(tile).rfind("[detached"), "the tile shows again")
    os.write(tile[1], b"x;\x1b[200~" + paste + b"\x1b[201~")
    expected += b"x;\x1b[200~" + paste + b"\x1b[201~"
    server.wait_for(lambda: received(server) == expected, "a trailing ; before a paste reaches the seat")
    server.wait_for(lambda: server.client_ttys() == [], "an idle tile detaches", 8)
    # An arrow as the first key reaches the agent as typed.
    os.write(tile[1], b"\x1b[A")
    expected += b"\x1b[A"
    server.wait_for(lambda: received(server) == expected, "Up as the first key reaches the seat as Up")
    server.wait_for(lambda: server.client_ttys() == [], "an idle tile detaches", 8)
    # The prefix, then PgUp as a person types them: tmux scrolls back, and nothing reaches the seat.
    os.write(tile[1], b"\x02")
    server.wait_for(lambda: server.client_ttys() == [tile[3]], "the prefix attaches the tile")
    os.write(tile[1], b"\x1b[5~")
    server.wait_for(lambda: server.call("display-message", "-p", "-t", "seat:", "#{pane_in_mode}") == "1", "Ctrl-b PgUp opens copy mode")
    os.write(tile[1], b"q")
    server.wait_for(lambda: server.call("display-message", "-p", "-t", "seat:", "#{pane_in_mode}") == "0", "q leaves copy mode")
    time.sleep(0.3)
    assert received(server) == expected, "Ctrl-b PgUp must not type into the seat: " + repr(received(server)[len(expected):])
    return {"bytes": len(received(server))}


def writable_big_paste(server):
    tile = server.tile(writable, 40, 30)
    server.wait_for(lambda: "\x1b[?2004h" in server.seen(tile), "the tile frames pastes while it shows")
    # A paste of about 450 KB, framed as a terminal frames it, written as fast as the tile reads it.
    data = b"\x1b[200~" + b"".join(b"line %06d of a long paste\r" % i for i in range(16000)) + b"\x1b[201~"
    sent, deadline = 0, time.monotonic() + 90
    while sent < len(data):
        try:
            sent += os.write(tile[1], data[sent:sent + 4096])
        except BlockingIOError:
            time.sleep(0.002)
        server.drain()
        assert time.monotonic() < deadline, "the tile must keep reading the paste"
    server.wait_for(lambda: received(server) == data, "a paste over 256 KiB reaches the seat whole and framed", 90)
    server.wait_for(lambda: server.client_ttys() == [], "the tile detaches when idle after the paste", 10)
    return {"bytes": len(data)}


def writable_first_input_window(server):
    # The attach is slowed to a second, so keys typed after the first burst land before tmux takes the terminal.
    slow = server.socket + ".slow-tmux"
    open(slow, "w").write("#!/bin/sh\ncase \" $* \" in *\" attach \"*) sleep 1;; esac\nexec " + tmux + " \"$@\"\n")
    os.chmod(slow, 0o700)
    argv = list(writable)
    argv[5] = slow
    tile = server.tile(argv, 40, 30)
    server.wait_for(lambda: "\x1b[H\x1b[2J" in server.seen(tile), "the tile views the seat")
    os.write(tile[1], b"y")
    time.sleep(0.5)
    # Enter and Ctrl-C, before the attach completes.
    os.write(tile[1], b"\r\x03")
    server.wait_for(lambda: received(server) == b"y\r\x03", "Enter and Ctrl-C before the attach reach the seat as typed")
    assert tile[0].poll() is None, "Ctrl-C before the attach must not end the tile"
    return {"bytes": len(received(server))}


with tempfile.TemporaryDirectory(prefix="tile-size-") as temporary:
    root = os.path.realpath(temporary)
    if sys.argv[4:] == ["big-paste"]:
        print(json.dumps({"bigPaste": cell(root, "f", writable_big_paste, recorder)}))
        sys.exit(0)
    result = {
        "readOnlyAlone": cell(root, "a", read_only_alone),
        "readOnlyBesideAnother": cell(root, "b", read_only_beside_another_client),
        "writable": cell(root, "c", writable_tile),
        "firstInput": cell(root, "d", writable_first_input, recorder),
        "firstInputWindow": cell(root, "e", writable_first_input_window, recorder),
    }
    print(json.dumps(result))
