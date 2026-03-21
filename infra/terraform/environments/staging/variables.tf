# infra/terraform/environments/staging/variables.tf

variable "aws_region" {
  description = "AWS region for all staging resources."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Project name used as a prefix for all resource names."
  type        = string
  default     = "ticketing"
}
