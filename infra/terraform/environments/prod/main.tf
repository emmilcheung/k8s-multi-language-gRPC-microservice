# infra/terraform/environments/prod/main.tf
# Production environment — high-availability, multi-AZ, hardened settings.
#
# Usage:
#   cd infra/terraform/environments/prod
#   terraform init -backend-config=backend.hcl
#   terraform plan
#   terraform apply    # requires explicit owner approval — see AGENTS.md §15
#
# Production apply requires manual gate in CI pipeline and a second approver.

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.30"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.13"
    }
  }

  backend "s3" {
    # Provided via backend.hcl (gitignored — never commit account IDs or bucket names)
    # Example backend.hcl:
    #   bucket         = "ticketing-tf-state-<account-id>"
    #   key            = "prod/terraform.tfstate"
    #   region         = "us-east-1"
    #   dynamodb_table = "ticketing-tf-lock"
    #   encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "ticketing"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.aws_region]
  }
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    exec {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", module.eks.cluster_name, "--region", var.aws_region]
    }
  }
}

module "vpc" {
  source      = "../../modules/vpc"
  project     = var.project
  environment = "prod"
  vpc_cidr    = "10.2.0.0/16"
}

module "eks" {
  source      = "../../modules/eks"
  project     = var.project
  environment = "prod"

  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  intra_subnet_ids   = module.vpc.intra_subnet_ids

  # Production: larger instances, wider auto-scaling range.
  eks_cluster_version = "1.30"
  node_instance_types = ["m5.large"]
  node_min_size       = 3
  node_max_size       = 20
  node_desired_size   = 6
}

module "rds" {
  source      = "../../modules/rds"
  project     = var.project
  environment = "prod"

  vpc_id     = module.vpc.vpc_id
  vpc_cidr   = "10.2.0.0/16"
  subnet_ids = module.vpc.private_subnet_ids

  # Production: multi-AZ, deletion protection enabled (set in rds module when environment == "prod").
  instance_class = "db.r6g.large"
}

module "elasticache" {
  source      = "../../modules/elasticache"
  project     = var.project
  environment = "prod"

  vpc_id     = module.vpc.vpc_id
  vpc_cidr   = "10.2.0.0/16"
  subnet_ids = module.vpc.private_subnet_ids

  # Production: larger nodes + 3-node replication group with automatic failover.
  node_type = "cache.r6g.large"
}

module "msk" {
  source      = "../../modules/msk"
  project     = var.project
  environment = "prod"

  vpc_id     = module.vpc.vpc_id
  vpc_cidr   = "10.2.0.0/16"
  subnet_ids = module.vpc.private_subnet_ids

  # Production: production-grade Kafka instances, 3 brokers across 3 AZs.
  instance_type = "kafka.m5.large"
  broker_count  = 3
}

module "kong" {
  source      = "../../modules/kong"
  project     = var.project
  environment = "prod"

  # Production: 3 replicas, admin API disabled, full resource allocation.
  replica_count         = 3
  admin_service_enabled = false
  cpu_request           = "500m"
  memory_request        = "512Mi"
  cpu_limit             = "1000m"
  memory_limit          = "1Gi"

  kong_config_map_name = "kong-dbless-config"

  depends_on = [module.eks]
}
