#!/usr/bin/env python3
"""Up next, in a herdr pane: the step tree the upnext mod writes, with mouse
and keys.

    upnext-herdr.py [--ascii] STATE_FILE ACTIONS_FILE
    upnext-herdr.py [--ascii] --popup

--popup runs as a herdr plugin popup: it finds the state of the Claude pane
under it (or the most recent one), and closes after a step is drafted or sent.

The mod writes STATE_FILE after every change. This viewer only reads it, and
asks the mod to act by appending JSON lines to ACTIONS_FILE, which the mod
reads twice a second. It never types into Claude's pane itself.

Every symbol used is one that herdr's terminal counts as one cell wide;
--ascii swaps them for plain characters in case a font draws one badly.
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

ESC = "\x1b["

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
STATUS_COLOR = {"open": 245, "queued": 105, "running": 179, "done": 71, "failed": 167}

FANCY = {
    "title": "✦",
    "stream": "●",
    "group": "◆",
    "open": "○",
    "queued": "◌",
    "running": "◐",
    "done": "✓",
    "failed": "✗",
    "unfolded": "▾",
    "folded": "▸",
    "mid": "├─ ",
    "last": "└─ ",
    "pipe": "│  ",
    "space": "   ",
    "send": "▶",
    "hand": "➜",
    "drop": "✕",
    "archive": "⊟",
    "rule": "─",
    "more": "…",
}
ASCII = {
    "title": "*",
    "stream": "#",
    "group": "*",
    "open": "o",
    "queued": ".",
    "running": "~",
    "done": "+",
    "failed": "x",
    "unfolded": "-",
    "folded": "+",
    "mid": "|- ",
    "last": "`- ",
    "pipe": "|  ",
    "space": "   ",
    "send": ">",
    "hand": "@",
    "drop": "x",
    "archive": "_",
    "rule": "-",
    "more": "...",
}

HELP = "1-9 draft · j/k move · enter draft · s send · h agent · m mark · x drop · p re-rank · e everything else · q quit"
HELP_ASCII = HELP


def cells(text):
    return sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in text)


def clip(text, width, more="…"):
    if cells(text) <= width:
        return text
    out, used = "", 0
    for c in text:
        w = cells(c)
        if used + w > width - cells(more):
            break
        out += c
        used += w
    return out + more


def wrap(text, width, max_lines=3, more="…"):
    lines, line = [], ""
    for w in text.split():
        if line and cells(line) + 1 + cells(w) > width:
            lines.append(line)
            line = w
        else:
            line = f"{line} {w}" if line else w
    if line:
        lines.append(line)
    lines = [clip(l, width, more) for l in lines] or [""]
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = clip(lines[-1] + " " + more, width, more)
    return lines


CODE = 75  # blue: `code` and slash commands, what will actually run
GREY = 245


def words_of(text):
    """Words with whether each is inside `backticks` (the backticks dropped)."""
    out, word, code, is_code = [], "", False, False
    for c in text:
        if c == "`":
            code = not code
            continue
        if c.isspace():
            if word:
                out.append((word, is_code))
            word = ""
            continue
        if not word:
            is_code = code
        word += c
    if word:
        out.append((word, is_code))
    return out


def wrap_words(words, width, max_lines=3, more="…"):
    """Lines of (word, is_code), each line at most `width` cells."""
    lines, line, used = [], [], 0
    for w, code in words:
        w = clip(w, width, more)
        need = cells(w) + (1 if line else 0)
        if line and used + need > width:
            lines.append(line)
            line, used = [], 0
            need = cells(w)
        line.append((w, code))
        used += need
    if line:
        lines.append(line)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and sum(cells(w) + 1 for w, _ in last) + cells(more) > width:
            last.pop()
        last.append((more, False))
    return lines or [[]]


def safe(text):
    """Printable text only: the mod cleans it already; this is the second lock."""
    return "".join(c for c in str(text) if c.isprintable())


class Line:
    """One screen line: its styled text, what it belongs to, and its click zones."""

    def __init__(self, row=None):
        self.parts = []  # (text, style dict)
        self.row = row  # index into Viewer.rows, or None
        self.zones = []  # (x0, x1, action)
        self.width = 0

    def add(self, text, zone=None, **style):
        if zone is not None:
            self.zones.append((self.width, self.width + cells(text), zone))
        self.parts.append((text, style))
        self.width += cells(text)
        return self

    def pad_to(self, width):
        if self.width < width:
            self.add(" " * (width - self.width))
        return self

    def render(self, highlight=None):
        out = []
        base = ""
        if highlight == "cursor":
            base = f"{ESC}48;5;238m"
        elif highlight == "hover":
            base = f"{ESC}48;5;236m"
        for text, st in self.parts:
            codes = []
            hot = highlight is not None and st.get("hot") is not None
            fg = st["hot"] if hot else st.get("fg")
            if fg is not None:
                codes.append(f"38;5;{fg}")
            if st.get("bold"):
                codes.append("1")
            if st.get("dim") and not hot:
                codes.append("2")
            if st.get("strike"):
                codes.append("9")
            out.append(base + (f"{ESC}{';'.join(codes)}m" if codes else "") + text + f"{ESC}0m")
        return "".join(out) + base + f"{ESC}K{ESC}0m"


class Viewer:
    def __init__(self, state_path, actions_path, ascii_only, popup=False):
        self.popup = popup
        self.picker = None  # {"ids", "text", "agents": [(pane, label)], "error"}
        self.marked = []  # step ids, in the order marked
        self.show_all = None  # "everything else" under the ranked steps; None: shown while short
        self.numbered = []  # step ids by number (1-based), open steps in view order
        self.done = False
        self.g = ASCII if ascii_only else FANCY
        self.help = HELP_ASCII if ascii_only else HELP
        self.state_path = state_path
        self.actions_path = actions_path
        self.state = {}
        self.mtime = 0.0
        self.cursor = 0
        self.top = 0
        self.follow = True  # keep the cursor in view (off while the wheel scrolls)
        self.hover_y = None
        self.folded = set()
        self.rows = []  # ("root", root, None) or ("step", root, step)
        self.screen = {}  # screen y (1-based) -> Line
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

    def act(self, verb, target, note, **extra):
        self.seq += 1
        try:
            with open(self.actions_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"seq": self.seq, "verb": verb, "id": target, **extra}) + "\n")
            self.say(note)
        except OSError as e:
            self.say(f"could not reach the mod: {e}")

    def say(self, text):
        self.note = text
        self.note_until = time.time() + 2.5

    # -- layout --------------------------------------------------------------

    def build(self, cols):
        """All body lines, top to bottom."""
        g = self.g
        lines = []
        self.rows = []
        self.numbered = []
        roots = self.state.get("roots", [])
        by_id = {s.get("id"): (r, s) for r in roots for s in r.get("steps", [])}
        open_count = sum(1 for r in roots for s in r.get("steps", []) if s.get("status") in ("open", "failed"))
        top = [t for t in self.state.get("top", []) if t.get("id") in by_id]
        has_top = len(top) >= 2 and open_count >= 3
        ranked_ids = {t["id"] for t in top} if has_top else set()
        show_tree = not has_top or (self.show_all if self.show_all is not None else open_count <= 8)
        if has_top:
            head = Line()
            head.add(" Most important", fg=COLORS["claude"], bold=True)
            head.pad_to(cols - 8)
            head.add("p re-rank", dim=True)
            lines.append(head)
            for t in top:
                r, s = by_id[t["id"]]
                sid = s.get("id")
                st = s.get("status", "open")
                self.numbered.append(sid)
                num = len(self.numbered)
                self.rows.append(("step", r, s))
                row = len(self.rows) - 1
                is_marked = sid in self.marked
                color = COLORS.get(r.get("color"))
                tag = clip(safe(r.get("title", "")), 14, g["more"])
                draft = ("draft", sid)
                line = Line(row)
                line.add(f" {num} " if num <= 9 else "   ", draft, fg=COLORS["claude"], bold=True)
                if is_marked:
                    line.add("◆ " if g is FANCY else "* ", draft, fg=179, bold=True)
                line.add(g.get(st, g["open"]), draft, fg=STATUS_COLOR.get(st))
                line.add(" ", draft)
                text_w = max(8, cols - line.width - cells(tag) - 3 - 7)
                text = clip(" ".join(w for w, _ in words_of(safe(s.get("text", "")))), text_w, g["more"])
                line.add(text, draft, bold=True)
                line.pad_to(cols - 7 - cells(tag) - 2)
                line.add(g["stream"] + " ", fg=color)
                line.add(tag, fg=color, dim=True)
                line.pad_to(cols - 6)
                line.add(" ")
                line.add(g["hand"], ("hand", sid), dim=True, hot=141)
                line.add(" ")
                line.add(g["send"], ("send", sid), dim=True, hot=71)
                line.add(" ")
                line.add(g["drop"], ("dismiss", sid), dim=True, hot=167)
                lines.append(line)
                why = safe(t.get("why", ""))
                if why:
                    lines.append(Line(row).add("      " + clip(why, cols - 7, g["more"]), dim=True))
            rest = open_count - len(top)
            if rest > 0:
                lines.append(Line())
                lines.append(Line().add(f" {g['unfolded'] if show_tree else g['folded']} everything else · {rest}", ("all", ""), dim=True))
            if not show_tree:
                return lines
            lines.append(Line())
        for ri, r in enumerate(roots):
            if ri > 0:
                lines.append(Line())
            rid = r.get("id")
            idle = bool(r.get("isIdle"))
            color = GREY if idle else COLORS.get(r.get("color"))
            steps = r.get("steps", [])
            left = sum(1 for s in steps if s.get("status") != "done")
            folded = rid in self.folded
            self.rows.append(("root", r, None))
            row = len(self.rows) - 1
            line = Line(row)
            buttons = [(g["send"], ("send-all", rid), 71), (g["archive"], ("archive", rid), 179), (g["drop"], ("dismiss", rid), 167)]
            if r.get("kind") != "stream":
                buttons = [b for b in buttons if b[1][0] != "archive"]
            right = 2 * len(buttons) + 1
            count = f"{left}" if left else g["done"]
            tag = " idle" if idle else ""
            name_w = max(4, cols - 5 - right - cells(count) - 2 - len(tag))
            name = clip(safe(r.get("title", "")), name_w, g["more"])
            fold = ("toggle", rid)
            line.add(" " + (g["folded"] if folded else g["unfolded"]) + " ", fold, fg=color, dim=True)
            line.add(g["stream"] if r.get("kind") == "stream" else g["group"], fold, fg=color)
            line.add(" ", fold)
            line.add(name, fold, fg=color, bold=not idle)
            if tag:
                line.add(tag, fold, fg=GREY, dim=True)
            line.add("  ")
            line.add(count, fg=STATUS_COLOR["done"] if not left else color, dim=False)
            line.pad_to(cols - right)
            for glyph, zone, hot in buttons:
                line.add(" ")
                line.add(glyph, zone, dim=True, hot=hot)
            lines.append(line)
            if folded:
                continue
            # Tree guides: whether each step is the last of its siblings.
            depths = [int(s.get("depth", 0)) for s in steps]
            last = []
            for i, d in enumerate(depths):
                j = i + 1
                while j < len(depths) and depths[j] > d:
                    j += 1
                last.append(j >= len(depths) or depths[j] < d)
            open_levels = []
            for i, s in enumerate(steps):
                d = depths[i]
                open_levels = open_levels[:d]
                lead = " " + "".join(g["space"] if done else g["pipe"] for done in open_levels)
                branch = g["last"] if last[i] else g["mid"]
                cont = lead + (g["space"] if last[i] else g["pipe"])
                open_levels.append(last[i])
                self.rows.append(("step", r, s))
                row = len(self.rows) - 1
                st = s.get("status", "open")
                sid = s.get("id")
                is_new = bool(s.get("isNew"))
                is_done = st == "done"
                # The text's colour says its state; commands are blue, as code is.
                text_fg = {"queued": 105, "running": 179, "failed": 167, "done": 71}.get(st)
                if text_fg is None and s.get("isCommand"):
                    text_fg = CODE
                if st in ("open", "failed") and sid not in ranked_ids:
                    self.numbered.append(sid)
                num = len(self.numbered) if st in ("open", "failed") and sid not in ranked_ids else None
                is_marked = sid in self.marked
                text_w = max(8, cols - cells(lead + branch) - 2 - 7 - 2 - (2 if is_new else 0) - (2 if is_marked else 0))
                texts = wrap_words(words_of(safe(s.get("text", ""))), text_w, 3, g["more"])
                draft = ("draft", sid)
                for n, words in enumerate(texts):
                    line = Line(row)
                    if n == 0:
                        line.add(lead + branch, fg=color, dim=True)
                        line.add(f"{num} " if num is not None and num <= 9 else "  ", draft, fg=COLORS["claude"], bold=True)
                        if is_marked:
                            line.add("◆ " if g is FANCY else "* ", draft, fg=179, bold=True)
                        line.add(g.get(st, g["open"]), draft, fg=STATUS_COLOR.get(st))
                        line.add(" ", draft)
                    else:
                        line.add(cont + "    " + ("  " if is_marked else ""), fg=color, dim=True)
                    for k, (w, code) in enumerate(words):
                        if k:
                            line.add(" ", draft, strike=is_done)
                        fg = CODE if code and not is_done else text_fg
                        line.add(w, draft, fg=fg, dim=is_done, strike=is_done, bold=is_new)
                    if n == 0 and is_new:
                        line.add(" •", draft, fg=color, bold=True)
                    if n == 0 and s.get("handedTo"):
                        line.add(f" {g['hand']} {clip(safe(s['handedTo']), 14, g['more'])}", fg=141)
                    if n == 0:
                        line.pad_to(cols - 6)
                        line.add(" ")
                        line.add(g["hand"], ("hand", sid), dim=True, hot=141)
                        line.add(" ")
                        line.add(g["send"], ("send", sid), dim=True, hot=71)
                        line.add(" ")
                        line.add(g["drop"], ("dismiss", sid), dim=True, hot=167)
                    lines.append(line)
        return lines

    def draw(self):
        cols, rows = shutil.get_terminal_size((40, 24))
        # The last column is left free: some terminals wrap or cut it.
        cols = max(24, cols - 1)
        g = self.g
        roots = self.state.get("roots", [])
        every = [s.get("status", "open") for r in roots for s in r.get("steps", [])]
        counts = [
            (f"{every.count('open') + every.count('queued')} open", None, True),
            (f"{every.count('running')} running", STATUS_COLOR["running"], False),
            (f"{every.count('failed')} {g['failed']}", STATUS_COLOR["failed"], False),
        ]
        counts = [c for i, c in enumerate(counts) if i == 0 or not c[0].startswith("0 ")]

        head = Line()
        head.add(f" {g['title']} Up next", fg=COLORS["claude"], bold=True)
        # Fewer counts when the pane is narrow.
        while len(counts) > 1 and 11 + sum(cells(t) + 3 for t, _, _ in counts) > cols:
            counts.pop()
        width = sum(cells(t) for t, _, _ in counts) + 3 * (len(counts) - 1)
        head.pad_to(cols - width)
        for i, (t, fg, dim) in enumerate(counts):
            if i:
                head.add(" · ", dim=True)
            head.add(t, fg=fg, dim=dim)
        rule = Line().add(g["rule"] * cols, dim=True)

        body = self.picker_lines(cols) if self.picker else self.build(cols)
        if not body:
            body = [Line(), Line().add("   Nothing queued up.", bold=True), Line().add("   Steps land here when a reply", dim=True), Line().add("   suggests or offers more.", dim=True)]
        self.cursor = min(self.cursor, max(0, len(self.rows) - 1))

        help_text = self.help
        if self.marked:
            help_text = f"{len(self.marked)} marked · r run in order · h hand all to an agent · u unmark · m (un)mark"
        foot_text = [self.note] if time.time() < self.note_until else wrap(help_text, cols - 1, 2, g["more"])
        foot = [Line().add(g["rule"] * cols, dim=True)] + [Line().add(" " + t, dim=True) for t in foot_text]
        room = max(1, rows - 2 - len(foot))

        # Scroll: keep the cursor's first line in view unless the wheel moved.
        if self.follow:
            at = next((i for i, l in enumerate(body) if l.row == self.cursor), 0)
            if at < self.top:
                self.top = max(0, at - 1)
            elif at >= self.top + room:
                self.top = at - room + 2
        self.top = max(0, min(self.top, max(0, len(body) - room)))
        shown = body[self.top : self.top + room]
        shown += [Line() for _ in range(room - len(shown))]

        hover_row = self.screen_row(self.hover_y) if self.hover_y is not None else None
        self.screen = {}
        out = [head.render(), rule.render()]
        for i, line in enumerate(shown):
            self.screen[3 + i] = line
            mark = None
            if line.row is not None and line.row == self.cursor:
                mark = "cursor"
            elif line.row is not None and line.row == hover_row:
                mark = "hover"
            out.append(line.render(mark))
        out += [l.render() for l in foot]
        sys.stdout.write(f"{ESC}H" + "\r\n".join(out) + f"{ESC}J")
        sys.stdout.flush()

    def picker_lines(self, cols):
        g = self.g
        p = self.picker
        lines = [Line(), Line().add(" Hand this step to:", bold=True)]
        for t in wrap(safe(p["text"]), cols - 4, 2, g["more"]):
            lines.append(Line().add("   " + t, dim=True))
        lines.append(Line())
        if p.get("error"):
            lines.append(Line().add("   " + clip(p["error"], cols - 4, g["more"]), fg=167))
        for i, (pane, label) in enumerate(p["agents"][:9]):
            line = Line()
            zone = ("pick", i)
            line.add(f"  {i + 1} ", zone, fg=COLORS["claude"], bold=True)
            line.add(clip(safe(label), cols - 6, g["more"]), zone)
            lines.append(line)
        lines.append(Line())
        lines.append(Line().add("   1-9 or click to pick · Esc to go back", dim=True))
        return lines

    def open_picker(self, ids, text):
        """Lists the other agent panes herdr knows, to hand a step to one."""
        herdr = os.environ.get("HERDR_BIN_PATH") or "herdr"
        me = {os.environ.get("HERDR_PANE_ID"), self.state.get("claudePane")}
        agents, error = [], ""
        try:
            r = subprocess.run([herdr, "agent", "list"], capture_output=True, text=True, timeout=5)
            for a in json.loads(r.stdout).get("result", {}).get("agents", []):
                pane = a.get("pane_id")
                if not pane or pane in me:
                    continue
                where = a.get("terminal_title_stripped") or os.path.basename(a.get("foreground_cwd") or a.get("cwd") or "")
                agents.append((pane, f"{a.get('agent', 'agent')} · {a.get('agent_status', '?')} · {where}"))
        except (OSError, ValueError, subprocess.SubprocessError) as e:
            error = f"could not list agents: {e}"
        if not agents and not error:
            error = "no other agent panes in herdr"
        self.picker = {"ids": ids, "text": text, "agents": agents, "error": error}

    def pick(self, i):
        p = self.picker
        if p and 0 <= i < len(p["agents"]):
            pane, label = p["agents"][i]
            name = label.split(" · ")[0] + " " + pane
            self.act("handoff", p["ids"][0], f"handed to {name}", ids=p["ids"], pane=pane, label=name)
            self.marked = []
        self.picker = None

    def screen_row(self, y):
        line = self.screen.get(y)
        return line.row if line else None

    # -- input ---------------------------------------------------------------

    def run_zone(self, zone):
        verb, target = zone
        if verb == "toggle":
            self.folded.symmetric_difference_update({target})
        elif verb == "all":
            open_count = sum(1 for r in self.state.get("roots", []) for s in r.get("steps", []) if s.get("status") in ("open", "failed"))
            self.show_all = not (self.show_all if self.show_all is not None else open_count <= 8)
        elif verb == "pick":
            self.pick(target)
        elif verb == "hand":
            if self.marked:
                self.open_picker(list(self.marked), f"{len(self.marked)} marked steps, in the order marked")
            else:
                step = next((r[2] for r in self.rows if r[0] == "step" and r[2].get("id") == target), None)
                if step:
                    self.open_picker([target], step.get("text", ""))
        elif verb == "draft":
            self.act("draft", target, "drafted in Claude's prompt box")
            self.leave()
        elif verb == "send":
            self.act("send", target, "sent to Claude")
            self.done = self.popup
        elif verb == "send-all":
            self.act("send-all", target, "sent the stream's open steps")
            self.done = self.popup
        elif verb == "dismiss":
            self.act("dismiss", target, "dismissed")
        elif verb == "archive":
            self.act("archive", target, "archived · /upnext shows the archive")

    def mouse(self, b, x, y, pressed):
        if b in (64, 65):  # wheel
            self.follow = False
            self.top += -3 if b == 64 else 3
            return
        if b & 32:  # motion
            self.hover_y = y
            return
        if not pressed or (b & 3) != 0:  # left button press only
            return
        line = self.screen.get(y)
        if line is None:
            return
        if line.row is not None:
            self.cursor = line.row
        for x0, x1, zone in line.zones:
            if x0 <= x - 1 < x1:
                self.run_zone(zone)
                return

    def key(self, k):
        if self.picker is not None:
            if k in ("\x1b", "q"):
                self.picker = None
            elif k.isdigit() and k != "0":
                self.pick(int(k) - 1)
            return True
        if k in ("q", "\x03", "\x1b"):
            return False
        sel = self.rows[self.cursor] if 0 <= self.cursor < len(self.rows) else None
        self.follow = True
        if k in ("j", f"{ESC}B"):
            self.cursor = min(self.cursor + 1, max(0, len(self.rows) - 1))
        elif k in ("k", f"{ESC}A"):
            self.cursor = max(0, self.cursor - 1)
        elif k.isdigit() and k != "0":
            n = int(k)
            if n <= len(self.numbered):
                self.run_zone(("draft", self.numbered[n - 1]))
        elif k == "g":
            self.cursor = 0
        elif k == "G":
            self.cursor = max(0, len(self.rows) - 1)
        elif sel is None:
            pass
        elif k == " " or (k in ("\r", "\n") and sel[0] == "root"):
            self.run_zone(("toggle", sel[1].get("id")))
        elif k in ("\r", "\n", "d"):
            self.run_zone(("draft", sel[2]["id"]))
        elif k == "s":
            self.run_zone(("send", sel[2]["id"]) if sel[0] == "step" else ("send-all", sel[1]["id"]))
        elif k == "x":
            self.run_zone(("dismiss", (sel[2] or sel[1])["id"]))
        elif k == "h" and (sel[0] == "step" or self.marked):
            self.run_zone(("hand", sel[2]["id"] if sel[0] == "step" else ""))
        elif k == "m" and sel[0] == "step":
            sid = sel[2]["id"]
            self.marked = [x for x in self.marked if x != sid] if sid in self.marked else self.marked + [sid]
            self.cursor = min(self.cursor + 1, max(0, len(self.rows) - 1))
        elif k == "u":
            self.marked = []
        elif k == "e":
            self.run_zone(("all", ""))
        elif k == "p":
            self.act("rank", "", "re-ranking…")
        elif k == "r" and self.marked:
            self.act("run-marked", self.marked[0], f"running {len(self.marked)} steps in order", ids=list(self.marked))
            self.marked = []
            self.done = self.popup
        elif k == "a" and sel[1].get("kind") == "stream":
            self.run_zone(("archive", sel[1]["id"]))
        return True

    def leave(self):
        """After a draft: a popup closes (herdr puts focus back); a split moves focus to Claude."""
        if self.popup:
            self.done = True
        else:
            self.focus_claude()

    def focus_claude(self):
        """Back to Claude's pane, so the draft can be edited and sent."""
        me = os.environ.get("HERDR_PANE_ID")
        if not me or not self.state.get("claudePane"):
            return
        herdr = os.environ.get("HERDR_BIN_PATH") or "herdr"
        try:
            subprocess.run([herdr, "pane", "focus", "--pane", me, "--direction", "left"], capture_output=True, timeout=3)
        except (OSError, subprocess.SubprocessError):
            pass


