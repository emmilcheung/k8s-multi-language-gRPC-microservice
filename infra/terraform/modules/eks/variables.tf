# infra/terraform/modules/eks/variables.tf

variable "project" { type = string }
variable "environment" { type = string }

variable "vpc_id" {
  description = "VPC in which the cluster is deployed."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for EKS nodes."
  type        = list(string)
}

variable "intra_subnet_ids" {
  description = "Intra subnets for EKS control-plane ENIs."
  type        = list(string)
}

variable "eks_cluster_version" {
  type    = string
  default = "1.30"
}

variable "node_instance_types" {
  type    = list(string)
  default = ["t3.medium"]
}

variable "node_min_size" {
  type    = number
  default = 2
}

variable "node_max_size" {
  type    = number
  default = 10
}

variable "node_desired_size" {
  type    = number
  default = 3
}

# Karpenter ────────────────────────────────────────────────────

variable "karpenter_version" {
  description = <<-EOT
    Karpenter chart version. Pinned, never "latest", and a
    controller that silently upgrades itself is a controller that can start
    terminating nodes differently after an unrelated apply. Check the version
    against the cluster version in Karpenter's compatibility matrix before
    bumping it: https://karpenter.sh/docs/upgrading/compatibility/
  EOT
  type        = string
  default     = "1.0.8"
}

variable "karpenter_capacity_types" {
  description = <<-EOT
    Purchase options Karpenter may use. On-demand only by default: spot
    reclaims give two minutes' notice, and while venue-service now drains its
    SSE streams gracefully the rest of the platform has not been tested
    against involuntary node loss. Adding "spot" is a cost decision that wants
    a soak behind it, not a default.
  EOT
  type        = list(string)
  default     = ["on-demand"]
}

variable "karpenter_instance_categories" {
  description = "EC2 instance categories Karpenter may choose from."
  type        = list(string)
  default     = ["c", "m", "r"]
}

variable "karpenter_cpu_limit" {
  description = <<-EOT
    Ceiling on total vCPU across all Karpenter-managed nodes. This is the
    blast-radius limit: a runaway HPA, a scheduling loop or a pod that cannot
    fit anywhere will otherwise keep asking for nodes and Karpenter will keep
    buying them.
  EOT
  type        = number
  default     = 200
}

variable "karpenter_consolidate_after" {
  description = <<-EOT
    How long a node must sit empty or underutilised before Karpenter removes
    it. Long enough that a scale-in followed by a scale-out does not churn
    nodes; the HPA's own scale-down stabilization is measured in minutes too.
  EOT
  type        = string
  default     = "2m"
}

variable "karpenter_node_expiry" {
  description = <<-EOT
    Maximum node lifetime. Nodes are replaced on this schedule so AMI patches
    actually land; without it a Karpenter node can run its original image
    indefinitely.
  EOT
  type        = string
  default     = "720h"
}

variable "karpenter_volume_size_gi" {
  description = "Root EBS volume size, in GiB, for Karpenter-launched nodes."
  type        = number
  default     = 50
}
