"""AWS infrastructure view: how the platform is laid out across three Availability Zones.
Source of truth: infra/terraform/modules (vpc, eks, rds, elasticache, msk, kong, cloudfront), environments/prod
  - VPC 10.2.0.0/16, 3 AZs, public /20 + private /20 + intra /20 per AZ, one NAT gateway per AZ (prod)
  - EKS 1.30 (managed node group m5.large 3-20 + Karpenter, IRSA), public API endpoint
  - RDS PostgreSQL 16 Multi-AZ, encrypted, 7-day backups; ElastiCache Redis 3 nodes with failover
  - MSK Kafka 3.7 KRaft, 3 brokers (kafka.m5.large, 100 GB EBS, TLS in transit)
Run: python3 01-aws-infrastructure.py"""
from awsdiagram import Canvas, NAVY, GREY, REST, DATA, EGRESS, KAFKA, PHASE_COLORS
from diagrams.aws.analytics import ManagedStreamingForKafka
from diagrams.aws.compute import ECR, EC2, EKS, Fargate
from diagrams.aws.database import ElasticacheForRedis, RDSPostgresqlInstance
from diagrams.aws.devtools import XRay
from diagrams.aws.general import Users
from diagrams.aws.management import Cloudtrail, Cloudwatch
from diagrams.aws.network import CloudFront, InternetGateway, NATGateway, NLB, Route53
from diagrams.aws.security import ACM, IAMRole, KMS, SecretsManager, Shield, WAF
from diagrams.aws.storage import S3

W, H = 2300, 1700
c = Canvas(W, H, "AWS infrastructure: three Availability Zones, no single point of failure",
           "Public subnets hold only load balancers and NAT. Workloads and data sit in private subnets. Everything below the edge is Multi-AZ.")
c.header(1150)

c.rect(190, 100, 2100, 1520, NAVY, "white", "", 1.8, 2)
c.text(212, 126, "AWS Cloud  -  us-east-1", 17, "bold", NAVY, "start")

# ---------------------------------------------------------------- edge
c.group(230, 145, 2020, 175, "Edge: TLS, DDoS and bot filtering before traffic reaches the VPC", "#B7791F", "#FFF8E7")
c.icon(95, 240, Users, "Customers", 64, 30)
c.icon(360, 232, WAF, "AWS WAF")
c.icon(440, 232, Shield, "Shield")
c.icon(1040, 232, CloudFront, "CloudFront\norigin: https-only")
c.icon(1420, 232, Route53, "Route 53")
c.icon(1700, 232, ACM, "ACM\nTLS certificates")
c.line([(140, 240), (325, 240)], NAVY, label="HTTPS", lpos=(232, 230))
c.line([(475, 240), (1005, 240)], NAVY, label="filtered traffic", lpos=(740, 230))
c.line([(1385, 240), (1075, 240)], NAVY, dash="6 4", label="DNS", lpos=(1230, 230))

# ---------------------------------------------------------------- VPC
c.group(230, 350, 1600, 1000, "VPC 10.2.0.0/16", "#8C4FFF", "#FCFAFF", "", 16, 2)
c.icon(1830, 350, InternetGateway, "", 44)
c.text(1830, 388, "Internet\nGateway", 10, "normal", NAVY)

AZ = ["us-east-1a", "us-east-1b", "us-east-1c"]
X0 = [255, 790, 1325]
AW = 490
PUB = ["10.2.64.0/20", "10.2.80.0/20", "10.2.96.0/20"]
PRV = ["10.2.0.0/20", "10.2.16.0/20", "10.2.32.0/20"]
INT = ["10.2.128.0/20", "10.2.144.0/20", "10.2.160.0/20"]
for i in range(3):
    x, cx = X0[i], X0[i] + AW / 2
    c.group(x, 395, AW, 940, AZ[i], "#146EB4", "none", "6 4", 16)
    # public subnet
    c.group(x + 14, 430, AW - 28, 150, f"Public  {PUB[i]}", "#3F8624", "#F4F9F0", "", 13)
    c.icon(cx - 20, 500, NLB, "NLB node\n(Kong proxy)", 50, 26, 11)
    c.icon(cx + 110, 500, NATGateway, "NAT gateway\n(one per AZ)", 50, 26, 11)
    # private app subnet
    c.group(x + 14, 600, AW - 28, 300, f"Private  {PRV[i]}", "#008A8C", "#EEF9F9", "", 13)
    c.icon(cx - 150, 690, EC2, "m5.large\nworker node", 46, 26, 11)
    c.icon(cx - 20, 690, Fargate, "kong-gateway\npod", 46, 26, 11)
    c.icon(cx + 90, 690, Fargate, "service\npods", 46, 26, 11)
    c.icon(cx + 185, 690, Fargate, "Karpenter\nnodes", 46, 26, 11)
    c.text(cx, 795, "Managed node group 3-20 nodes; pods spread over AZs by topology constraints", 10.5, "normal", GREY, italic=True)
    c.text(cx, 812, f"Intra subnet {INT[i]}: EKS control-plane ENIs", 10.5, "normal", GREY)
    c.icon(cx, 862, EKS, "", 32)
    # data tier
    c.group(x + 14, 920, AW - 28, 395, "Data tier (private, no public route)", "#B0209A", "#FEF4FD", "", 13)

