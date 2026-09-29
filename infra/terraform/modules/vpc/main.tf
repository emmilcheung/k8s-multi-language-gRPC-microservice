# infra/terraform/modules/vpc/main.tf
# VPC module — creates a production-ready VPC with public and private subnets
# across 3 AZs, NAT Gateways, and the required tags for EKS and AWS LB Controller.

locals {
  name = "${var.project}-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 3)
}

data "aws_availability_zones" "available" {
  state = "available"
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.8"

  name = local.name
  cidr = var.vpc_cidr

  azs             = local.azs
  private_subnets = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets  = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 4, i + 4)]
  intra_subnets   = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  enable_nat_gateway     = true
  single_nat_gateway     = var.environment == "dev" ? true : false
  one_nat_gateway_per_az = var.environment != "dev" ? true : false

  enable_dns_hostnames = true
  enable_dns_support   = true

  # Tags required for EKS and AWS Load Balancer Controller
  public_subnet_tags = {
    "kubernetes.io/role/elb" = 1
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = 1

    # E2 / SR-09. Karpenter's EC2NodeClass finds the subnets it may launch into
    # by this tag. Without it Karpenter discovers nothing and provisions
    # nothing, which looks exactly like "the cluster is full" — pods sit
    # Pending with no error anywhere.
    #
    # The value must equal the EKS cluster name. Both modules build it the same
    # way from the same inputs (see local.name in modules/eks/main.tf); if that
    # formula ever changes in one place it has to change in the other.
    "karpenter.sh/discovery" = local.name
  }

  tags = {
    "kubernetes.io/cluster/${local.name}" = "shared"
  }
}
