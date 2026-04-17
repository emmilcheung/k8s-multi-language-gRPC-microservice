"""AWS infrastructure diagram for the ticketing microservices platform.

Renders to SVG + PNG using python-graphviz. Uses the official AWS colour palette
and service glyphs so the output is recognisable without bundled icon assets.

Run:
    python3 01-aws-infrastructure.py
Outputs:
    01-aws-infrastructure.svg
    01-aws-infrastructure.png
"""

from graphviz import Digraph

# AWS brand palette
AWS_ORANGE = "#FF9900"
AWS_NAVY = "#232F3E"
AWS_BLUE = "#1A73E8"
AWS_GREEN = "#7AA116"
AWS_RED = "#DD3522"
AWS_PURPLE = "#7D3C98"
SUBNET_BG = "#EAF2FB"
VPC_BG = "#F7F8FA"
REGION_BG = "#FFFFFF"


def _to_html_label(label: str) -> str:
    """If label is already HTML (wrapped in <...>), return as-is; else escape newlines."""
    if label.startswith("<") and label.endswith(">"):
        return label
    return label.replace("\n", "\\n")


def node(g, name, label, fillcolor, shape="box", fontcolor="#FFFFFF"):
    # For HTML-labels, replace any literal newlines introduced by Python string
    # literals with <br/>, since HTML-label parsers don't honour \n.
    if label.startswith("<") and label.endswith(">"):
        label = label.replace("\n", "<br/>")
    g.node(
        name,
        label=label,
        style="filled,rounded",
        shape=shape,
        fillcolor=fillcolor,
        fontcolor=fontcolor,
        fontname="Helvetica",
        fontsize="11",
        penwidth="1.5",
        color=AWS_NAVY,
    )


def svc_node(g, name, aws_label, descr):
    """Node styled as an AWS service tile."""
    label = f"<<b>{aws_label}</b><br/><font point-size='9'>{descr}</font>>"
    node(g, name, label, AWS_NAVY, fontcolor="#FFFFFF")


def pod_node(g, name, svc_label, tech):
    label = f"<<b>{svc_label}</b><br/><font point-size='9'>{tech}</font>>"
    node(g, name, label, AWS_ORANGE, fontcolor=AWS_NAVY)


def db_node(g, name, aws_label, descr):
    label = f"<<b>{aws_label}</b><br/><font point-size='9'>{descr}</font>>"
    node(g, name, label, AWS_BLUE, fontcolor="#FFFFFF")


def mq_node(g, name, aws_label, descr):
    label = f"<<b>{aws_label}</b><br/><font point-size='9'>{descr}</font>>"
    node(g, name, label, AWS_PURPLE, fontcolor="#FFFFFF")


def ext_node(g, name, label):
    node(g, name, label, AWS_GREEN, shape="ellipse", fontcolor="#FFFFFF")


