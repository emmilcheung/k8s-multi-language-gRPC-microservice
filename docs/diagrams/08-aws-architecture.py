"""AWS architecture diagram (official AWS icons) for the ticketing platform.

Hand-placed layout (fixed coordinates) so the picture reads like an AWS
reference architecture: Edge -> VPC (public / EKS / messaging / data) -> guardrails.
Icons come from the `diagrams` package (official AWS / SaaS icon set).

Sources of truth
  docs/diagrams/03-c4-container.mermaid  services, protocols, Kafka topics
  infra/terraform/environments/prod      us-east-1, VPC 10.2.0.0/16, EKS 1.30,
                                         RDS PG16 Multi-AZ, ElastiCache, MSK x3, Kong x3

Run:    pip install diagrams playwright && playwright install chromium
        python3 08-aws-architecture.py        # writes .svg and .png next to it
"""
import base64
import os
from html import escape

import diagrams
from diagrams.aws.analytics import AmazonOpensearchService, Glue, ManagedStreamingForKafka
from diagrams.aws.compute import ECR, EKS, Fargate
from diagrams.aws.database import DocumentDB, ElasticacheForRedis, RDSPostgresqlInstance
from diagrams.aws.devtools import XRay
from diagrams.aws.general import Users
from diagrams.aws.integration import SimpleNotificationServiceSnsEmailNotification as SES
from diagrams.aws.management import Cloudtrail, Cloudwatch
from diagrams.aws.network import CloudFront, NATGateway, NLB, Route53
from diagrams.aws.security import ACM, IAMRole, KMS, SecretsManager, Shield, WAF
from diagrams.saas.payment import Stripe

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(os.path.dirname(diagrams.__file__))
FONT = "Helvetica, Arial, 'Liberation Sans', 'DejaVu Sans', sans-serif"

# meaning of each line colour (see legend)
REST, GRPC, KAFKA, DATA, EGRESS = "#1B6EC2", "#1D8102", "#8C4FFF", "#5F6B7A", "#ED7100"
NAVY = "#232F3E"

W, H = 2400, 1800
out = []


def add(s):
    out.append(s)


_icon_cache = {}


def icon_uri(cls):
    p = os.path.join(SITE, cls._icon_dir, cls._icon)
    if p not in _icon_cache:
        _icon_cache[p] = "data:image/png;base64," + base64.b64encode(open(p, "rb").read()).decode()
    return _icon_cache[p]


def text(x, y, s, size=13, weight="normal", color=NAVY, anchor="middle", italic=False):
    lines = s.split("\n")
    st = ' font-style="italic"' if italic else ""
    for i, ln in enumerate(lines):
        add(f'<text x="{x}" y="{y + i * (size + 3)}" font-size="{size}" font-weight="{weight}" '
            f'fill="{color}" text-anchor="{anchor}"{st}>{escape(ln)}</text>')


def rect(x, y, w, h, stroke, fill="none", dash="", sw=1.6, rx=6):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" '
        f'stroke-width="{sw}"{d}/>')


def group(x, y, w, h, title, color, fill="none", dash="6 4", size=15, sw=1.6):
    rect(x, y, w, h, color, fill, dash, sw)
    text(x + 12, y + 22, title, size, "bold", color, "start")


def icon(x, y, cls, label, size=56, label_dy=22, lsize=12, sub=None):
    add(f'<image x="{x - size / 2}" y="{y - size / 2}" width="{size}" height="{size}" href="{icon_uri(cls)}"/>')
    text(x, y + size / 2 + label_dy - 6, label, lsize, "normal", NAVY)


def tw(s, size):  # rough text width
    return max(len(l) for l in s.split("\n")) * size * 0.56


def line(pts, color, dash="", sw=2.2, head=True, tail=False, label=None, lpos=None, lsize=12, lcolor=None):
    d = "M" + " L".join(f"{x},{y}" for x, y in pts)
    da = f' stroke-dasharray="{dash}"' if dash else ""
    ms = f' marker-end="url(#a{color[1:]})"' if head else ""
    mt = f' marker-start="url(#a{color[1:]})"' if tail else ""
    add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}"{da}{ms}{mt} stroke-linejoin="round"/>')
    if label:
        lx, ly = lpos if lpos else ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2)
        lines = label.split("\n")
        w = tw(label, lsize) + 10
        h = len(lines) * (lsize + 3) + 4
        add(f'<rect x="{lx - w / 2}" y="{ly - lsize - 1}" width="{w}" height="{h}" fill="white" fill-opacity="0.92" rx="3"/>')
        text(lx, ly, label, lsize, "normal", lcolor or color)


