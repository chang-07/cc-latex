#!/usr/bin/env python3
"""Run a program under tmux with working kitty graphics.

    cc-tmux-bridge.py claude --resume <session-id>

The child runs in a pty. Its output is forwarded verbatim except for kitty
graphics commands (APC `ESC _ G ... ESC \\`), which are rewritten so tmux can
carry them:

* every graphics command is wrapped in tmux's passthrough envelope, so tmux
  forwards it to the real terminal instead of dropping it;
* placements stay virtual (`U=1`): Claude Code already prints kitty's Unicode
  placeholder cells itself, which tmux carries as ordinary text, so the bridge
  leaves the layout alone;
* the capability probe (`a=q`) is answered by the bridge itself;
* after placements, `tmux refresh-client` runs (debounced) to clear image
  pixels the terminal keeps for cells tmux has since overwritten.

The child sees TERM_PROGRAM=ghostty, CC_TMUX_BRIDGE=1 and
CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1. The measured cell size is written to
~/.cache/cc-tmux-bridge.cellsize as "<width_px> <height_px>" for other tools.
"""
import base64
import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import threading
import tty

ESC = b"\x1b"
APC_START = b"\x1b_G"
ST = b"\x1b\\"
PLACEHOLDER = "\U0010EEEE"
CELLSIZE_FILE = os.path.expanduser("~/.cache/cc-tmux-bridge.cellsize")
CELLSIZE_REPLY = re.compile(rb"\x1b\[6;(\d+);(\d+)t")

# kitty's rowcolumn-diacritics, in order: the n-th marks row or column n.
_RANGES = [
    (0x305, 0x305), (0x30D, 0x30E), (0x310, 0x310), (0x312, 0x312), (0x33D, 0x33F), (0x346, 0x346), (0x34A, 0x34C),
    (0x350, 0x352), (0x357, 0x357), (0x35B, 0x35B), (0x363, 0x36F), (0x483, 0x487), (0x592, 0x595), (0x597, 0x599),
    (0x59C, 0x5A1), (0x5A8, 0x5A9), (0x5AB, 0x5AC), (0x5AF, 0x5AF), (0x5C4, 0x5C4), (0x610, 0x617), (0x657, 0x65E),
    (0x6D6, 0x6DC), (0x6DF, 0x6E2), (0x6E4, 0x6E4), (0x6E7, 0x6E8), (0x6EB, 0x6EC), (0x730, 0x730), (0x732, 0x733),
    (0x735, 0x736), (0x73A, 0x73A), (0x73D, 0x73D), (0x73F, 0x741), (0x743, 0x743), (0x745, 0x745), (0x747, 0x747),
    (0x749, 0x74A), (0x7EB, 0x7F1), (0x7F3, 0x7F3), (0x816, 0x819), (0x81B, 0x823), (0x825, 0x827), (0x829, 0x82D),
    (0x951, 0x951), (0x953, 0x954), (0xF82, 0xF83), (0xF86, 0xF87), (0x135D, 0x135F), (0x17DD, 0x17DD), (0x193A, 0x193A),
    (0x1A17, 0x1A17), (0x1A75, 0x1A7C), (0x1B6B, 0x1B6B), (0x1B6D, 0x1B73), (0x1CD0, 0x1CD2), (0x1CDA, 0x1CDB),
    (0x1CE0, 0x1CE0), (0x1DC0, 0x1DC1), (0x1DC3, 0x1DC9), (0x1DCB, 0x1DCC), (0x1DD1, 0x1DF5), (0x1DFB, 0x1DFB),
    (0x1DFE, 0x1DFE), (0x20D0, 0x20D1), (0x20D4, 0x20D7), (0x20DB, 0x20DC), (0x20E1, 0x20E1), (0x20E7, 0x20E7),
    (0x20E9, 0x20E9), (0x20F0, 0x20F0), (0x2CEF, 0x2CF1), (0x2DE0, 0x2DFF), (0xA66F, 0xA66F), (0xA67C, 0xA67D),
    (0xA6F0, 0xA6F1), (0xA8E0, 0xA8F1), (0xAAB0, 0xAAB0), (0xAAB2, 0xAAB3), (0xAAB7, 0xAAB8), (0xAABE, 0xAABF),
    (0xAAC1, 0xAAC1), (0xFE20, 0xFE26), (0x10A0F, 0x10A0F), (0x10A38, 0x10A38), (0x1D185, 0x1D189), (0x1D1AA, 0x1D1AD),
    (0x1D242, 0x1D244),
]
DIACRITICS = [chr(c) for a, b in _RANGES for c in range(a, b + 1)]
MAX_CELLS = len(DIACRITICS)

