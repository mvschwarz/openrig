# Shipped tile argv in real PTYs on an isolated tmux server; no desktop or agent process.
import fcntl, json, os, pty, shutil, signal, struct, subprocess, sys, tempfile, termios, time

argv = json.loads(sys.argv[1])
root = tempfile.mkdtemp(prefix="tile-reflow-")
sock = os.path.join(root, "server")
env = dict(os.environ, TERM="xterm-256color")
env.pop("TMUX", None)
clients = []

def call(*args):
    return subprocess.check_output(["tmux", "-S", sock, *args], env=env, text=True, stderr=subprocess.PIPE, timeout=3).strip()

def until(fn, label):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        for proc, master, slave in clients:
            try:
                while os.read(master, 65536): pass
            except (BlockingIOError, OSError): pass
        if fn(): return
        time.sleep(.04)
    raise AssertionError(label + "; actual=" + call("display-message", "-p", "-t", "seat:", "#{window_width}x#{window_height}"))

def tile(cols, rows):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    def setup():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    proc = subprocess.Popen([sock if a == "TILE_SOCKET" else a for a in argv], env=env,
                            stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup)
    os.set_blocking(master, False)
    clients.append((proc, master, slave))
    return clients[-1]

def size(client, cols, rows):
    fcntl.ioctl(client[2], termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.killpg(client[0].pid, signal.SIGWINCH)

def check(cols, rows):
    until(lambda: call("display-message", "-p", "-t", "seat:", "#{window_width}x#{window_height}") == str(cols)+"x"+str(rows), "latest visible client sizes seat")
    until(lambda: "PTY-COLS:"+str(cols) in call("capture-pane", "-p", "-t", "seat:"), "agent PTY observes width")
    screen = call("capture-pane", "-p", "-t", "seat:")
    assert "END-REFLOW" in screen.replace("\n", ""), "full new text must remain readable"
    assert max(map(len, screen.splitlines())) <= cols, "new text wraps to visible columns"
    assert call("show-options", "-w", "-v", "-t", "seat:", "window-size") == "", "no local pin"
    return str(cols)+"x"+str(rows)

try:
    program = os.path.join(root, "app.py")
    received = os.path.join(root, "received")
    with open(program, "w") as f:
        f.write("import os,signal,sys,tty\ntty.setraw(0)\n"+
                "def draw(*_):\n c=os.get_terminal_size().columns\n print('PTY-COLS:'+str(c),flush=True)\n print('BEGIN-REFLOW '+('words '*35)+'END-REFLOW',flush=True)\n"+
                "signal.signal(signal.SIGWINCH,draw)\ndraw()\nprint('\\x1b[?2004h',end='',flush=True)\n"+
                "with open("+repr(received)+",'ab',buffering=0) as out:\n while True:\n  out.write(os.read(0,65536))\n")
    call("-f", "/dev/null", "new-session", "-d", "-s", "seat", "-e", "OPENRIG_NODE_ID=reflow-fixture", "python3 -u "+program)
    call("set-option", "-g", "status", "off")
    phone = tile(40, 24)
    observed = [check(40, 24)]
    laptop = tile(120, 35)
    observed.append(check(120, 35))
    for cols, rows in [(160,45),(52,28),(132,40)]:
        size(laptop, cols, rows)
        observed.append(check(cols, rows))
    os.write(phone[1], b"p")
    observed.append(check(40,24))
    os.write(laptop[1], b"l")
    observed.append(check(132,40))
    def got():
        with open(received, "rb") as f: return f.read()
    until(lambda: got() == b"pl", "normal native input reaches seat")
    # The first burst into a new native client, split inside UTF-8, then arrows and control keys.
    first = tile(132, 40)
    until(lambda: len(call("list-clients", "-F", "#{client_tty}").splitlines()) == 3, "native attach ready")
    os.write(first[1], b"A"*63+b"\xc3")
    time.sleep(.3)
    os.write(first[1], b"\xa9END\x1b[A\x00\x13\x11")
    expected = b"pl"+b"A"*63+b"\xc3\xa9END\x1b[A\x00\x13\x11"
    until(lambda: got() == expected, "first keys arrive byte-for-byte and in order")
    # Native tmux, rather than a custom first-key buffer, carries a framed paste over 256 KiB.
    data = b"\x1b[200~"+b"".join(b"line %06d of a long paste\r" % i for i in range(16000))+b"\x1b[201~"
    sent, deadline = 0, time.monotonic()+30
    while sent < len(data):
        try: sent += os.write(first[1], data[sent:sent+4096])
        except BlockingIOError: time.sleep(.002)
        assert time.monotonic() < deadline, "native paste must keep moving"
    expected += data
    until(lambda: got() == expected, "large paste arrives whole and framed")
    # This is a new keypress after the paste, not part of its sub-millisecond burst.
    # tmux's default assume-paste-time bypasses bindings for such bursts, even on
    # a direct native attach. Respect that fixture option without changing it.
    time.sleep((int(call("show-options", "-gv", "assume-paste-time")) + 20) / 1000)
    os.write(first[1], b"\x02\x1b[5~")
    until(lambda: call("display-message", "-p", "-t", "seat:", "#{pane_in_mode}") == "1", "prefix then PageUp enters native copy mode")
    assert got() == expected, "prefix and PageUp do not reach the agent"
    print(json.dumps({"sizes":observed,"localPin":"unset","nativeInput":True,"firstKeys":True,"pasteBytes":len(data),"prefixCopyMode":True}))
finally:
    subprocess.run(["tmux","-S",sock,"kill-server"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for proc, master, slave in clients:
        os.close(master); os.close(slave)
        try: proc.wait(timeout=4)
        except subprocess.TimeoutExpired: proc.terminate(); proc.wait(timeout=3)
    shutil.rmtree(root)
