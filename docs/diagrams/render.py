#!/usr/bin/env python3
"""Render helper for the architecture diagrams.

  1. Re-runs every NN-*.py drawing script (AWS icons, awsdiagram.py) to refresh the SVG + PNG
     (skip with --pages-only).
  2. Writes one viewer page per diagram (sidebar listing every diagram, zoom, SVG embed), so
     you can move between diagrams without the browser's back button.
  3. Writes index.html, the landing page whose tiles open the viewer pages.

Add a diagram: drop NN-name.py + NN-name.svg here and add one row to DIAGRAMS.

Usage:
    python3 render.py [--pages-only]
"""
from __future__ import annotations

import subprocess
import sys
from html import escape
from pathlib import Path

HERE = Path(__file__).parent

# (file stem, nav label, kind, sidebar colour, description). Order is the order shown.
# A stem with a .py script is redrawn; 03 is a pre-rendered SVG with no script.
DIAGRAMS = [
    ("01-aws-infrastructure", "AWS Infrastructure", "AWS icons", "#FF9900",
     "Reference production architecture on EKS: VPC, MSK, RDS Multi-AZ, ElastiCache, Kong, edge services, observability, IRSA."),
    ("08-aws-architecture", "AWS Architecture (service view)", "AWS icons", "#F97316",
     "Edge, VPC and EKS services grouped by domain (Identity, Catalog, Transaction), with REST, gRPC, GraphQL Federation and Kafka flows on one page."),
    ("02-data-model", "Data Model", "AWS icons", "#2563EB",
     "Per-service database ownership. Dotted lines mark logical cross-service references (no enforced foreign keys)."),
    ("03-c4-container", "C4 Container", "C4", "#8B5CF6",
     "Service topology and protocols."),
    ("04-data-flow-sequence", "Data Flow / Saga", "Sequence", "#10B981",
     "Reservation, payment, finalize and expire flow with CloudEvents on MSK, transactional outbox and DLQ."),
    ("05-auth-flows", "Auth Flows (web)", "Sequence", "#EF4444",
     "Browser sign-in, refresh rotation with family revocation, internal gRPC trust and the Stripe webhook; RS256 JWTs verified at Kong."),
    ("09-mcp-auth-flows", "MCP Auth Flows", "Sequence", "#14B8A6",
     "How an MCP agent gets access: OAuth 2.1 + PKCE, client metadata document (CIMD) or dynamic registration, consent, audience-bound tokens, per-call token exchange, scope step-up, revocation."),
    ("06-waiting-room-flow", "Virtual Waiting Room", "Sequence", "#EAB308",
     "Onsale surge gate: pre-queue fair draw, rate-based admission, single-use HMAC pass, clean-URL redemption."),
    ("07-search-dataflow", "Search Dataflow", "Sequence", "#6366F1",
     "OpenSearch CQRS read model: Kafka-fed index path and the ranked query path with live Mongo hydration and regex fallback."),
]

PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{label} - Ticketing Platform</title>
  <link rel="stylesheet" href="style.css" />
  <script src="zoom.js"></script>
</head>
<body>
<div class="page">

  <nav class="sidebar">
    <div class="sidebar-brand">
      <a class="sidebar-back" href="index.html">&larr; All diagrams</a>
      <div class="sidebar-brand-title">Ticketing Platform</div>
      <div class="sidebar-brand-sub">Architecture Diagrams</div>
    </div>
    <div class="sidebar-nav">
      <div class="sidebar-nav-label">Diagrams</div>
{items}
    </div>
  </nav>

  <div class="main">
    <div class="main-header">
      <h1>{label}</h1>
      <p>{description} Files: <a href="{stem}.svg">SVG</a> &middot; <a href="{stem}.png">PNG</a></p>
    </div>
    <div class="diagram-wrapper">
      <div class="zoom-bar">
        <button class="zoom-btn" id="zoom-out"   title="Zoom out (-)">&#x2212;</button>
        <span class="zoom-level" id="zoom-level">100%</span>
        <button class="zoom-btn" id="zoom-in"    title="Zoom in (+)">+</button>
        <button class="zoom-btn zoom-btn-reset" id="zoom-reset" title="Reset (0)">&#x21BA;</button>
      </div>
      <div class="diagram-card">
        <img src="{stem}.svg" alt="{label} diagram" style="max-width:100%;height:auto;display:block;" />
      </div>
    </div>
  </div>