LOG = os.environ.get("CC_TMUX_BRIDGE_LOG", os.path.expanduser("~/.cache/cc-tmux-bridge.log"))
DUMP = os.environ.get("CC_TMUX_BRIDGE_DUMP")  # a path: raw child output goes to <path>.in, forwarded bytes to <path>.out


def log(msg: str) -> None:
    if LOG:
        with open(LOG, "a") as f:
            f.write(f"[{os.getpid()}] {msg}\n")


def tmux_wrap(seq: bytes) -> bytes:
    return b"\x1bPtmux;" + seq.replace(ESC, ESC + ESC) + ST


def parse_ctrl(ctrl: bytes) -> dict:
    out = {}
    for part in ctrl.split(b","):
        if b"=" in part:
            k, v = part.split(b"=", 1)
            out[k.decode()] = v.decode()
    return out


def fmt_ctrl(d: dict) -> bytes:
    return ",".join(f"{k}={v}" for k, v in d.items()).encode()


PLACEHOLDER_UTF8 = PLACEHOLDER.encode()
SGR_ID = re.compile(rb"\x1b\[38;(?:5;(\d+)|2;(\d+);(\d+);(\d+))m(?=\xf4\x8e\xbb\xae)")
SGR_TAIL = re.compile(rb"\x1b\[38;(?:5;\d*|2;\d*;?\d*;?\d*)m?(?:\xf4(?:\x8e(?:\xbb)?)?)?$")


def png_size(payload_b64: bytes):
    """Width and height from a PNG's IHDR, given the (first chunk of) base64."""
    try:
        head = base64.b64decode(payload_b64[:64] + b"=" * (-len(payload_b64[:64]) % 4))
    except Exception:
        return None
    if len(head) < 24 or head[12:16] != b"IHDR":
        return None
    w, h = struct.unpack(">II", head[16:24])
    return (w, h) if w and h else None


