# infra/terraform/modules/eks/main.tf
# EKS module — managed node group with Karpenter, IRSA, and all required add-ons.

locals {
  name            = "${var.project}-${var.environment}"
  cluster_version = var.eks_cluster_version
}

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.8"

  cluster_name    = local.name
  cluster_version = local.cluster_version

  cluster_endpoint_public_access = true

  vpc_id                   = var.vpc_id
  subnet_ids               = var.private_subnet_ids
  control_plane_subnet_ids = var.intra_subnet_ids

  # EKS Managed Add-ons
  cluster_addons = {
    coredns            = { most_recent = true }
    kube-proxy         = { most_recent = true }
    vpc-cni            = { most_recent = true }
    aws-ebs-csi-driver = { most_recent = true }
  }

  # Managed node group — general workloads
  eks_managed_node_groups = {
    general = {
      name           = "${local.name}-general"
      instance_types = var.node_instance_types
      min_size       = var.node_min_size
      max_size       = var.node_max_size
      desired_size   = var.node_desired_size

      labels = {
        workload = "general"
      }

      tags = {
        "karpenter.sh/discovery" = local.name
      }
    }
  }

  # Enable EKS control-plane logging (AGENTS.md §11.5)
  cluster_enabled_log_types = [
    "api", "audit", "authenticator", "controllerManager", "scheduler"
  ]

  # IAM Roles for Service Accounts (IRSA) — enabled by default in this module
  enable_irsa = true

  tags = {
    "karpenter.sh/discovery" = local.name
  }
}
