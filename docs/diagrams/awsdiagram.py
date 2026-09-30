"""Shared framework for the AWS-style architecture diagrams in docs/diagrams/.

  * official AWS icons from the `diagrams` package, embedded in the SVG
  * one colour = one meaning for every line (see LEGEND)
  * `Canvas`   : free-placement drawing (architecture / infrastructure / data model)
  * `Sequence` : fixed-grid sequence diagram with icon participants, phases, numbered steps

Every diagram script builds a Canvas or Sequence, then calls .save("NN-name").
Output: NN-name.svg + NN-name.png (PNG through headless Chromium via Playwright).

Setup:  pip install diagrams playwright pillow && playwright install chromium
"""
from __future__ import annotations

import base64
import os
from html import escape

import diagrams
from PIL import ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(os.path.dirname(diagrams.__file__))
FONT = "Helvetica, Arial, 'Liberation Sans', sans-serif"

# ---- palette: one colour = one meaning ---------------------------------------
NAVY = "#232F3E"
GREY = "#5F6B7A"
REST, GRPC, KAFKA, DATA, EGRESS = "#1B6EC2", "#1D8102", "#8C4FFF", "#5F6B7A", "#ED7100"
KIND = {  # message kind -> colour
    "rest": REST, "grpc": GRPC, "kafka": KAFKA, "data": DATA, "ext": EGRESS,
}
KIND_LABEL = {
    "rest": "HTTP / REST / GraphQL", "grpc": "gRPC between services", "kafka": "Kafka event (CloudEvents)",
    "data": "read / write to a datastore", "ext": "call to an external system",
}
PHASE_COLORS = {  # pale background, strong border/title
    "amber": ("#FFF8E7", "#B7791F"), "blue": ("#EEF5FD", "#1B6EC2"), "purple": ("#F6F0FF", "#6D3FD0"),
    "green": ("#EFF8EC", "#3F8624"), "red": ("#FFF1F2", "#C7254E"), "teal": ("#EAF8F8", "#008A8C"),
    "pink": ("#FEF1FC", "#B0209A"),
}

_FONTS = {}


def _font(size, bold=False):
    key = (size, bold)
    if key not in _FONTS:
        p = "/usr/share/fonts/truetype/liberation/LiberationSans-%s.ttf" % ("Bold" if bold else "Regular")
        _FONTS[key] = ImageFont.truetype(p, size)
    return _FONTS[key]


def tw(s, size=12, bold=False):
    """pixel width of the widest line of s"""
    return max((_font(size, bold).getlength(l) for l in s.split("\n")), default=0)


def wrap(s, maxw, size=12, bold=False):
    """word-wrap s (keeps explicit newlines) to maxw pixels; returns list of lines"""
    out = []
    for para in s.split("\n"):
        cur = ""
        for word in para.split(" "):
            t = (cur + " " + word).strip()
            if cur and tw(t, size, bold) > maxw:
                out.append(cur)
                cur = word
            else:
                cur = t
        out.append(cur)
    return out


_icon_cache = {}


def icon_uri(cls):
    p = os.path.join(SITE, cls._icon_dir, cls._icon)
    if p not in _icon_cache:
        _icon_cache[p] = "data:image/png;base64," + base64.b64encode(open(p, "rb").read()).decode()
    return _icon_cache[p]