class Bridge:
    def __init__(self, child_fd: int):
        self.child_fd = child_fd
        self.buf = b""
        self.next_id = 1000  # ids the bridge mints when the child names none
        self.in_chunks = False  # inside an m=1 chunked transmission
        self.skip_chunks = False  # the transmission in progress is a duplicate: drop its chunks
        # A chunked upload is coalesced into one command: kitty's chunking is
        # stateful in the terminal (a transmission stays open until its last
        # chunk), so chunks from two sessions interleaving through tmux, or a
        # transmission cut short, leave the terminal stuck mid-upload and it
        # swallows every graphics command after. One command per image has no
        # such state.
        self.tx_ctrl = None  # the first chunk's control data, while coalescing
        self.tx_payload = []
        self.tx_log = ""
        self.uploaded = {}  # image id -> key of the payload the terminal already holds (insertion = recency)
        # kitty image ids are global to the terminal, and every Claude Code
        # process numbers its images from 1: two bridged sessions in one
        # window would overwrite and delete each other's pictures. Each bridge
        # moves its child's ids into a range of its own (24-bit, so the id
        # still fits a placeholder cell's foreground colour).
        self.id_base = ((os.getpid() % 16000) + 1) * 1000
        self.hold = b""  # a trailing SGR that may be followed by a placeholder in the next read
        self.max_images = int(os.environ.get("CC_TMUX_BRIDGE_MAX_IMAGES", "24"))
        self.cell = None  # (width_px, height_px) once measured
        self.pane_width = self.tmux_pane_width()
        self.client = self.tmux_client()
        self.refresh_timer = None
        self.refresh_wanted = False
        self.load_cellsize()

    # -- tmux helpers ------------------------------------------------------

    @staticmethod
    def tmux(*args: str) -> str:
        try:
            return subprocess.run(["tmux", *args], capture_output=True, text=True, timeout=2).stdout.strip()
        except Exception:
            return ""

    def tmux_pane_width(self) -> int:
        w = self.tmux("display", "-p", "-t", os.environ.get("TMUX_PANE", ""), "#{pane_width}")
        return int(w) if w.isdigit() else 0

    def tmux_client(self) -> str:
        return self.tmux("display", "-p", "-t", os.environ.get("TMUX_PANE", ""), "#{client_name}")

    def schedule_refresh(self) -> None:
        """Redraw the tmux client once the child's output goes quiet after a
        placement, and once more a second later as a safety net. The terminal
        can keep an image's pixels on cells tmux has since moved or overwritten
        (the reply's rows shift as its layout settles), and a full redraw
        reconciles them. Quiet output is the earliest moment that is settled."""
        self.refresh_wanted = True
        self.arm_idle_refresh()

    def arm_idle_refresh(self) -> None:
        if not self.client or not self.refresh_wanted:
            return
        if self.refresh_timer:
            self.refresh_timer.cancel()

        def go():
            self.refresh_wanted = False
            self.tmux("refresh-client", "-t", self.client)
            t = threading.Timer(1.0, lambda: self.tmux("refresh-client", "-t", self.client))
            t.daemon = True
            t.start()

        self.refresh_timer = threading.Timer(0.15, go)
        self.refresh_timer.daemon = True
        self.refresh_timer.start()

    # -- cell size -----------------------------------------------------------

    def load_cellsize(self) -> None:
        try:
            w, h = open(CELLSIZE_FILE).read().split()
            self.cell = (int(w), int(h))
        except Exception:
            self.cell = None

    def query_cellsize(self) -> bytes:
        """CSI 16 t, wrapped for tmux; the reply arrives on our stdin."""
        return tmux_wrap(b"\x1b[16t")

    def take_cellsize_reply(self, data: bytes) -> bytes:
        """Strips a cell-size reply out of input bound for the child."""
        m = CELLSIZE_REPLY.search(data)
        if not m:
            return data
        h, w = int(m.group(1)), int(m.group(2))
        if w and h:
            self.cell = (w, h)
            try:
                os.makedirs(os.path.dirname(CELLSIZE_FILE), exist_ok=True)
                open(CELLSIZE_FILE, "w").write(f"{w} {h}\n")
            except OSError:
                pass
            log(f"cell size: {w}x{h} px")
        return data[: m.start()] + data[m.end() :]

    # -- output from the child -------------------------------------------

    def buf_before(self, i: int) -> bytes:
        """The last 120 bytes of what preceded an APC, for the log."""
        return self.recent[-120:]

    def feed(self, data: bytes) -> bytes:
        if DUMP:
            with open(DUMP + ".in", "ab") as f:
                f.write(data)
        out = self.hold + self._feed(data)
        self.hold = b""
        m = SGR_TAIL.search(out)
        if m:
            self.hold = out[m.start():]
            out = out[: m.start()]
        out = self.recolor(out)
        if DUMP:
            with open(DUMP + ".out", "ab") as f:
                f.write(out)
        return out

    def _feed(self, data: bytes) -> bytes:
        self.recent = (getattr(self, "recent", b"") + data)[-4096:]
        self.buf += data
        if self.refresh_wanted:
            self.arm_idle_refresh()
        out = []
        while True:
            i = self.buf.find(APC_START)
            if i < 0:
                keep = 0
                if self.buf.endswith(ESC + b"_"):
                    keep = 2
                elif self.buf.endswith(ESC):
                    keep = 1
                out.append(self.buf[: len(self.buf) - keep])
                self.buf = self.buf[len(self.buf) - keep :]
                break
            j = self.buf.find(ST, i)
            if j < 0:
                out.append(self.buf[:i])
                self.buf = self.buf[i:]
                break
            out.append(self.buf[:i])
            body = self.buf[i + len(APC_START) : j]
            self.buf = self.buf[j + len(ST) :]
            if not body.startswith(b"m="):
                log("before: " + repr(self.buf_before(i)) + "  ctrl: " + repr(body.partition(b";")[0]))
            out.append(self.graphics(body))
        return b"".join(out)

    def map_id(self, ident: str) -> str:
        return str(self.id_base + int(ident)) if ident.isdigit() else ident

    def recolor(self, text: bytes) -> bytes:
        """Moves the image id a placeholder cell carries in its foreground
        colour into this bridge's id range (as a 24-bit colour); one pass, so
        a remapped colour is never remapped again."""
        def sub(m):
            if m.group(1) is not None:
                ident = int(m.group(1))
            else:
                ident = (int(m.group(2)) << 16) | (int(m.group(3)) << 8) | int(m.group(4))
            ident = self.id_base + ident
            return b"\x1b[38;2;%d;%d;%dm" % ((ident >> 16) & 255, (ident >> 8) & 255, ident & 255)
        return SGR_ID.sub(sub, text)

    def graphics(self, body: bytes) -> bytes:
        ctrl_b, _, payload = body.partition(b";")
        ctrl = parse_ctrl(ctrl_b)
        if "i" in ctrl and ctrl.get("a") != "q":
            ctrl["i"] = self.map_id(ctrl["i"])

        # Continuation chunk of a chunked transmission: wrap and forward.
        if self.in_chunks and "a" not in ctrl:
            self.in_chunks = ctrl.get("m") == "1"
            if self.skip_chunks:
                if not self.in_chunks:
                    self.skip_chunks = False
                return b""
            self.tx_payload.append(payload)
            if self.in_chunks:
                return b""
            return self.flush_transmission()

        action = ctrl.get("a", "t")

        if action == "q":
            ident = ctrl.get("i")
            reply = (b"\x1b_Gi=" + ident.encode() + b";OK" + ST) if ident else (b"\x1b_G;OK" + ST)
            os.write(self.child_fd, reply)
            log(f"probe answered: {ctrl}")
            return b""

        if action in ("T", "p"):
            # Claude Code already asks for a virtual placement (U=1) and prints
            # kitty's Unicode placeholder cells itself; the bridge only has to
            # get the command through tmux. Printing a second placeholder grid
            # here, or changing the box, corrupts the engine's layout.
            ctrl.setdefault("U", "1")
            ctrl.setdefault("q", "2")
            self.in_chunks = ctrl.get("m") == "1"
            ident = ctrl.get("i")
            # The engine re-uploads every image on each redraw. The terminal
            # already holds it, so a repeat of the same payload under the same
            # id is dropped, continuation chunks included.
            key = (ctrl.get("c"), ctrl.get("r"), ctrl.get("f"), payload[:4096])
            if ident and self.uploaded.get(ident) == key:
                self.skip_chunks = self.in_chunks
                log(f"placement id={ident} {ctrl.get('c')}x{ctrl.get('r')} duplicate, dropped")
                return b""
            evict = b""
            # Trim the box to the picture's shape: the terminal centres a picture
            # in a box wider than it. Only ever narrower (the placeholder grid
            # the engine printed is `c` wide; cells past the trimmed width stay
            # empty, but a wider box than the grid would be cropped).
            cols = int(ctrl.get("c", "0") or 0)
            rows = int(ctrl.get("r", "0") or 0)
            fit = self.fit_columns(ctrl, payload, rows)
            if fit and cols and fit < cols:
                ctrl["c"] = str(fit)
                log(f"box {cols}x{rows} trimmed to {fit}x{rows}")
            if ident:
                # The engine reuses ids; the terminal keeps the old virtual
                # placement's box when an id is re-transmitted, and fits the new
                # picture into it. Delete the old image first so the new box
                # applies.
                if ident in self.uploaded:
                    evict += tmux_wrap(APC_START + f"a=d,d=I,i={ident},q=2".encode() + ST)
                    log(f"replaced image id={ident}: old placement deleted")
                self.uploaded.pop(ident, None)
                self.uploaded[ident] = key
                # The terminal's image store is finite (Ghostty refuses new
                # uploads once full, silently). Keep the newest images and
                # delete the oldest from the terminal ourselves.
                while len(self.uploaded) > self.max_images:
                    old = next(iter(self.uploaded))
                    del self.uploaded[old]
                    evict += tmux_wrap(APC_START + f"a=d,d=I,i={old},q=2".encode() + ST)
                    log(f"evicted image id={old}")
            self.tx_log = f"placement id={ident} {ctrl.get('c')}x{ctrl.get('r')}"
            if self.in_chunks:
                ctrl.pop("m", None)
                self.tx_ctrl = ctrl
                self.tx_payload = [payload]
                return evict
            log(self.tx_log)
            self.schedule_refresh()
            return evict + tmux_wrap(APC_START + fmt_ctrl(ctrl) + b";" + payload + ST)

        if action == "d":
            # The engine deletes images it thinks are off screen and re-uploads
            # them later; between the two the placeholders are blank, and a
            # cycle that ends on the delete leaves a formula blank for good.
            # Images are small, so keep every one the terminal has.
            log(f"delete dropped: {ctrl}")
            return b""

        self.in_chunks = ctrl.get("m") == "1"
        ctrl.setdefault("q", "2")
        if self.in_chunks:
            ctrl.pop("m", None)
            self.tx_ctrl = ctrl
            self.tx_payload = [payload]
            self.tx_log = f"transmit {ctrl.get('a')} id={ctrl.get('i')}"
            return b""
        return tmux_wrap(APC_START + fmt_ctrl(ctrl) + b";" + payload + ST)

    def fit_columns(self, ctrl: dict, payload: bytes, rows: int):
        """Columns that give the box the picture's own shape at `rows` tall,
        from the PNG header and this window's measured cell size."""
        if rows <= 0 or not self.cell or ctrl.get("f") != "100" or ctrl.get("t", "d") != "d":
            return None
        size = png_size(payload)
        if not size:
            return None
        w, h = size
        cw, ch = self.cell
        return max(1, round(w / h * rows * ch / cw))

    def flush_transmission(self) -> bytes:
        """The coalesced upload as one command (no m= key, so the terminal
        never enters chunked state)."""
        ctrl, payload = self.tx_ctrl, b"".join(self.tx_payload)
        self.tx_ctrl, self.tx_payload = None, []
        if ctrl is None:
            return b""
        log(f"{self.tx_log} coalesced {len(payload)} bytes")
        self.schedule_refresh()
        return tmux_wrap(APC_START + fmt_ctrl(ctrl) + b";" + payload + ST)