</div>
</body>
</html>
"""

ITEM_TEMPLATE = """      <a class="sidebar-item{active}" href="{stem}.html">
        <span class="sidebar-dot" style="background:{colour};"></span>
        <span class="sidebar-item-label">
          {label}
          <span class="sidebar-item-sub">{kind}</span>
        </span>
      </a>
"""

# Plain string, not .format()ed: the CSS braces stay single.
INDEX_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ticketing Platform - Architecture Diagrams</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      margin: 0;
      padding: 48px 24px;
      background: #F7F8FA;
      color: #232F3E;
    }
    main { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 28px; margin: 0 0 8px 0; }
    p.sub { color: #556070; margin: 0 0 28px 0; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
    .tile {
      background: #fff;
      border: 1px solid #E5E7EB;
      border-radius: 12px;
      padding: 20px 22px;
      text-decoration: none;
      color: inherit;
      transition: border-color .15s, transform .15s;
      display: block;
    }
    .tile:hover { border-color: #FF9900; transform: translateY(-2px); }
    .tile h2 { margin: 0 0 6px 0; font-size: 16px; color: #232F3E; }
    .tile p { margin: 0; color: #556070; font-size: 13px; }
    .badge {
      display: inline-block; font-size: 11px; padding: 2px 8px;
      border-radius: 999px; margin-bottom: 8px; font-weight: 600;
      background: #E8EEF7; color: #1F3B63;
    }
  </style>
</head>
<body>
  <main>
    <h1>Ticketing Platform - Architecture Diagrams</h1>
    <p class="sub">AWS infrastructure, service view, data ownership, the reservation and payment saga,
      web and MCP authentication, the virtual waiting room and search. Generated from source
      (<code>docs/diagrams/*.py</code>) and kept in sync with the code.</p>
    <div class="grid">
%TILES%
    </div>
  </main>
</body>
</html>
"""

TILE_TEMPLATE = """      <a class="tile" href="{stem}.html">
        <span class="badge">{kind}</span>
        <h2>{n} &middot; {label}</h2>
        <p>{description}</p>
      </a>"""


def write_pages() -> None:
    for stem, label, _kind, _colour, description in DIAGRAMS:
        items = "".join(
            ITEM_TEMPLATE.format(active=" active" if s == stem else "", stem=s,
                                 colour=c, label=escape(l), kind=k)
            for s, l, k, c, _ in DIAGRAMS)
        html = PAGE_TEMPLATE.format(stem=stem, label=escape(label),
                                    description=escape(description), items=items.rstrip("\n"))
        (HERE / f"{stem}.html").write_text(html, encoding="utf-8")
        print(f"wrote {stem}.html")

    tiles = "\n".join(
        TILE_TEMPLATE.format(stem=s, kind=k, n=i, label=escape(l), description=escape(d))
        for i, (s, l, k, _c, d) in enumerate(DIAGRAMS, 1))
    (HERE / "index.html").write_text(INDEX_TEMPLATE.replace("%TILES%", tiles), encoding="utf-8")
    print("wrote index.html")


def main() -> None:
    if "--pages-only" not in sys.argv:
        # Redraw every AWS-icon diagram (shared framework: awsdiagram.py).
        for stem, *_ in DIAGRAMS:
            script = HERE / f"{stem}.py"
            if script.exists():
                print(f"-> drawing {script.name} ...")
                subprocess.run([sys.executable, str(script)], cwd=HERE, check=True)
    for stem, *_ in DIAGRAMS:
        if not (HERE / f"{stem}.svg").exists():
            sys.exit(f"missing {stem}.svg")
    write_pages()


if __name__ == "__main__":
    main()