class Canvas:
    def __init__(self, w, h, title, subtitle=None):
        self.w, self.h = w, h
        self.out = []
        self._markers = set()
        self.title, self.subtitle = title, subtitle

    # ---- primitives ------------------------------------------------------
    def add(self, s):
        self.out.append(s)

    def text(self, x, y, s, size=13, weight="normal", color=NAVY, anchor="middle", italic=False, lh=None):
        lh = lh or size + 3
        st = ' font-style="italic"' if italic else ""
        for i, ln in enumerate(s.split("\n")):
            self.add(f'<text x="{x}" y="{y + i * lh}" font-size="{size}" font-weight="{weight}" fill="{color}" '
                     f'text-anchor="{anchor}"{st}>{escape(ln)}</text>')

    def rect(self, x, y, w, h, stroke, fill="none", dash="", sw=1.6, rx=6, opacity=None):
        d = f' stroke-dasharray="{dash}"' if dash else ""
        o = f' fill-opacity="{opacity}"' if opacity is not None else ""
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"{o} stroke="{stroke}" '
                 f'stroke-width="{sw}"{d}/>')

    def group(self, x, y, w, h, title, color, fill="none", dash="6 4", size=15, sw=1.6):
        self.rect(x, y, w, h, color, fill, dash, sw)
        if title:
            self.text(x + 12, y + 22, title, size, "bold", color, "start")

    def icon(self, x, y, cls, label="", size=56, label_dy=22, lsize=12, color=NAVY):
        if cls is not None:
            self.add(f'<image x="{x - size / 2}" y="{y - size / 2}" width="{size}" height="{size}" href="{icon_uri(cls)}"/>')
        if label:
            self.text(x, y + size / 2 + label_dy - 6, label, lsize, "normal", color)

    def _marker(self, color):
        self._markers.add(color)
        return f"url(#a{color[1:]})"

    def line(self, pts, color, dash="", sw=2.2, head=True, tail=False, label=None, lpos=None, lsize=12, lcolor=None):
        d = "M" + " L".join(f"{x},{y}" for x, y in pts)
        da = f' stroke-dasharray="{dash}"' if dash else ""
        ms = f' marker-end="{self._marker(color)}"' if head else ""
        mt = f' marker-start="{self._marker(color)}"' if tail else ""
        self.add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}"{da}{ms}{mt} stroke-linejoin="round"/>')
        if label:
            lx, ly = lpos if lpos else ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2)
            lines = label.split("\n")
            w = tw(label, lsize) + 10
            h = len(lines) * (lsize + 3) + 4
            self.add(f'<rect x="{lx - w / 2}" y="{ly - lsize - 1}" width="{w}" height="{h}" fill="white" fill-opacity="0.92" rx="3"/>')
            self.text(lx, ly, label, lsize, "normal", lcolor or color)

    def badge(self, x, y, n, r=12, color=NAVY):
        self.add(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{color}"/>')
        fs = 14 if r >= 12 else 11
        self.add(f'<text x="{x}" y="{y + fs * 0.36}" font-size="{fs}" font-weight="bold" fill="white" text-anchor="middle">{n}</text>')

    def callout(self, x, y, w, title, body, color="#B7791F", fill="#FFF8E7", size=12):
        lines = []
        for para in body.split("\n"):
            lines += wrap(para, w - 28, size)
        h = 38 + len(lines) * (size + 4)
        self.rect(x, y, w, h, color, fill, "", 1.4, 8)
        self.text(x + 14, y + 22, title, 13, "bold", color, "start")
        self.text(x + 14, y + 42, "\n".join(lines), size, "normal", NAVY, "start", lh=size + 4)
        return h

    def legend(self, x, y, kinds, extra=None):
        self.text(x, y, "How to read the lines:", 14, "bold", NAVY, "start")
        cx = x + 190
        for k in kinds:
            c = KIND[k]
            self.line([(cx, y - 5), (cx + 40, y - 5)], c, sw=3, head=False)
            self.text(cx + 48, y, KIND_LABEL[k], 12, "normal", NAVY, "start")
            cx += 48 + tw(KIND_LABEL[k], 12) + 36
        self.line([(cx, y - 5), (cx + 40, y - 5)], GREY, dash="6 4", sw=2, head=False)
        self.text(cx + 48, y, "dashed = response / return", 12, "normal", NAVY, "start")
        if extra:
            self.text(x, y + 28, extra, 12, "normal", GREY, "start")

    # ---- output ----------------------------------------------------------
    def svg(self):
        head = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" '
                f'height="{self.h}" font-family="{FONT}">', "<defs>"]
        for c in sorted(self._markers | {REST, GRPC, KAFKA, DATA, EGRESS, NAVY}):
            head.append(f'<marker id="a{c[1:]}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" '
                        f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>')
        head.append("</defs>")
        head.append(f'<rect width="{self.w}" height="{self.h}" fill="white"/>')
        return "\n".join(head + self.out + ["</svg>"])

    def save(self, name, outdir=None):
        outdir = outdir or HERE
        svg_path = os.path.join(outdir, name + ".svg")
        open(svg_path, "w", encoding="utf-8").write(self.svg())
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            b = p.chromium.launch()
            pg = b.new_page(viewport={"width": int(self.w), "height": int(self.h)}, device_scale_factor=1.5)
            pg.goto("file://" + svg_path)
            pg.screenshot(path=os.path.join(outdir, name + ".png"))
            b.close()
        print(f"wrote {name}.svg / .png  ({int(self.w)}x{int(self.h)})")

    def header(self, cx=None):
        cx = cx if cx is not None else self.w / 2
        self.text(cx, 46, self.title, 28, "bold", NAVY)
        if self.subtitle:
            self.text(cx, 74, self.subtitle, 15, "normal", GREY)


# =============================================================================
class Sequence:
    """Sequence diagram in the AWS style.

    participants: list of dict(id, icon=<diagrams class>, label="2 line\\nlabel")
    zones:        list of (label, first_index, last_index, colour-name) grouping participant headers
    steps:        built with the helper methods below (phase / m / self_ / note / branch / gap)
    """

    ROW_PAD = 26

    def __init__(self, title, subtitle, participants, zones=(), spacing=230, margin=150, size=12):
        self.title, self.subtitle = title, subtitle
        self.p = participants
        self.zones = zones
        self.sp, self.margin, self.size = spacing, margin, size
        self.idx = {p["id"]: i for i, p in enumerate(participants)}
        self.steps = []
        self.footer = None
        self.kinds_used = []
        self.W = int(margin * 2 + spacing * (len(participants) - 1))

    def x(self, pid):
        return self.margin + self.sp * self.idx[pid]

    # -- step builders -------------------------------------------------------
    def phase(self, title, color="amber"):
        self.steps.append(("phase", title, color))

    def m(self, a, b, text, kind="rest", ret=False):
        if kind not in self.kinds_used:
            self.kinds_used.append(kind)
        self.steps.append(("m", a, b, text, kind, ret))

    def self_(self, a, text, kind="data"):
        if kind not in self.kinds_used:
            self.kinds_used.append(kind)
        self.steps.append(("self", a, text, kind))

    def note(self, over, text, side=None):
        over = [over] if isinstance(over, str) else list(over)
        self.steps.append(("note", over, text, side))

    def branch(self, kw, label):
        self.steps.append(("branch", kw, label))

    def gap(self, px=14):
        self.steps.append(("gap", px))

    # -- rendering -----------------------------------------------------------
    def build(self):
        S, W = self.size, self.W
        lh = S + 3
        HY = 235  # participant icon centre
        y = HY + 100  # first step top
        top_y = y
        laid = []  # (step, y_top, height, extra)
        for st in self.steps:
            kind = st[0]
            if kind == "phase":
                y += 16
                laid.append((st, y, 30, None))
                y += 36
            elif kind == "m":
                _, a, b, text, k, ret = st
                span = abs(self.x(a) - self.x(b)) if a != b else self.sp
                maxw = max(span - 26, 270)
                lines = wrap(text, maxw, S)
                h = len(lines) * lh + self.ROW_PAD
                laid.append((st, y, h, lines))
                y += h
            elif kind == "self":
                _, a, text, k = st
                lines = wrap(text, min(max(self.sp * 1.6, 300), 480), S)
                h = max(len(lines) * lh + 10, 30) + 18
                laid.append((st, y, h, lines))
                y += h
            elif kind == "note":
                _, over, text, side = st
                xs = [self.x(o) for o in over]
                if len(over) == 1:
                    w = 260
                    cx = xs[0] + ((w / 2 + 14) * (-1 if xs[0] > self.W - 420 else 1) if side == "right" else 0)
                    x0 = cx - w / 2
                else:
                    x0, w = min(xs) - 60, max(xs) - min(xs) + 120
                lines = wrap(text, w - 22, S - 1)
                h = len(lines) * (S + 2) + 16
                laid.append((st, y + 6, h, (x0, w, lines)))
                y += h + 18
            elif kind == "branch":
                laid.append((st, y + 4, 26, None))
                y += 34
            elif kind == "gap":
                y += st[1]
        # footer
        fh = 0
        if self.footer:
            y += 24
            flines = wrap(self.footer[1], W - 2 * 60 - 40, S + 1)
            fh = 42 + len(flines) * (S + 5)
        end_y = y
        H = int(end_y + fh + 130 + 90)  # bottom participants + legend
        c = Canvas(W, H, self.title, self.subtitle)
        c.header()

        # zones around the participant headers
        for label, i0, i1, colour in self.zones:
            bg, fg = PHASE_COLORS[colour]
            x0 = self.margin + self.sp * i0 - self.sp / 2 + 10
            x1 = self.margin + self.sp * i1 + self.sp / 2 - 10
            c.group(x0, 110, x1 - x0, 205, label, fg, bg, "6 4", 13)

        # phase bands (behind everything else)
        phases = [(s, t, h) for s, t, h, _ in laid if s[0] == "phase"]
        for i, (s, t, h) in enumerate(phases):
            nxt = phases[i + 1][1] - 6 if i + 1 < len(phases) else end_y - 8
            bg, fg = PHASE_COLORS[s[2]]
            c.rect(40, t - 4, W - 80, nxt - t + 4, fg, bg, "", 1.3, 10)
        # lifelines
        for p in self.p:
            xx = self.x(p["id"])
            c.add(f'<line x1="{xx}" y1="{HY + 86}" x2="{xx}" y2="{end_y + 20}" stroke="#AEB6C2" stroke-width="1.4" stroke-dasharray="5 5"/>')
        # participant headers (top and bottom)
        for yy in (HY, end_y + fh + 70):
            for p in self.p:
                c.icon(self.x(p["id"]), yy, p["icon"], p["label"], 54, 26, 12)
        if fh:  # bottom lifelines stop at footer
            pass

        n = 0
        for st, yt, h, extra in laid:
            kind = st[0]
            if kind == "phase":
                bg, fg = PHASE_COLORS[st[2]]
                c.text(60, yt + 16, st[1], 15, "bold", fg, "start")
            elif kind == "m":
                _, a, b, text, k, ret = st
                n += 1
                col = KIND[k]
                x1, x2 = self.x(a), self.x(b)
                nl = len(extra)
                ay = yt + nl * lh + 12
                mid = (x1 + x2) / 2
                tw_ = max(tw(l, S) for l in extra)
                # text block above the arrow
                c.add(f'<rect x="{mid - tw_ / 2 - 5}" y="{yt + 2}" width="{tw_ + 10}" height="{nl * lh + 2}" fill="white" fill-opacity="0.85" rx="3"/>')
                c.text(mid, yt + S + 3, "\n".join(extra), S, "normal", NAVY, "middle", lh=lh)
                c.badge(mid - tw_ / 2 - 20, yt + S - 1, n, 10)
                d = 1 if x2 > x1 else -1
                c.line([(x1 + 4 * d, ay), (x2 - 2 * d, ay)], col, "6 4" if ret else "", 2.2 if not ret else 1.8)
            elif kind == "self":
                _, a, text, k = st
                n += 1
                col = KIND[k]
                xx = self.x(a)
                left = xx > W - 520
                if left:
                    c.badge(xx - 66, yt + 12, n, 10)
                    c.text(xx - 84, yt + 16, "\n".join(extra), S, "normal", NAVY, "end", lh=lh)
                    c.line([(xx - 2, yt + 6), (xx - 46, yt + 6), (xx - 46, yt + 26), (xx - 4, yt + 26)], col, "", 2.2)
                else:
                    c.badge(xx + 66, yt + 12, n, 10)
                    c.text(xx + 84, yt + 16, "\n".join(extra), S, "normal", NAVY, "start", lh=lh)
                    c.line([(xx + 2, yt + 6), (xx + 46, yt + 6), (xx + 46, yt + 26), (xx + 4, yt + 26)], col, "", 2.2)
            elif kind == "note":
                x0, w, lines = extra
                c.rect(x0, yt, w, h, "#B7791F", "#FFF3CC", "", 1.2, 6)
                c.text(x0 + 11, yt + 18, "\n".join(lines), S - 1, "normal", NAVY, "start", lh=S + 2)
            elif kind == "branch":
                _, kw, label = st
                c.add(f'<line x1="52" y1="{yt + 12}" x2="{W - 52}" y2="{yt + 12}" stroke="{GREY}" stroke-width="1.2" stroke-dasharray="3 5"/>')
                lab = f"{kw.upper()}  {label}"
                w = tw(lab, S, True) + 20
                c.rect(60, yt, w, 24, GREY, "white", "", 1.2, 12)
                c.text(70, yt + 16, lab, S, "bold", GREY, "start")

        if self.footer:
            ttl, body = self.footer
            fy = end_y + 6
            c.callout(60, fy, W - 120, ttl, body, "#232F3E", "#F3F5F8", S + 1)
        c.legend(60, H - 44, [k for k in KIND if k in self.kinds_used])
        return c

    def save(self, name, outdir=None):
        self.build().save(name, outdir)
