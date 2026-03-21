# infra/terraform/main.tf
# Root Terraform configuration — environment-agnostic module wiring.
# This file is NOT intended to be applied directly. Use an environment
# workspace under environments/{dev,staging,prod}/main.tf instead.
#
# To apply an environment:
#   cd infra/terraform/environments/dev
#   terraform init
#   terraform plan
#   terraform apply          # requires explicit owner approval (see AGENTS.md §15)

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

  # Remote state — bucket and table are bootstrapped manually once per account.
  # See infra/scripts/bootstrap-state.sh
  backend "s3" {
    # Values are provided via -backend-config flags or backend.hcl per environment.
    # Never hardcode bucket names, regions, or account IDs here.
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "ticketing"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
