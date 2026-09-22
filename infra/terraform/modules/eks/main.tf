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

    # E1 / SR-09. Every workload chart ships an HPA, and without metrics-server
    # none of them has a metrics source: the HPA reports <unknown>/70% and never
    # scales. This is not an enhancement — it is the component that makes the
    # autoscaling already configured in this repo do anything at all. EKS ships
    # it as a managed addon, so it needs no IRSA role and no Helm release.
    metrics-server = { most_recent = true }
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

# ── E2 / SR-09 · Karpenter ────────────────────────────────────────────────────
#
# The cluster was already tagged for Karpenter and Karpenter was never
# installed, so the only thing that could add capacity was the managed node
# group's own desired_size, which nothing changes automatically. An HPA that
# wants more pods than the nodes can hold just leaves them Pending.
#
# This is a hard prerequisite for E3. The charts now spread across zones with
# whenUnsatisfiable: DoNotSchedule, which means a pod that has no room in its
# zone does not fall back to another one — it waits for a node. Without a node
# autoscaler that wait never ends.
#
# The managed node group stays. It runs the things that must exist before
# Karpenter can do anything, Karpenter itself among them; a cluster whose only
# capacity is provisioned by a controller running on that capacity cannot start.

module "karpenter" {
  source  = "terraform-aws-modules/eks/aws//modules/karpenter"
  version = "~> 20.8"

  cluster_name = module.eks.cluster_name

  # Karpenter v1 permissions and EKS Pod Identity rather than IRSA. Pod Identity
  # needs no OIDC trust policy and no service-account annotation, so there is
  # one less thing to keep in sync between Terraform and the Helm values.
  enable_v1_permissions           = true
  enable_pod_identity             = true
  create_pod_identity_association = true

  # Nodes Karpenter launches need the same managed policies as the node group's
  # nodes, plus SSM so they can be reached without a bastion.
  node_iam_role_additional_policies = {
    AmazonSSMManagedInstanceCore = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
  }

  tags = {
    "karpenter.sh/discovery" = local.name
  }
}

# Note for upgrades: the chart ships its CRDs under crds/, and Helm installs
# those on first install but never on upgrade. Bumping karpenter_version across
# an API change therefore needs the CRDs applied out of band first — the apply
# will otherwise succeed against the old CRDs and the NodePool below will be
# silently rejected. https://karpenter.sh/docs/upgrading/upgrade-guide/
resource "helm_release" "karpenter" {
  name             = "karpenter"
  namespace        = "kube-system"
  repository       = "oci://public.ecr.aws/karpenter"
  chart            = "karpenter"
  version          = var.karpenter_version
  create_namespace = false
  wait             = true

  values = [
    yamlencode({
      settings = {
        clusterName     = module.eks.cluster_name
        clusterEndpoint = module.eks.cluster_endpoint
        # The queue the EKS module's Karpenter submodule created. Spot
        # reclaims and scheduled maintenance arrive here; without it Karpenter
        # only learns a node is going away when it goes away.
        interruptionQueue = module.karpenter.queue_name
      }
      # Karpenter must not run on nodes Karpenter manages — it would be
      # evicting itself. The managed node group is where it lives.
      nodeSelector = {
        workload = "general"
      }
      replicas = 2
      controller = {
        resources = {
          requests = { cpu = "500m", memory = "512Mi" }
          limits   = { memory = "512Mi" }
        }
      }
    })
  ]

  depends_on = [module.eks]
}

# NodePool and EC2NodeClass are Kubernetes custom resources, so they cannot be
# applied until Karpenter's CRDs exist. They ship as a tiny local chart rather
# than kubernetes_manifest resources because kubernetes_manifest reads the CRD
# schema during plan, which fails on a cluster that does not have the CRDs yet
# — the exact situation on a first apply.
resource "helm_release" "karpenter_nodepool" {
  name      = "karpenter-nodepool"
  namespace = "kube-system"
  chart     = "${path.module}/karpenter-nodepool"

  values = [
    yamlencode({
      clusterName        = module.eks.cluster_name
      nodeIamRole        = module.karpenter.node_iam_role_name
      capacityTypes      = var.karpenter_capacity_types
      instanceCategories = var.karpenter_instance_categories
      cpuLimit           = var.karpenter_cpu_limit
      consolidateAfter   = var.karpenter_consolidate_after
      nodeExpiry         = var.karpenter_node_expiry
      volumeSizeGi       = var.karpenter_volume_size_gi
    })
  ]

  depends_on = [helm_release.karpenter]
}