def build() -> Digraph:
    g = Digraph("aws_infra", format="svg")
    g.attr(
        rankdir="TB",
        compound="true",
        splines="polyline",
        fontname="Helvetica",
        labelloc="t",
        label=(
            "<<b>Ticketing Platform &#8211; AWS Production Reference Architecture</b>"
            "<br/><font point-size='10'>Multi-AZ EKS on VPC &#8226; MSK Kafka &#8226; RDS Multi-AZ &#8226; "
            "ElastiCache &#8226; Kong at edge &#8226; CloudWatch/X-Ray/CloudTrail observability</font>>"
        ),
        bgcolor="#FFFFFF",
        nodesep="0.30",
        ranksep="0.55",
        newrank="true",
        size="14,22!",
        ratio="compress",
    )
    g.attr("node", margin="0.16,0.08")
    g.attr("edge", color=AWS_NAVY, fontname="Helvetica", fontsize="9", fontcolor=AWS_NAVY)

    # --- External actors -----------------------------------------------------
    with g.subgraph(name="cluster_users") as c:
        c.attr(label="Internet", style="dashed", color=AWS_NAVY, fontname="Helvetica")
        ext_node(c, "user", "End Users\n(browser, mobile)")
        ext_node(c, "stripe", "Stripe\n(external PSP)")

    # --- Edge / DNS / WAF ----------------------------------------------------
    with g.subgraph(name="cluster_edge") as c:
        c.attr(label="AWS Global Edge", style="rounded,filled",
               fillcolor="#FDF6E3", color=AWS_NAVY, fontname="Helvetica")
        svc_node(c, "route53", "Route 53",
                 "DNS, health-checked\nfailover routing")
        svc_node(c, "cloudfront", "CloudFront",
                 "Static assets CDN\nfor Next.js build")
        svc_node(c, "waf", "AWS WAF",
                 "OWASP Top-10\nrate limits, bot block")
        svc_node(c, "acm", "ACM",
                 "TLS certs for\nALB + CloudFront")

    # --- Region / VPC --------------------------------------------------------
    with g.subgraph(name="cluster_region") as region:
        region.attr(label="Region: ap-east-1", style="rounded,filled",
                    fillcolor=REGION_BG, color=AWS_NAVY, fontname="Helvetica")

        with region.subgraph(name="cluster_vpc") as vpc:
            vpc.attr(label="VPC  10.0.0.0/16  (3 AZs, NAT per AZ in prod)",
                     style="rounded,filled", fillcolor=VPC_BG, color=AWS_NAVY,
                     fontname="Helvetica")

            # ---- Public subnets ---------------------------------------------
            with vpc.subgraph(name="cluster_public") as pub:
                pub.attr(label="Public Subnets (ELB/NAT)", style="rounded,filled",
                         fillcolor=SUBNET_BG, color=AWS_NAVY, fontname="Helvetica")
                svc_node(pub, "alb", "Application Load Balancer",
                         "AWS LB Controller\nIngress → Kong")
                svc_node(pub, "nat", "NAT Gateway",
                         "egress for private subnets")
                svc_node(pub, "igw", "Internet Gateway", "ingress")

            # ---- Private/app subnets – EKS ----------------------------------
            with vpc.subgraph(name="cluster_private") as priv:
                priv.attr(label="Private Subnets — EKS Worker Nodes (Karpenter + Managed Groups)",
                          style="rounded,filled", fillcolor=SUBNET_BG,
                          color=AWS_NAVY, fontname="Helvetica")

                svc_node(priv, "eks", "Amazon EKS",
                         "Kubernetes 1.30 control plane\nnamespace: ticketing")

                with priv.subgraph(name="cluster_kong_ns") as k:
                    k.attr(label="kong namespace", style="rounded,dashed",
                           color=AWS_NAVY, fontname="Helvetica")
                    pod_node(k, "kong", "kong-gateway",
                             "Edge gateway • JWT auth\nrate-limit • CORS • CSRF")

                with priv.subgraph(name="cluster_ns") as ns:
                    ns.attr(label="ticketing namespace (9 services)",
                            style="rounded,dashed", color=AWS_NAVY,
                            fontname="Helvetica")

                    pod_node(ns, "client", "client",
                             "Next.js 15 (SSR) • TS")
                    pod_node(ns, "auth", "auth-service",
                             "NestJS 10 • Node 24")
                    pod_node(ns, "user", "user-service",
                             "NestJS 10 • Node 24")
                    pod_node(ns, "ticket", "ticket-service",
                             "Go 1.23 • Echo v4 • gRPC")
                    pod_node(ns, "venue", "venue-service",
                             "Go 1.23 • Echo v4 • gRPC")
                    pod_node(ns, "order", "order-service",
                             "Java 21 • Spring Boot 4")
                    pod_node(ns, "payment", "payment-service",
                             "NestJS 10 • Node 24")
                    pod_node(ns, "expiration", "expiration-service",
                             "Go 1.23 • Redis timers")

            # ---- Data subnets -----------------------------------------------
            with vpc.subgraph(name="cluster_data") as data:
                data.attr(label="Data Subnets (Multi-AZ, no public egress)",
                          style="rounded,filled", fillcolor=SUBNET_BG,
                          color=AWS_NAVY, fontname="Helvetica")

                db_node(data, "rds_auth", "RDS PostgreSQL",
                        "auth_db • Multi-AZ\nusers, sessions")
                db_node(data, "rds_user", "RDS PostgreSQL",
                        "user_db • profiles,\npreferences, billing")
                db_node(data, "rds_order", "RDS PostgreSQL",
                        "order_db • orders,\noutbox (Spring)")
                db_node(data, "rds_payment", "RDS PostgreSQL",
                        "payment_db • charges,\nledger, webhooks")
                db_node(data, "docdb", "DocumentDB",
                        "Mongo-compatible\ntickets, venues, seats")
                db_node(data, "elasticache", "ElastiCache Redis",
                        "cluster mode • Multi-AZ\ntimers, cache, idempotency")
                mq_node(data, "msk", "Amazon MSK",
                        "3-broker Kafka\nCloudEvents envelopes")
                mq_node(data, "glue_sr", "Glue Schema Registry",
                        "Avro/JSON Schema\nfor MSK topics")

        # ---- Security / Ops sidecar -----------------------------------------
        with region.subgraph(name="cluster_ops") as ops:
            ops.attr(label="Security & Observability", style="rounded,filled",
                     fillcolor="#FDEEEE", color=AWS_RED, fontname="Helvetica")
            svc_node(ops, "iam", "IAM + IRSA",
                     "per-pod roles\nleast privilege")
            svc_node(ops, "sm", "Secrets Manager",
                     "DB creds, JWT signing,\nStripe API keys")
            svc_node(ops, "kms", "KMS",
                     "envelope encryption\nfor RDS/S3/MSK")
            svc_node(ops, "ecr", "ECR",
                     "container registry\nimage scanning")
            svc_node(ops, "cw", "CloudWatch",
                     "logs + RED metrics\n+ alarms")
            svc_node(ops, "xray", "X-Ray",
                     "distributed traces\nOTel collector")
            svc_node(ops, "ct", "CloudTrail",
                     "API audit log")
            svc_node(ops, "backup", "AWS Backup + S3",
                     "RDS/DocDB snapshots,\nlong-term archive")

    # -------- Edges ----------------------------------------------------------
    # Ingress path
    g.edge("user", "route53", label="HTTPS")
    g.edge("route53", "cloudfront", label="static")
    g.edge("route53", "waf", label="api")
    g.edge("waf", "alb")
    g.edge("cloudfront", "alb", style="dashed", label="origin")
    g.edge("alb", "kong", label="Ingress")
    g.edge("acm", "alb", style="dotted", arrowhead="none", label="TLS")

    # Kong routes into the mesh
    g.edge("kong", "client", label="SSR")
    g.edge("kong", "auth")
    g.edge("kong", "user")
    g.edge("kong", "ticket", label="REST")
    g.edge("kong", "venue", label="REST")
    g.edge("kong", "order")
    g.edge("kong", "payment")

    # Internal gRPC
    g.edge("order", "ticket", label="gRPC ReserveQuota", color=AWS_GREEN)
    g.edge("order", "venue", label="gRPC ReserveSeats", color=AWS_GREEN)

    # Outbound to Stripe
    g.edge("payment", "nat", style="dashed")
    g.edge("nat", "stripe", label="HTTPS out")
    g.edge("stripe", "kong", style="dashed", label="webhook")

    # Databases ownership (bold lines)
    g.edge("auth", "rds_auth")
    g.edge("user", "rds_user")
    g.edge("order", "rds_order")
    g.edge("payment", "rds_payment")
    g.edge("ticket", "docdb")
    g.edge("venue", "docdb")
    g.edge("expiration", "elasticache", label="timers")
    g.edge("ticket", "elasticache", style="dashed", label="cache")
    g.edge("order", "elasticache", style="dashed", label="idempotency")

    # Kafka (MSK) — every service produces/consumes
    for s in ("order", "payment", "ticket", "venue", "expiration"):
        g.edge(s, "msk", color=AWS_PURPLE, label="events")
    g.edge("msk", "glue_sr", style="dotted", label="schemas")

    # Security / ops wiring — consolidated (one representative arrow from the
    # EKS cluster, not one-per-service, to keep the picture readable).
    g.edge("eks", "cw", style="dotted", color="#888888",
           label="structured logs + RED metrics")
    g.edge("eks", "xray", style="dotted", color="#888888",
           label="OTel traces")
    g.edge("sm", "eks", style="dotted", color=AWS_RED, label="External Secrets")
    g.edge("iam", "eks", style="dotted", color=AWS_RED, label="IRSA")
    g.edge("ecr", "eks", style="dotted", color="#888888", label="images")
    g.edge("rds_order", "backup", style="dotted", color="#888888",
           label="snapshots")
    g.edge("docdb", "backup", style="dotted", color="#888888")
    g.edge("kms", "rds_order", style="dotted", color=AWS_RED, label="encrypt")
    g.edge("ct", "cw", style="dotted", color="#888888")

    return g


if __name__ == "__main__":
    import os

    g = build()
    g.render("01-aws-infrastructure", format="svg", cleanup=False)
    g.render("01-aws-infrastructure", format="png", cleanup=False)
    # Graphviz Python keeps the intermediate source as a bare filename; rename
    # to `.gv` for clarity and drop duplicates if they exist.
    bare = "01-aws-infrastructure"
    if os.path.exists(bare):
        try:
            os.replace(bare, bare + ".gv")
        except OSError:
            os.remove(bare)
    print("Rendered 01-aws-infrastructure.{svg,png,gv}")
