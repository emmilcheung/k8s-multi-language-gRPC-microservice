# infra/terraform/environments/staging/main.tf
# Staging environment — production-like config at reduced scale.
# Validates the full infrastructure stack before changes reach prod.
#
# Usage:
#   cd infra/terraform/environments/staging
#   terraform init -backend-config=backend.hcl
#   terraform plan
#   terraform apply    # requires explicit owner approval — see AGENTS.md §15

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
    #   key            = "staging/terraform.tfstate"
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
      Environment = "staging"
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
  environment = "staging"
  vpc_cidr    = "10.1.0.0/16"
}

module "eks" {
  source      = "../../modules/eks"
  project     = var.project
  environment = "staging"

  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  intra_subnet_ids   = module.vpc.intra_subnet_ids

  eks_cluster_version = "1.30"
  node_instance_types = ["t3.large"]
  node_min_size       = 2
  node_max_size       = 8
  node_desired_size   = 3
}

module "rds" {
  source      = "../../modules/rds"
  project     = var.project
  environment = "staging"

  vpc_id     = module.vpc.vpc_id
  vpc_cidr   = "10.1.0.0/16"
  subnet_ids = module.vpc.private_subnet_ids

  instance_class = "db.t3.small"
}

module "elasticache" {
  source      = "../../modules/elasticache"
  project     = var.project
  environment = "staging"

  vpc_id     = module.vpc.vpc_id
  vpc_cidr   = "10.1.0.0/16"
  subnet_ids = module.vpc.private_subnet_ids

  node_type = "cache.t3.small"
}

module "msk" {
  source      = "../../modules/msk"
  project     = var.project
  environment = "staging"

  vpc_id     = module.vpc.vpc_id
  vpc_cidr   = "10.1.0.0/16"
  subnet_ids = module.vpc.private_subnet_ids

  instance_type = "kafka.m5.large"
  broker_count  = 3
}

module "kong" {
  source      = "../../modules/kong"
  project     = var.project
  environment = "staging"

  # Staging: 2 replicas, admin API disabled, production-like resource sizing.
  replica_count         = 2
  admin_service_enabled = false
  cpu_request           = "250m"
  memory_request        = "256Mi"
  cpu_limit             = "500m"
  memory_limit          = "512Mi"

  kong_config_map_name = "kong-dbless-config"

  tls_enabled         = var.kong_tls_enabled
  tls_certificate_arn = var.kong_tls_certificate_arn
  tls_domain_name     = var.kong_tls_domain_name
  tls_hosted_zone_id  = var.kong_tls_hosted_zone_id

  depends_on = [module.eks]
}