def events(fd):
    """Keys and mouse events waiting on the terminal."""
    data = os.read(fd, 1024).decode("utf-8", "ignore")
    out = []
    while data:
        if data.startswith(ESC + "<"):
            ends = [i for i in (data.find("M"), data.find("m")) if i > 0]
            end = min(ends) if ends else len(data)
            try:
                b, x, y = (int(n) for n in data[3:end].split(";"))
                out.append(("mouse", b, x, y, end < len(data) and data[end] == "M"))
            except ValueError:
                pass
            data = data[end + 1 :]
        elif data.startswith(ESC) and len(data) >= 3:
            out.append(("key", data[:3]))
            data = data[3:]
        else:
            out.append(("key", data[0]))
            data = data[1:]
    return out


def popup_paths():
    """The state of the Claude pane under the popup, else the most recently updated one."""
    folder = os.path.expanduser("~/.claude/upnext/herdr")
    pane = None
    try:
        ctx = json.loads(os.environ.get("HERDR_PLUGIN_CONTEXT_JSON") or "{}")
        stack = [ctx]
        while stack and pane is None:
            item = stack.pop()
            if isinstance(item, dict):
                if isinstance(item.get("pane_id"), str):
                    pane = item["pane_id"]
                stack.extend(item.values())
            elif isinstance(item, list):
                stack.extend(item)
    except ValueError:
        pane = None
    fid = lambda p: "".join(c if c.isalnum() or c in "_-" else "-" for c in p)
    if pane and os.path.exists(os.path.join(folder, fid(pane) + ".json")):
        base = os.path.join(folder, fid(pane))
        return [base + ".json", base + ".actions"]
    try:
        states = [os.path.join(folder, f) for f in os.listdir(folder) if f.endswith(".json")]
    except OSError:
        return None
    if not states:
        return None
    newest = max(states, key=os.path.getmtime)
    return [newest, newest[:-5] + ".actions"]


