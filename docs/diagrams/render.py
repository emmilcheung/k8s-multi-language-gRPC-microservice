#!/usr/bin/env python3
"""Render helper for the v2 diagrams.

  1. Re-runs 01-aws-infrastructure.py to refresh the SVG + PNG.
  2. Wraps each .mermaid source in a self-contained HTML page that loads
     Mermaid from a CDN, so the user can double-click the HTML and preview.
  3. Produces an index.html landing page that links all four diagrams.

Usage:
    python3 render.py
"""
from __future__ import annotations

import subprocess
from pathlib import Path

HERE = Path(__file__).parent

MERMAID_DIAGRAMS = [
    ("02-data-model.mermaid", "02-data-model.html",
     "Data Model — per-service ownership"),
    ("03-c4-container.mermaid", "03-c4-container.html",
     "C4 Container — service topology & protocols"),
    ("04-data-flow-sequence.mermaid", "04-data-flow-sequence.html",
     "Data Flow — reservation + payment saga (sequence)"),
    ("05-auth-flows.mermaid", "05-auth-flows.html",
     "Auth Flows — signup, login, JWT refresh"),
    ("06-waiting-room-flow.mermaid", "06-waiting-room-flow.html",
     "Virtual Waiting Room — onsale surge gate flow"),
    ("07-search-dataflow.mermaid", "07-search-dataflow.html",
     "Search Dataflow — CQRS index + query (with Mongo fallback)"),
]


HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title}</title>
  <style>
    :root {{ color-scheme: light; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      margin: 0;
      padding: 24px;
      background: #F7F8FA;
      color: #232F3E;
    }}
    header {{
      max-width: 1400px;
      margin: 0 auto 16px auto;
    }}
    header h1 {{ margin: 0 0 4px 0; font-size: 20px; }}
    header p {{ margin: 0; color: #556070; font-size: 13px; }}
    .card {{
      background: #fff;
      border: 1px solid #E5E7EB;
      border-radius: 12px;
      padding: 24px;
      max-width: 1400px;
      margin: 0 auto;
      overflow-x: auto;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }}
    .nav {{
      max-width: 1400px;
      margin: 0 auto 12px auto;
      font-size: 13px;
    }}
    .nav a {{ color: #1A73E8; text-decoration: none; margin-right: 12px; }}
    .nav a:hover {{ text-decoration: underline; }}
  </style>
</head>
<body>
  <div class="nav">
    <a href="index.html">← Index</a>
    <a href="01-aws-infrastructure.svg">AWS Infra (SVG)</a>
    <a href="02-data-model.html">Data Model</a>
    <a href="03-c4-container.html">C4 Container</a>
    <a href="04-data-flow-sequence.html">Data Flow</a>
    <a href="05-auth-flows.html">Auth Flows</a>
    <a href="06-waiting-room-flow.html">Waiting Room</a>
    <a href="07-search-dataflow.html">Search Dataflow</a>
  </div>
  <header>
    <h1>{title}</h1>
    <p>Rendered client-side via Mermaid 11. Source: <code>{source}</code></p>
  </header>
  <div class="card">
    <pre class="mermaid">
{content}
    </pre>
  </div>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({{
      startOnLoad: true,
      theme: "base",
      securityLevel: "loose",
      er: {{ useMaxWidth: true }},
      sequence: {{ useMaxWidth: true, actorMargin: 60, messageAlign: "center" }},
      flowchart: {{ useMaxWidth: true, htmlLabels: true, curve: "basis" }}
    }});
  </script>
</body>
</html>
"""


INDEX_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ticketing Platform — Architecture Diagrams (v2)</title>
  <style>
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
      margin: 0;
      padding: 48px 24px;
      background: #F7F8FA;
      color: #232F3E;
    }}
    main {{ max-width: 960px; margin: 0 auto; }}
    h1 {{ font-size: 28px; margin: 0 0 8px 0; }}
    p.sub {{ color: #556070; margin: 0 0 28px 0; }}
    .grid {{ display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }}
    .tile {{
      background: #fff;
      border: 1px solid #E5E7EB;
      border-radius: 12px;
      padding: 20px 22px;
      text-decoration: none;
      color: inherit;
      transition: border-color .15s, transform .15s;
      display: block;
    }}
    .tile:hover {{ border-color: #FF9900; transform: translateY(-2px); }}
    .tile h2 {{ margin: 0 0 6px 0; font-size: 16px; color: #232F3E; }}
    .tile p {{ margin: 0; color: #556070; font-size: 13px; }}
    .badge {{
      display: inline-block; font-size: 11px; padding: 2px 8px;
      border-radius: 999px; margin-bottom: 8px; font-weight: 600;
    }}
    .b-aws {{ background: #FFE6BF; color: #8A4B00; }}
    .b-mer {{ background: #D9E8FC; color: #0B3D91; }}
  </style>
</head>
<body>
  <main>
    <h1>Ticketing Platform — Architecture Diagrams</h1>
    <p class="sub">Diagrams covering AWS infrastructure, per-service data ownership,
      C4 container topology, the reservation + payment saga, auth flows, the virtual
      waiting room, and the OpenSearch search dataflow. Generated from source — kept in sync with the code.</p>
    <div class="grid">
      <a class="tile" href="01-aws-infrastructure.svg">
        <span class="badge b-aws">Graphviz · SVG/PNG</span>
        <h2>1 · AWS Infrastructure</h2>
        <p>Reference production architecture on EKS: VPC, MSK, RDS Multi-AZ,
          ElastiCache, Kong, edge services, observability, IRSA.</p>
      </a>
      <a class="tile" href="02-data-model.html">
        <span class="badge b-mer">Mermaid · ER</span>
        <h2>2 · Data Model</h2>
        <p>Per-service database ownership. Dotted lines mark
          <i>logical</i> cross-service references (no enforced FKs).</p>
      </a>
      <a class="tile" href="03-c4-container.html">
        <span class="badge b-mer">Mermaid · C4</span>
        <h2>3 · C4 Container Diagram</h2>
        <p>All 10 services grouped by domain (Identity · Catalog · Transaction),
          showing REST, gRPC, GraphQL Federation and Kafka protocols.</p>
      </a>
      <a class="tile" href="04-data-flow-sequence.html">
        <span class="badge b-mer">Mermaid · Sequence</span>
        <h2>4 · Data Flow / Saga</h2>
        <p>Full reservation → payment → finalize / expire flow with
          CloudEvents on MSK, transactional outbox, DLQ.</p>
      </a>
      <a class="tile" href="05-auth-flows.html">
        <span class="badge b-mer">Mermaid · Sequence</span>
        <h2>5 · Auth Flows</h2>
        <p>Signup / login / refresh, RS256 JWT issuance, and JWKS
          distribution to Kong for gateway-side verification.</p>
      </a>
      <a class="tile" href="06-waiting-room-flow.html">
        <span class="badge b-mer">Mermaid · Sequence</span>
        <h2>6 · Virtual Waiting Room</h2>
        <p>Onsale surge gate: pre-queue fair draw, rate-based admission,
          single-use HMAC pass, clean-URL redemption.</p>
      </a>
      <a class="tile" href="07-search-dataflow.html">
        <span class="badge b-mer">Mermaid · Sequence</span>
        <h2>7 · Search Dataflow</h2>
        <p>OpenSearch CQRS read model: Kafka-fed index path and the
          ranked query path with live Mongo hydration + regex fallback.</p>
      </a>
    </div>
  </main>
</body>
</html>
"""


def wrap_mermaid(src: Path, out: Path, title: str) -> None:
    content = src.read_text(encoding="utf-8")
    # Mermaid is whitespace-sensitive in <pre>; we keep it verbatim.
    html = HTML_TEMPLATE.format(title=title, source=src.name, content=content)
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out.name}")


def main() -> None:
    # Rebuild the infra SVG/PNG.
    infra_py = HERE / "01-aws-infrastructure.py"
    print("→ rendering AWS infrastructure (Graphviz)…")
    subprocess.run(["python3", str(infra_py)], cwd=HERE, check=True)

    # Wrap each Mermaid source in an HTML page.
    for src_name, out_name, title in MERMAID_DIAGRAMS:
        wrap_mermaid(HERE / src_name, HERE / out_name, title)

    # Landing page.
    (HERE / "index.html").write_text(INDEX_TEMPLATE, encoding="utf-8")
    print("wrote index.html")


if __name__ == "__main__":
    main()
