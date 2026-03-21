# infra/terraform/environments/dev/main.tf
# Dev environment — wires all modules together with dev-appropriate settings.
#
# Usage:
#   cd infra/terraform/environments/dev
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
    #   key            = "dev/terraform.tfstate"
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
      Environment = "dev"
      ManagedBy   = "terraform"
    }
  }
}

# Kubernetes and Helm providers are configured after the EKS cluster exists.
# On first apply (EKS not yet created), target only the vpc + eks modules:
#   terraform apply -target=module.vpc -target=module.eks
# Then run a full apply to deploy Kong and remaining modules.
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
  environment = "dev"
  vpc_cidr    = "10.0.0.0/16"
}

module "eks" {
  source      = "../../modules/eks"
  project     = var.project
  environment = "dev"

  vpc_id             = module.vpc.vpc_id
  private_subnet_ids = module.vpc.private_subnet_ids
  intra_subnet_ids   = module.vpc.intra_subnet_ids

  eks_cluster_version = "1.30"
  node_instance_types = ["t3.medium"]
  node_min_size       = 2
  node_max_size       = 6
  node_desired_size   = 2
}

module "rds" {
  source      = "../../modules/rds"
  project     = var.project
  environment = "dev"

  vpc_id     = module.vpc.vpc_id
  vpc_cidr   = "10.0.0.0/16"
  subnet_ids = module.vpc.private_subnet_ids

  instance_class = "db.t3.micro"
}

module "elasticache" {
  source      = "../../modules/elasticache"
  project     = var.project
  environment = "dev"

  vpc_id     = module.vpc.vpc_id
  vpc_cidr   = "10.0.0.0/16"
  subnet_ids = module.vpc.private_subnet_ids

  node_type = "cache.t3.micro"
}

module "msk" {
  source      = "../../modules/msk"
  project     = var.project
  environment = "dev"

  vpc_id     = module.vpc.vpc_id
  vpc_cidr   = "10.0.0.0/16"
  subnet_ids = module.vpc.private_subnet_ids

  instance_type = "kafka.t3.small"
  broker_count  = 3
}

module "kong" {
  source      = "../../modules/kong"
  project     = var.project
  environment = "dev"

  # Dev: single replica, admin API exposed (ClusterIP — not externally routable),
  # smaller resource footprint.
  replica_count         = 1
  admin_service_enabled = true
  cpu_request           = "100m"
  memory_request        = "128Mi"
  cpu_limit             = "250m"
  memory_limit          = "256Mi"

  # The kong-dbless-config ConfigMap is created by the umbrella Helm chart
  # (infra/helm) before this module runs. Adjust the name here if it differs.
  kong_config_map_name = "kong-dbless-config"

  depends_on = [module.eks]
}