def set_winsize(fd: int) -> None:
    try:
        size = fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, size)
    except OSError:
        pass


def main(argv: list[str]) -> int:
    cmd = argv or ["claude"]
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env["TERM_PROGRAM"] = "ghostty"
        env["CC_TMUX_BRIDGE"] = "1"
        env.setdefault("CLAUDE_CODE_FORCE_TERMINAL_IMAGES", "1")
        os.execvpe(cmd[0], cmd, env)

    set_winsize(fd)
    bridge = Bridge(fd)

    def on_winch(*_):
        set_winsize(fd)
        bridge.pane_width = bridge.tmux_pane_width()
        os.kill(pid, signal.SIGWINCH)

    signal.signal(signal.SIGWINCH, on_winch)

    stdin = sys.stdin.fileno()
    old = termios.tcgetattr(stdin)
    tty.setraw(stdin)
    os.write(sys.stdout.fileno(), bridge.query_cellsize())
    status = 0
    try:
        while True:
            try:
                ready, _, _ = select.select([fd, stdin], [], [])
            except InterruptedError:
                continue
            if fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                os.write(sys.stdout.fileno(), bridge.feed(data))
            if stdin in ready:
                data = os.read(stdin, 65536)
                if not data:
                    break
                data = bridge.take_cellsize_reply(data)
                if data:
                    os.write(fd, data)
    finally:
        termios.tcsetattr(stdin, termios.TCSADRAIN, old)
        try:
            _, status = os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    return os.waitstatus_to_exitcode(status) if status else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
