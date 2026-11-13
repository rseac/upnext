#!/usr/bin/env python3
"""Up next, in a herdr pane: the step tree the upnext mod writes, drawn with
plain characters, driven by keys.

    upnext-herdr.py STATE_FILE ACTIONS_FILE

The mod writes STATE_FILE after every change. This viewer only reads it, and
asks the mod to act by appending to ACTIONS_FILE, which the mod reads twice
a second. It never types into Claude's pane itself.
"""

import json
import os
import select
import shutil
import signal
import subprocess
import sys
import termios
import time
import tty
import unicodedata

HELP = "enter draft  s send  x drop  a archive  space fold  j/k move  q quit"

# The mod's theme colour names, as 256-colour codes.
COLORS = {
    "claude": 173,
    "suggestion": 75,
    "success": 71,
    "warning": 179,
    "merged": 141,
    "planMode": 66,
    "remember": 111,
    "permission": 105,
    "autoAccept": 170,
    "ide": 68,
    "bashBorder": 204,
    "error": 167,
}
STATUS = {"open": "o", "queued": ".", "running": "~", "done": "+", "failed": "x"}
STATUS_COLOR = {"open": None, "queued": 105, "running": 179, "done": 71, "failed": 167}

ESC = "\x1b["


def fg(n, text):
    return text if n is None else f"{ESC}38;5;{n}m{text}{ESC}39m"


def dim(text):
    return f"{ESC}2m{text}{ESC}22m"


def bold(text):
    return f"{ESC}1m{text}{ESC}22m"


def cells(text):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 0 if unicodedata.combining(c) else 1 for c in text)


def clip(text, width):
    """Cut to `width` cells, with ... when cut."""
    if cells(text) <= width:
        return text
    out, used = "", 0
    for c in text:
        w = cells(c)
        if used + w > width - 3:
            break
        out += c
        used += w
    return out + "..."


def wrap(text, width, max_lines=3):
    words, lines, line = text.split(), [], ""
    for w in words:
        if line and cells(line) + 1 + cells(w) > width:
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}" if line else w
    if line:
        lines.append(line)
    lines = [clip(l, width) for l in lines] or [""]
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = clip(lines[-1] + " ...", width) if cells(lines[-1]) + 4 <= width else clip(lines[-1], width - 1) + "..."
    return lines


def safe(text):
    """Printable text only: the mod cleans it already; this is the second lock."""
    return "".join(c for c in str(text) if c.isprintable() and c != "\x1b")