def badge(x, y, n):
    add(f'<circle cx="{x}" cy="{y}" r="12" fill="{NAVY}"/>')
    add(f'<text x="{x}" y="{y + 5}" font-size="14" font-weight="bold" fill="white" text-anchor="middle">{n}</text>')


# ============================================================== canvas
add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="{FONT}">')
add("<defs>")
for c in (REST, GRPC, KAFKA, DATA, EGRESS):
    add(f'<marker id="a{c[1:]}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" '
        f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{c}"/></marker>')
add("</defs>")
add(f'<rect width="{W}" height="{H}" fill="white"/>')
text(W / 2 - 60, 46, "Ticketing platform on AWS: 9 microservices on EKS, event-driven with Kafka", 28, "bold", NAVY)
text(W / 2 - 60, 74, "Numbers 1-5 follow one customer request from the browser to the services", 15, "normal", "#5F6B7A")

# AWS cloud frame
rect(190, 100, 2170, 1590, NAVY, "white", "", 1.8, 2)
text(212, 126, "AWS Cloud  -  us-east-1", 17, "bold", NAVY, "start")

# ================================================================ EDGE
group(230, 145, 2090, 190, "Edge: TLS, DDoS and bot filtering before traffic reaches the VPC", "#B7791F", "#FFF8E7")
icon(95, 250, Users, "Customers\nbrowser + mobile", 64, 30)
icon(330, 235, WAF, "AWS WAF")
icon(410, 235, Shield, "Shield")
icon(560, 235, CloudFront, "CloudFront")
icon(900, 235, Route53, "Route 53")
icon(1240, 235, ACM, "ACM\nTLS certificates")
line([(140, 250), (295, 250)], NAVY, label="HTTPS", lpos=(215, 240))
line([(440, 250), (525, 250)], NAVY, label="filtered", lpos=(485, 238))
line([(865, 250), (595, 250)], NAVY, dash="6 4", label="DNS", lpos=(730, 240))
badge(140, 222, 1)

# ================================================================ VPC
group(210, 365, 1730, 1050, "VPC 10.2.0.0/16  (multi-AZ)", "#8C4FFF", "#FCFAFF", "", 16, 2)

# ---- public subnet
group(235, 395, 1680, 135, "Public subnets", "#3F8624", "#F4F9F0")
icon(560, 462, NLB, "Network LB\n(Kong proxy)", 56, 28)
icon(1885, 462, NATGateway, "", 56)
text(1845, 458, "NAT Gateway\n(outbound only)", 12, "normal", NAVY, "end")
line([(560, 280), (560, 425)], REST, label="origin: HTTPS only", lpos=(560, 352))
badge(600, 330, 2)

# ---- EKS (private app subnets)
group(235, 555, 1665, 470, "Private subnets  -  Amazon EKS 1.30   (m5.large nodes, autoscale 3-20)", "#008A8C", "#EEF9F9")
icon(560, 700, Fargate, "kong-gateway  x3\nJWT | rate limit | CORS | CSRF", 56, 28)
icon(560, 895, Fargate, "client\nNext.js 16 SSR", 56, 28)
icon(790, 700, Fargate, "apollo-router\nGraphQL federation", 56, 28)
line([(560, 530), (560, 668)], REST)
badge(597, 600, 3)
line([(560, 735), (560, 863)], REST, label="SSR", lpos=(586, 805))
line([(600, 700), (750, 700)], REST, label="4  POST /graphql", lpos=(672, 688))

# domain groups
X = dict(auth=940, user=1080, ticket=1240, venue=1380, order=1540, expiration=1680, payment=1820)
group(870, 672, 280, 190, "Identity", "#1B6EC2", "#F3F8FD", "", 14)
group(1170, 672, 280, 190, "Catalog", "#1B6EC2", "#F3F8FD", "", 14)
group(1470, 672, 420, 190, "Transaction", "#1B6EC2", "#F3F8FD", "", 14)
SY = 745
icon(X["auth"], SY, Fargate, "auth-service\nNestJS", 52, 26)
icon(X["user"], SY, Fargate, "user-service\nNestJS", 52, 26)
icon(X["ticket"], SY, Fargate, "ticket-service\nGo | gqlgen", 52, 26)
icon(X["venue"], SY, Fargate, "venue-service\nGo | gqlgen", 52, 26)
icon(X["order"], SY, Fargate, "order-service\nJava | Spring Boot", 52, 26)
icon(X["expiration"], SY, Fargate, "expiration-svc\nGo | timers", 52, 26)
icon(X["payment"], SY, Fargate, "payment-service\nNestJS", 52, 26)

# REST trunk (solid) and GraphQL federation trunk (dashed)
line([(560, 668), (560, 610), (1010, 610), (1010, 672)], REST, label="REST  /auth /users", lpos=(790, 600))
line([(1010, 610), (1310, 610), (1310, 672)], REST, head=True, label="REST  /tickets /venues", lpos=(1160, 600))
line([(1310, 610), (1620, 610), (1620, 672)], REST, label="REST  /orders /payments\n+ Stripe webhook", lpos=(1465, 591))
line([(790, 668), (790, 640), (1040, 640), (1040, 672)], REST, dash="7 4", sw=1.8)
line([(1040, 640), (1340, 640), (1340, 672)], REST, dash="7 4", sw=1.8)
line([(1340, 640), (1650, 640), (1650, 672)], REST, dash="7 4", sw=1.8, label="5  federated subgraph queries", lpos=(1150, 656), lsize=11)

# gRPC lanes below the service row
line([(X["order"] - 14, 826), (X["order"] - 14, 925), (X["venue"] + 10, 925), (X["venue"] + 10, 826)], GRPC, sw=3,
     label="gRPC  ReserveHeldSeats | AutoAssign | Finalize", lpos=(1460, 945), lsize=11)
line([(X["order"] - 30, 826), (X["order"] - 30, 985), (X["ticket"] + 10, 985), (X["ticket"] + 10, 826)], GRPC, sw=3,
     label="gRPC  ReserveQuota | Finalize | Release", lpos=(1390, 1004), lsize=11)
line([(X["ticket"] + 30, 745), (X["venue"] - 30, 745)], GRPC, sw=3)
text((X["ticket"] + X["venue"]) / 2, 722, "gRPC\nGetSeatingPlan", 10, "normal", GRPC)

# ---- messaging + data subnets
group(235, 1050, 1665, 345, "Private data subnets  -  no public route, Multi-AZ, encrypted with KMS", "#B0209A", "#FEF4FD")
# ---- data stores, placed under their owners
DY = 1275
D = dict(auth=940, user=1080, ticket=1215, search=1305, venue=1400, redis=1680, order=1540, payment=1820)
icon(D["auth"], DY, RDSPostgresqlInstance, "auth_db\nRDS PostgreSQL", 52, 26)
icon(D["user"], DY, RDSPostgresqlInstance, "user_db\nRDS PostgreSQL", 52, 26)
icon(D["ticket"], DY, DocumentDB, "ticket_db\nDocumentDB", 52, 26)
icon(D["search"], DY, AmazonOpensearchService, "OpenSearch\nsearch read model", 52, 26)
icon(D["venue"], DY, RDSPostgresqlInstance, "venue_db\nRDS PostgreSQL", 52, 26)
icon(D["order"], DY, RDSPostgresqlInstance, "order_db + outbox\nRDS PostgreSQL", 52, 26)
icon(D["payment"], DY, RDSPostgresqlInstance, "payment_db\nRDS PostgreSQL", 52, 26)
icon(D["redis"], DY, ElasticacheForRedis, "ElastiCache Redis\ntimers | seat holds | idempotency", 52, 26)
text(1010, 1370, "Each service owns exactly one datastore; no cross-service DB access.", 12, "normal", "#8A1B78", "middle", True)

for k in ("auth", "user"):
    line([(X[k] + 12, 830), (X[k] + 12, 1245)], DATA, sw=2)
line([(X["ticket"] + 12, 830), (X["ticket"] + 12, 1198), (D["ticket"], 1198), (D["ticket"], 1245)], DATA, sw=2)
line([(X["ticket"] + 12, 1198), (D["search"], 1198), (D["search"], 1245)], DATA, dash="6 4", sw=2, label="index + search", lpos=(1300, 1190), lsize=11)
line([(X["venue"] + 12, 830), (X["venue"] + 12, 1245)], DATA, sw=2) if False else None
line([(X["venue"] + 12, 830), (X["venue"] + 12, 1215), (D["venue"], 1215), (D["venue"], 1245)], DATA, sw=2)
line([(X["venue"] + 12, 1215), (D["redis"] - 25, 1215), (D["redis"] - 25, 1245)], DATA, dash="6 4", sw=2)
line([(X["order"] + 12, 830), (X["order"] + 12, 1245)], DATA, sw=2)
line([(X["expiration"] + 12, 830), (X["expiration"] + 12, 1245 - 30), (D["redis"] + 12, 1215), (D["redis"] + 12, 1245)], DATA, sw=2) if False else None
line([(X["expiration"] + 12, 830), (X["expiration"] + 12, 1245)], DATA, sw=2)
line([(X["payment"] + 12, 830), (X["payment"] + 12, 1245)], DATA, sw=2)

# MSK band
rect(880, 1082, 1000, 80, KAFKA, "#F6F0FF", "", 2, 10)
icon(925, 1122, ManagedStreamingForKafka, "", 46)
text(1010, 1108, "Amazon MSK  -  Kafka 3.7 KRaft, 3 brokers (m5.large), CloudEvents envelopes", 13, "bold", KAFKA, "start")
text(1010, 1128, "orders.order.{created,cancelled,completed}   tickets.ticket.{created,updated}", 12, "normal", KAFKA, "start")
text(1010, 1147, "payments.payment.*   expiration.order.expiration_complete   ( DLQ: <topic>.dlq )", 12, "normal", KAFKA, "start")
icon(1800, 1122, Glue, "", 42)
text(1800, 1158, "Glue Schema Registry", 10, "normal", KAFKA)

# service <-> Kafka arrows (both ways = produces and consumes)
for k, (sx, both) in {"ticket": (X["ticket"], True), "venue": (X["venue"], False), "order": (X["order"], True),
                      "expiration": (X["expiration"], True), "payment": (X["payment"], True)}.items():
    line([(sx - 12, 830), (sx - 12, 1082)], KAFKA, sw=2.2, dash="" if both else "6 4", tail=both)

# ---- egress (payment -> NAT -> Stripe / SES)
line([(X["payment"] + 26, 745), (1885, 745), (1885, 500)], EGRESS, sw=2.4, label="HTTPS out", lpos=(1868, 620))
line([(1920, 462), (2120, 462)], EGRESS, sw=2.4)
line([(1885, 660), (2120, 660)], EGRESS, sw=2.4, label="email receipt", lpos=(2010, 650))

# ---- external services
group(2075, 395, 250, 380, "Outside the VPC", "#5E7D12", "#F7FAEF")
icon(2200, 462, Stripe, "Stripe\nPaymentIntents + webhook", 56, 28)
icon(2200, 660, SES, "Amazon SES\ntransactional email", 56, 28)

text(270, 1120, "Provisioned by Terraform today:\nVPC, EKS 1.30, RDS PostgreSQL 16\n(auth, orders, payments; Multi-AZ,\ndb.r6g.large), ElastiCache Redis,\nMSK (3 brokers), Kong x3, CloudFront.\n\nOther stores (venue_db, DocumentDB,\nOpenSearch) follow the C4 design.", 12, "normal", "#8A1B78", "start")
text(275, 940, "Kong is the only workload behind the\nload balancer. JWT is verified at Kong;\nauth-service publishes the JWKS key.", 12, "normal", "#00696B", "start")

# ============================================================ GUARDRAILS
group(230, 1440, 2090, 205, "Delivery, security and observability (attached to the cluster, not in the request path)", "#C7254E", "#FFF5F7")
gx = [340, 610, 880, 1150, 1420, 1690, 1960]
for x, (cls, lab, sub) in zip(gx, [
    (ECR, "ECR", "container images\nscanned on push"),
    (IAMRole, "IAM + IRSA", "least-privilege role\nper pod"),
    (SecretsManager, "Secrets Manager", "DB creds, JWT keys,\nStripe key via External Secrets"),
    (KMS, "KMS", "envelope encryption\nRDS, MSK, EBS"),
    (Cloudwatch, "CloudWatch", "logs + RED metrics\n+ alarms"),
    (XRay, "X-Ray", "distributed traces\nfrom OTel collector"),
    (Cloudtrail, "CloudTrail", "API audit log"),
]):
    icon(x, 1520, cls, lab, 56, 26)
    text(x, 1580, sub, 11, "normal", "#5F6B7A")

# ============================================================== LEGEND
lx, ly = 250, 1722
text(lx, ly, "How to read the lines:", 14, "bold", NAVY, "start")
items = [(REST, "", "HTTP / REST / GraphQL (sync)"), (REST, "7 4", "GraphQL federation to subgraphs"),
         (GRPC, "", "gRPC between services (sync)"), (KAFKA, "", "Kafka events (async, both ways = produce + consume)"),
         (DATA, "", "service to its own datastore"), (EGRESS, "", "outbound to external SaaS")]
x = lx + 190
for c, d, lab in items:
    line([(x, ly - 5), (x + 40, ly - 5)], c, dash=d, sw=3, head=False)
    text(x + 48, ly, lab, 12, "normal", NAVY, "start")
    x += 48 + tw(lab, 12) + 40
text(lx, ly + 30, "Solid purple = event consumed and produced by the service; dashed purple = consume only.", 12, "normal", "#5F6B7A", "start")

add("</svg>")

svg_path = os.path.join(HERE, "08-aws-architecture.svg")
open(svg_path, "w").write("\n".join(out))

# svg -> png via headless chromium
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1.5)
    pg.goto("file://" + svg_path)
    pg.screenshot(path=os.path.join(HERE, "08-aws-architecture.png"))
    b.close()
print("wrote 08-aws-architecture.svg / .png")