def main():
    args = sys.argv[1:]
    ascii_only = "--ascii" in args
    popup = "--popup" in args
    args = [a for a in args if a not in ("--ascii", "--popup")]
    if popup and not args:
        args = popup_paths()
        if not args:
            print("Up next: no Claude session in herdr has written its steps yet.")
            print("Run /upnext herdr in Claude once, then try again.")
            time.sleep(3)
            return 1
    if len(args) != 2:
        print(__doc__)
        return 2
    v = Viewer(args[0], args[1], ascii_only, popup)
    fd = sys.stdin.fileno()
    saved = termios.tcgetattr(fd)
    resized = [True]
    signal.signal(signal.SIGWINCH, lambda *_: resized.__setitem__(0, True))
    # Alternate screen, no cursor, mouse clicks + motion in SGR form.
    on = f"{ESC}?1049h{ESC}?25l{ESC}?1000h{ESC}?1003h{ESC}?1006h"
    off = f"{ESC}?1006l{ESC}?1003l{ESC}?1000l{ESC}?25h{ESC}?1049l"
    try:
        tty.setcbreak(fd)
        sys.stdout.write(on)
        v.load()
        v.draw()
        last_size = shutil.get_terminal_size((40, 24))
        while True:
            ready, _, _ = select.select([fd], [], [], 0.4)
            changed = v.load()
            if ready:
                for ev in events(fd):
                    if ev[0] == "mouse":
                        v.mouse(*ev[1:])
                    elif not v.key(ev[1]):
                        return 0
                if v.done:
                    time.sleep(0.15)
                    return 0
                changed = True
            if v.note and time.time() >= v.note_until:
                v.note = ""
                changed = True
            # herdr can settle a new pane's size after the first draw.
            size = shutil.get_terminal_size((40, 24))
            if size != last_size:
                last_size = size
                resized[0] = True
            if changed or resized[0]:
                resized[0] = False
                v.draw()
    except KeyboardInterrupt:
        return 0
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        sys.stdout.write(off)
        sys.stdout.flush()


if __name__ == "__main__":
    sys.exit(main())
