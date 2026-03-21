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