# data icons
def dt(i, y, cls, label, size=50):
    c.icon(X0[i] + AW / 2, y, cls, label, size, 26, 11)

dt(0, 1005, RDSPostgresqlInstance, "RDS PostgreSQL 16\nprimary (x3 instances)")
dt(1, 1005, RDSPostgresqlInstance, "RDS standby\nsynchronous replica")
c.text(X0[2] + AW / 2, 1005, "", 11)
c.line([(X0[0] + AW / 2 + 70, 1005), (X0[1] + AW / 2 - 70, 1005)], DATA, dash="6 4", tail=True, sw=2,
       label="Multi-AZ sync", lpos=((X0[0] + X0[1] + AW) / 2, 992))
dt(0, 1130, ElasticacheForRedis, "Redis primary")
dt(1, 1130, ElasticacheForRedis, "Redis replica")
dt(2, 1130, ElasticacheForRedis, "Redis replica")
c.line([(X0[0] + AW / 2 + 60, 1130), (X0[1] + AW / 2 - 60, 1130)], DATA, dash="6 4", tail=False, sw=2)
c.line([(X0[1] + AW / 2 + 60, 1130), (X0[2] + AW / 2 - 60, 1130)], DATA, dash="6 4", tail=False, sw=2,
       label="async replication + auto failover", lpos=((X0[1] + X0[2] + AW) / 2 - 150, 1117))
dt(0, 1250, ManagedStreamingForKafka, "MSK broker 1")
dt(1, 1250, ManagedStreamingForKafka, "MSK broker 2")
dt(2, 1250, ManagedStreamingForKafka, "MSK broker 3")
c.line([(X0[0] + AW / 2 + 60, 1250), (X0[1] + AW / 2 - 60, 1250)], KAFKA, tail=True, sw=2.2)
c.line([(X0[1] + AW / 2 + 60, 1250), (X0[2] + AW / 2 - 60, 1250)], KAFKA, tail=True, sw=2.2,
       label="partition replicas (KRaft)", lpos=((X0[1] + X0[2] + AW) / 2 - 150, 1237), lcolor=KAFKA)

# traffic from CloudFront to each NLB node
by = 340
c.line([(1040, 290), (1040, by)], REST, head=False)
c.line([(X0[0] + AW / 2 - 20, by), (X0[2] + AW / 2 - 20, by)], REST, head=False)
for i in range(3):
    c.line([(X0[i] + AW / 2 - 20, by), (X0[i] + AW / 2 - 20, 470)], REST)
c.text(1040 + 8, by - 8, "", 10)
c.badge(1016, 318, 1, 11)
# NLB -> kong pod in the same AZ
for i in range(3):
    cx = X0[i] + AW / 2
    c.line([(cx - 20, 556), (cx - 20, 662)], REST, sw=2)
c.callout(1850, 1200, 400, "Outbound only", "Private pods reach the Internet through the NAT gateway in their own AZ "
          "(Stripe API, SES, package registries). Nothing on the Internet can open a connection into a private subnet.",
          "#ED7100", "#FFF5EA", 11.5)

# ---------------------------------------------------------------- right column: AWS-managed and shared services
c.group(1850, 350, 400, 830, "AWS-managed and shared services", "#C7254E", "#FFF5F7")
items = [(EKS, "EKS control plane\nKubernetes 1.30, AWS-managed"), (ECR, "ECR\nimages, scan on push"),
         (IAMRole, "IAM + IRSA\nOIDC role per service account"), (SecretsManager, "Secrets Manager\nvia External Secrets"),
         (KMS, "KMS\nRDS, MSK, EBS, Redis"), (Cloudwatch, "CloudWatch\nlogs, RED metrics, alarms"),
         (XRay, "X-Ray\nOTel traces"), (Cloudtrail, "CloudTrail\nAPI audit log"), (S3, "S3\nTerraform state, backups")]
for k, (cls, lab) in enumerate(items):
    r, col = divmod(k, 2)
    if k == 8:
        col = 0
    c.icon(1935 + col * 190, 430 + r * 145, cls, lab, 50, 26, 11)

# ---------------------------------------------------------------- footer
c.callout(230, 1385, 1600, "Production takeaway",
          "Loss of one AZ removes one NLB node, one NAT gateway, one third of the workers, and one RDS or Redis node, and the rest carries on: "
          "RDS fails over to its synchronous standby, Redis promotes a replica, Kafka elects new partition leaders, and EKS reschedules pods. "
          "Cost note: this is why prod runs one NAT gateway per AZ; dev uses a single NAT to save about $36 per month per removed gateway.",
          "#232F3E", "#F3F5F8", 12.5)
c.legend(230, 1555, ["rest", "data", "kafka"])
c.save("01-aws-infrastructure")