class Viewer:
    def __init__(self, state_path, actions_path):
        self.state_path = state_path
        self.actions_path = actions_path
        self.state = {}
        self.mtime = 0.0
        self.cursor = 0
        self.folded = set()
        self.rows = []  # (kind, root, step) per selectable row
        self.note = ""
        self.note_until = 0.0
        self.seq = int(time.time() * 1000)

    # -- data ----------------------------------------------------------------

    def load(self):
        try:
            m = os.stat(self.state_path).st_mtime
        except OSError:
            return False
        if m == self.mtime:
            return False
        try:
            with open(self.state_path, encoding="utf-8") as f:
                self.state = json.load(f)
            self.mtime = m
            return True
        except (OSError, ValueError):
            return False

    def act(self, verb, target):
        """Asks the mod to act: one JSON line, appended."""
        self.seq += 1
        line = json.dumps({"seq": self.seq, "verb": verb, "id": target})
        try:
            with open(self.actions_path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError as e:
            self.say(f"could not reach the mod: {e}")

    def say(self, text):
        self.note = text
        self.note_until = time.time() + 3

    # -- drawing -------------------------------------------------------------

    def draw(self):
        cols, rows = shutil.get_terminal_size((40, 24))
        # The last column is left free: some terminals wrap or cut it.
        cols = max(20, cols - 1)
        out = []
        self.rows = []
        lines_at = []  # the output line of each selectable row
        roots = self.state.get("roots", [])
        open_n = sum(1 for r in roots for s in r.get("steps", []) if s.get("status") != "done")
        title = bold(fg(COLORS["claude"], "* Up next"))
        count = f"{open_n} open"
        out.append(title + " " * max(1, cols - 9 - len(count)) + dim(count))
        if self.state.get("loading"):
            out.append(dim("  finding steps..."))
        out.append(dim("-" * cols))
        if not roots:
            out.append("")
            out.append("  Nothing queued up.")
            out.append(dim("  Steps land here when a reply"))
            out.append(dim("  suggests or offers more."))
        for r in roots:
            rid = r.get("id")
            color = COLORS.get(r.get("color"), None)
            steps = r.get("steps", [])
            left = sum(1 for s in steps if s.get("status") != "done")
            folded = rid in self.folded
            self.rows.append(("root", r, None))
            lines_at.append(len(out))
            here = len(self.rows) - 1 == self.cursor
            mark = ">" if here else " "
            head = f"{mark}{'+' if folded else '-'} "
            name = clip(safe(r.get("title", "")), cols - len(head) - 6)
            tail = "done" if left == 0 else str(left)
            line = head + fg(color, "# ") + bold(name)
            pad = cols - len(head) - 2 - cells(name) - len(tail)
            out.append(("" if not here else f"{ESC}7m") + line + " " * max(1, pad) + dim(tail) + (f"{ESC}27m" if here else ""))
            if folded:
                continue
            for s in steps:
                depth = int(s.get("depth", 0))
                self.rows.append(("step", r, s))
                lines_at.append(len(out))
                here = len(self.rows) - 1 == self.cursor
                st = s.get("status", "open")
                lead = "  " + "  " * depth
                glyph = fg(STATUS_COLOR.get(st), STATUS.get(st, "o"))
                width = cols - len(lead) - 3
                lines = wrap(safe(s.get("text", "")), width)
                for i, l in enumerate(lines):
                    text = dim(l) if st == "done" else l
                    first = f"{lead}{glyph} " if i == 0 else f"{lead}  "
                    row = ((">" if here and i == 0 else " ") + first[1:]) + text
                    out.append(f"{ESC}7m{row}{ESC}27m" if here else row)
        self.cursor = min(self.cursor, max(0, len(self.rows) - 1))
        foot = [self.note] if time.time() < self.note_until else wrap(HELP, cols, 3)
        room = max(1, rows - 1 - len(foot))
        head = 3 if self.state.get("loading") else 2
        if len(out) > room and lines_at:
            # Keep the selected row in view, under the fixed header.
            at = lines_at[min(self.cursor, len(lines_at) - 1)] - head
            body_room = room - head
            start = max(0, min(len(out) - head - body_room, at - body_room // 2))
            out = out[:head] + out[head + start : head + start + body_room]
        body = out[:room]
        body += [""] * (room - len(body))
        body.append(dim("-" * cols))
        body += [dim(clip(f, cols)) for f in foot]
        sys.stdout.write(f"{ESC}H" + "\r\n".join(f"{l}{ESC}K" for l in body) + f"{ESC}J")
        sys.stdout.flush()

    # -- keys ----------------------------------------------------------------

    def selected(self):
        return self.rows[self.cursor] if 0 <= self.cursor < len(self.rows) else None

    def key(self, k):
        row = self.selected()
        if k in ("q", "\x03"):
            return False
        if k in ("j", f"{ESC}B"):
            self.cursor = min(self.cursor + 1, max(0, len(self.rows) - 1))
        elif k in ("k", f"{ESC}A"):
            self.cursor = max(0, self.cursor - 1)
        elif k == "g":
            self.cursor = 0
        elif k == "G":
            self.cursor = max(0, len(self.rows) - 1)
        elif row is None:
            pass
        elif k == " " or (k in ("\r", "\n") and row[0] == "root"):
            rid = row[1].get("id")
            self.folded.symmetric_difference_update({rid})
        elif k in ("\r", "\n", "d"):
            self.act("draft", row[2]["id"])
            self.say("drafted in Claude's prompt box")
            self.focus_claude()
        elif k == "s":
            target = row[2]["id"] if row[0] == "step" else row[1]["id"]
            self.act("send" if row[0] == "step" else "send-all", target)
            self.say("sent to Claude")
        elif k == "x":
            target = row[2]["id"] if row[0] == "step" else row[1]["id"]
            self.act("dismiss", target)
        elif k == "a" and row[1].get("kind") == "stream":
            self.act("archive", row[1]["id"])
            self.say("archived; /upnext shows the archive")
        return True

    def focus_claude(self):
        """Back to Claude's pane, so the draft can be edited and sent."""
        me = os.environ.get("HERDR_PANE_ID")
        claude = self.state.get("claudePane")
        if not me or not claude:
            return
        herdr = os.environ.get("HERDR_BIN_PATH") or "herdr"
        try:
            subprocess.run([herdr, "pane", "focus", "--pane", me, "--direction", "left"], capture_output=True, timeout=3)
        except (OSError, subprocess.SubprocessError):
            pass


def read_keys(fd):
    """Every key waiting, arrows as one key each."""
    data = os.read(fd, 256).decode("utf-8", "ignore")
    keys = []
    while data:
        if data.startswith(ESC) and len(data) >= 3:
            keys.append(data[:3])
            data = data[3:]
        else:
            keys.append(data[0])
            data = data[1:]
    return keys


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    v = Viewer(sys.argv[1], sys.argv[2])
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    resized = [True]
    signal.signal(signal.SIGWINCH, lambda *_: resized.__setitem__(0, True))
    try:
        tty.setcbreak(fd)
        sys.stdout.write(f"{ESC}?1049h{ESC}?25l")
        v.load()
        v.draw()
        while True:
            ready, _, _ = select.select([fd], [], [], 0.4)
            changed = v.load()
            if ready:
                if not all(v.key(k) for k in read_keys(fd)):
                    break
                changed = True
            if v.note and time.time() >= v.note_until:
                v.note = ""
                changed = True
            if changed or resized[0]:
                resized[0] = False
                v.draw()
    except KeyboardInterrupt:
        pass
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        sys.stdout.write(f"{ESC}?25h{ESC}?1049l")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
