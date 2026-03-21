# infra/terraform/environments/dev/variables.tf

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "ticketing"
}
